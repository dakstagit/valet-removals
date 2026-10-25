import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculate,DEFAULTS} from './logic.js';

const app=express();app.disable('x-powered-by');
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'2mb'}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='require'?{rejectUnauthorized:true}:undefined});
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
// One Make scenario can route event_type to Barry or the customer.
// Notification failures are logged, never allowed to undo a committed acceptance or booking.
const ensureOutbox=()=>pool.query(`CREATE TABLE IF NOT EXISTS delivery_outbox (
 id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, channel TEXT NOT NULL,
 payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 locked_until TIMESTAMPTZ, delivered_at TIMESTAMPTZ, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
async function enqueueDelivery(client,key,channel,payload){
 await client.query("INSERT INTO delivery_outbox(event_key,channel,payload) VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING",[key,channel,JSON.stringify({...payload,event_id:key})]);
}
let delivering=false;
async function processDeliveries(){
 if(delivering)return;delivering=true;
 try{
  await ensureOutbox();
  for(let n=0;n<10;n++){
   const {rows}=await pool.query(`UPDATE delivery_outbox SET status='processing',locked_until=now()+interval '90 seconds',attempts=attempts+1
    WHERE id=(SELECT id FROM delivery_outbox WHERE (status='pending' AND next_attempt_at<=now()) OR (status='processing' AND locked_until<now())
    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
   const item=rows[0];if(!item)break;
   const endpoint=item.channel==='quote'?process.env.QUOTE_MAKE_WEBHOOK_URL:process.env.NOTIFICATIONS_MAKE_WEBHOOK_URL;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
   try{
    if(!endpoint)throw Error('Make webhook URL not configured');
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':item.event_key},body:JSON.stringify(item.payload),signal:controller.signal});
    if(!response.ok)throw Error('Make returned '+response.status);
    await pool.query("UPDATE delivery_outbox SET status='delivered',delivered_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1",[item.id]);
   }catch(error){
    const delay=Math.min(3600,30*Math.pow(2,Math.min(item.attempts-1,7)));
    await pool.query("UPDATE delivery_outbox SET status='pending',locked_until=NULL,last_error=$2,next_attempt_at=now()+($3::integer * interval '1 second') WHERE id=$1",[item.id,String(error.message).slice(0,500),delay]);
    console.error('Delivery queued for retry',item.event_key,error.message);
   }finally{clearTimeout(timer)}
  }
 }catch(error){console.error('Outbox worker error',error)}
 finally{delivering=false}
}
async function notifyMake(payload){
 await ensureOutbox();
 const key=payload.event_id||[payload.event_type,payload.reference,payload.quote_id].join(':');
 await enqueueDelivery(pool,key,'notification',payload);
 void processDeliveries();
}
async function enquiryNoticeData(enquiryId,quoteId){
 const {rows}=await pool.query('SELECT e.reference,e.job,q.revision,q.quote FROM enquiries e JOIN quotes q ON q.enquiry_id=e.id WHERE e.id=$1 AND q.id=$2',[enquiryId,quoteId]);
 const x=rows[0];if(!x)throw Error('Notification quote missing');
 return {reference:x.reference,quote_id:quoteId,revision:x.revision,customer_name:x.job.name,customer_email:x.job.email,customer_phone:x.job.phone||'',from:x.job.from,to:x.job.to,quote_total:x.quote.total,agreed_scope:x.quote.scope||''}
}

const token=()=>crypto.randomBytes(32).toString('base64url');
const cookieName='valet_admin';
const parseCookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const auth=wrap(async(req,res,next)=>{const t=parseCookies(req)[cookieName];if(!t)return res.status(401).json({error:'Authentication required'});const {rows}=await pool.query('SELECT a.id,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()',[sha(t)]);if(!rows[0])return res.status(401).json({error:'Session expired'});req.admin=rows[0];next();});
const sameOrigin=(req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.headers.origin;if(origin&&origin!==`https://${req.get('host')}`&&origin!==`http://${req.get('host')}`&&origin!==process.env.PUBLIC_ORIGIN)return res.status(403).json({error:'Origin not allowed'});}next();};
app.use('/api',sameOrigin);
app.get('/api/health',wrap(async(req,res)=>{await pool.query('SELECT 1');res.json({ok:true});}));
app.post('/api/admin/login',rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false}),wrap(async(req,res)=>{
 const username=String(req.body?.username||'').trim(),password=String(req.body?.password||'');
 const {rows}=await pool.query('SELECT id,username,password_hash FROM admins WHERE username=$1',[username]);
 if(!rows[0]||!(await bcrypt.compare(password,rows[0].password_hash)))return res.status(401).json({error:'Invalid credentials'});
 const t=token();await pool.query("INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",[sha(t),rows[0].id]);
 res.cookie(cookieName,t,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:12*3600*1000,path:'/'});res.json({username:rows[0].username});
}));
app.post('/api/admin/logout',auth,wrap(async(req,res)=>{const t=parseCookies(req)[cookieName];await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha(t)]);res.clearCookie(cookieName,{path:'/'});res.json({ok:true});}));
app.get('/api/admin/me',auth,(req,res)=>res.json(req.admin));
app.get('/api/admin/enquiries',auth,wrap(async(req,res)=>{const {rows}=await pool.query('SELECT id,reference,job,status,created_at,updated_at FROM enquiries ORDER BY created_at DESC LIMIT 250');res.json(rows);}));
app.get('/api/admin/enquiries/:id',auth,wrap(async(req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Invalid ID'});const e=await pool.query('SELECT * FROM enquiries WHERE id=$1',[id]);if(!e.rows[0])return res.status(404).json({error:'Not found'});const q=await pool.query('SELECT id,revision,quote,state,sent_at,viewed_at,accepted_at FROM quotes WHERE enquiry_id=$1 ORDER BY revision DESC',[id]);const m=await pool.query('SELECT * FROM messages WHERE enquiry_id=$1 ORDER BY created_at',[id]);const b=await pool.query('SELECT collection_date,arrival_window,quote_id FROM bookings WHERE enquiry_id=$1 LIMIT 1',[id]);res.json({...e.rows[0],quotes:q.rows,messages:m.rows,booking:b.rows[0]||null});}));
const ensureDeskTables=()=>pool.query(`CREATE TABLE IF NOT EXISTS owner_notes(id BIGSERIAL PRIMARY KEY,enquiry_id BIGINT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,admin_id BIGINT REFERENCES admins(id),body TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());CREATE INDEX IF NOT EXISTS owner_notes_enquiry_idx ON owner_notes(enquiry_id,created_at DESC);`);
app.get('/api/admin/dashboard',auth,wrap(async(req,res)=>{
 const {rows}=await pool.query(`SELECT e.id,e.reference,e.status,e.created_at,e.job->>'name' AS name,e.job->>'email' AS email,e.job->>'phone' AS phone,e.job->>'from' AS origin,e.job->>'to' AS destination,
 q.quote->>'total' AS total,b.collection_date,b.arrival_window
 FROM enquiries e LEFT JOIN LATERAL(SELECT quote FROM quotes WHERE enquiry_id=e.id ORDER BY revision DESC LIMIT 1) q ON true
 LEFT JOIN bookings b ON b.enquiry_id=e.id ORDER BY e.created_at DESC LIMIT 500`);
 const counts=Object.fromEntries(['needs_review','draft_ready','quote_sent','change_requested','accepted','booked'].map(x=>[x,rows.filter(r=>r.status===x).length]));
 const booked=rows.filter(r=>r.status==='booked');
 res.json({counts,total:rows.length,booked_value:booked.reduce((n,r)=>n+(Number(r.total)||0),0),jobs:rows});
}));
app.get('/api/admin/enquiries/:id/notes',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});
 await ensureDeskTables();
 const {rows}=await pool.query('SELECT n.id,n.body,n.created_at,a.username AS author FROM owner_notes n LEFT JOIN admins a ON a.id=n.admin_id WHERE n.enquiry_id=$1 ORDER BY n.created_at DESC',[req.params.id]);
 res.json(rows);
}));
app.post('/api/admin/enquiries/:id/notes',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});
 const body=String(req.body?.body||'').trim();
 if(body.length<2||body.length>3000)return res.status(400).json({error:'Note must be 2–3000 characters'});
 await ensureDeskTables();
 const {rows}=await pool.query('INSERT INTO owner_notes(enquiry_id,admin_id,body) VALUES($1,$2,$3) RETURNING id,body,created_at',[req.params.id,req.admin.id,body]);
 res.status(201).json(rows[0]);
}));
app.get('/api/admin/customers',auth,wrap(async(req,res)=>{
 const {rows}=await pool.query(`SELECT lower(trim(job->>'email')) AS email,max(job->>'name') AS name,max(job->>'phone') AS phone,count(*)::int AS enquiries,
 max(created_at) AS last_enquiry,array_agg(reference ORDER BY created_at DESC) AS references
 FROM enquiries WHERE coalesce(trim(job->>'email'),'')<>'' GROUP BY lower(trim(job->>'email')) ORDER BY last_enquiry DESC LIMIT 500`);
 res.json(rows);
}));
app.get('/api/admin/calendar',auth,wrap(async(req,res)=>{
 const {rows}=await pool.query(`SELECT b.enquiry_id,e.reference,e.job->>'name' AS name,e.job->>'from' AS origin,e.job->>'to' AS destination,b.collection_date,b.arrival_window
 FROM bookings b JOIN enquiries e ON e.id=b.enquiry_id ORDER BY b.collection_date,b.arrival_window LIMIT 500`);
 res.json(rows);
}));

const ensureOperationsTables=()=>pool.query(`CREATE TABLE IF NOT EXISTS owner_payments(
 enquiry_id BIGINT PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
 deposit_due NUMERIC(12,2) NOT NULL DEFAULT 0,
 deposit_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
 balance_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS quote_followups(
 quote_id BIGINT PRIMARY KEY REFERENCES quotes(id) ON DELETE CASCADE,
 last_queued_at TIMESTAMPTZ,
 queued_count INTEGER NOT NULL DEFAULT 0);
`);
app.put('/api/admin/quotes/:id/draft',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid quotation'});
 const scope=String(req.body?.scope||'').trim(),validUntil=String(req.body?.validUntil||''),total=Number(req.body?.total);
 if(!scope||scope.length>3000||!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)||!Number.isFinite(total)||total<=0||total>1000000)return res.status(400).json({error:'Valid scope, date and positive price required'});
 if(Date.parse(validUntil+'T23:59:59Z')<Date.now())return res.status(400).json({error:'Expiry date must be in the future'});
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query("SELECT q.quote,q.enquiry_id FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 AND q.state='draft' AND e.status='draft_ready' FOR UPDATE OF q",[req.params.id]);
 if(!rows[0]){await c.query('ROLLBACK');return res.status(409).json({error:'Only unsent draft quotations can be edited'})}
 const old=rows[0].quote,rate=Number(old.net)>0?Number(old.tax||0)/Number(old.net):0.23;
 const net=Math.round(total/(1+rate)*100)/100,tax=Math.round((total-net)*100)/100;
 const updated={...old,scope,validUntil,total:Math.round(total*100)/100,net,tax,manualAdjustment:true};
 await c.query("UPDATE quotes SET quote=$1 WHERE id=$2",[JSON.stringify(updated),req.params.id]);
 await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'owner','draft_edited','Updated unsent quotation')",[rows[0].enquiry_id,req.params.id]);
 await c.query('COMMIT');res.json({ok:true,quote:updated});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.get('/api/admin/enquiries/:id/payments',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});
 await ensureOperationsTables();
 const {rows}=await pool.query(`SELECT p.deposit_due,p.deposit_paid,p.balance_paid,p.updated_at,
 (SELECT (q.quote->>'total')::numeric FROM quotes q WHERE q.enquiry_id=e.id ORDER BY q.revision DESC LIMIT 1) AS total
 FROM enquiries e LEFT JOIN owner_payments p ON p.enquiry_id=e.id WHERE e.id=$1`,[req.params.id]);
 if(!rows[0])return res.status(404).json({error:'Enquiry not found'});
 const x=rows[0],total=Number(x.total)||0,depositDue=Number(x.deposit_due)||0,depositPaid=Number(x.deposit_paid)||0,balancePaid=Number(x.balance_paid)||0;
 res.json({total,deposit_due:depositDue,deposit_paid:depositPaid,balance_paid:balancePaid,outstanding:Math.max(0,Math.round((total-depositPaid-balancePaid)*100)/100)});
}));
app.put('/api/admin/enquiries/:id/payments',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});
 const amounts=['deposit_due','deposit_paid','balance_paid'].map(k=>Number(req.body?.[k]));
 if(amounts.some(n=>!Number.isFinite(n)||n<0||n>1000000))return res.status(400).json({error:'Enter valid non-negative payment amounts'});
 await ensureOperationsTables();
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query("SELECT status FROM enquiries WHERE id=$1 FOR UPDATE",[req.params.id]);
 if(!rows[0]){await c.query('ROLLBACK');return res.status(404).json({error:'Enquiry not found'})}
 if(!['accepted','booked'].includes(rows[0].status)){await c.query('ROLLBACK');return res.status(409).json({error:'Payment tracking starts after customer acceptance'})}
 const q=await c.query("SELECT (quote->>'total')::numeric AS total FROM quotes WHERE enquiry_id=$1 ORDER BY revision DESC LIMIT 1",[req.params.id]);
 const total=Number(q.rows[0]?.total)||0;
 if(amounts[0]>total||amounts[1]+amounts[2]>total){await c.query('ROLLBACK');return res.status(400).json({error:'Amounts exceed the agreed quotation total'})}
 await c.query(`INSERT INTO owner_payments(enquiry_id,deposit_due,deposit_paid,balance_paid) VALUES($1,$2,$3,$4)
 ON CONFLICT(enquiry_id) DO UPDATE SET deposit_due=$2,deposit_paid=$3,balance_paid=$4,updated_at=now()`,[req.params.id,...amounts]);
 await c.query("INSERT INTO messages(enquiry_id,sender,kind,body) VALUES($1,'owner','payment_updated',$2)",[req.params.id,'Deposit received €'+amounts[1].toFixed(2)+'; other payments €'+amounts[2].toFixed(2)]);
 await c.query('COMMIT');res.json({ok:true,outstanding:Math.max(0,total-amounts[1]-amounts[2])});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
let followupWorkerRunning=false;
async function queueAutomaticFollowups(){
 if(process.env.ENABLE_QUOTE_FOLLOWUPS!=='true'||!process.env.NOTIFICATIONS_MAKE_WEBHOOK_URL||followupWorkerRunning)return;
 followupWorkerRunning=true;
 try{
 await ensureOperationsTables();await ensureOutbox();
 const {rows}=await pool.query(`SELECT q.id FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id
 LEFT JOIN quote_followups f ON f.quote_id=q.id
 WHERE q.state='sent' AND e.status='quote_sent' AND q.sent_at<now()-interval '48 hours'
 AND coalesce(f.queued_count,0)<2 AND (f.last_queued_at IS NULL OR f.last_queued_at<now()-interval '72 hours')
 ORDER BY q.sent_at LIMIT 20`);
 for(const item of rows){
 const c=await pool.connect();
 try{
 await c.query('BEGIN');
 const {rows:locked}=await c.query(`SELECT q.id,q.enquiry_id,q.sent_at,e.status,e.reference,e.job
 FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 AND q.state='sent' FOR UPDATE OF q`,[item.id]);
 const q=locked[0];if(!q||q.status!=='quote_sent'){await c.query('ROLLBACK');continue}
 const {rows:previous}=await c.query('SELECT queued_count,last_queued_at FROM quote_followups WHERE quote_id=$1 FOR UPDATE',[q.id]);
 const count=previous[0]?.queued_count||0,last=previous[0]?.last_queued_at;
 if(count>=2||last&&Date.now()-new Date(last).getTime()<72*3600000){await c.query('ROLLBACK');continue}
 const key='followup:'+q.id+':'+(count+1);
 const t=token(),hash=sha(t);
 await c.query(`UPDATE quotes SET quote=jsonb_set(quote,'{whatsappTokenHashes}',coalesce(quote->'whatsappTokenHashes','[]'::jsonb)||to_jsonb($2::text),true) WHERE id=$1`,[q.id,hash]);
 await enqueueDelivery(c,key,'notification',{event_type:'quote_followup',reference:q.reference,quote_id:q.id,customer_name:q.job.name,customer_email:q.job.email,quote_url:quoteUrl(t),followup_number:count+1});
 await c.query(`INSERT INTO quote_followups(quote_id,last_queued_at,queued_count) VALUES($1,now(),1)
 ON CONFLICT(quote_id) DO UPDATE SET last_queued_at=now(),queued_count=quote_followups.queued_count+1`,[q.id]);
 await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');console.error('Follow-up queue error',e)}finally{c.release()}
 }
 if(rows.length)void processDeliveries();
 }catch(e){console.error('Follow-up worker error',e)}finally{followupWorkerRunning=false}
}
if(process.env.DATABASE_URL){setInterval(()=>{void queueAutomaticFollowups()},60*60*1000).unref()}
app.get('/api/admin/followups',auth,wrap(async(req,res)=>{
 await ensureOperationsTables();
 const {rows}=await pool.query(`SELECT q.id AS quote_id,e.id AS enquiry_id,e.reference,e.job->>'name' AS name,
 e.job->>'email' AS email,q.sent_at,q.viewed_at,f.last_queued_at,f.queued_count
 FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id LEFT JOIN quote_followups f ON f.quote_id=q.id
 WHERE q.state='sent' AND e.status='quote_sent' AND q.sent_at<now()-interval '48 hours'
 ORDER BY q.sent_at LIMIT 100`);
 res.json({enabled:process.env.ENABLE_QUOTE_FOLLOWUPS==='true',candidates:rows});
}));
app.post('/api/admin/followups/:id/queue',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid quote'});
 if(process.env.ENABLE_QUOTE_FOLLOWUPS!=='true')return res.status(409).json({error:'Follow-ups disabled. Configure a quote_followup route in Make and set ENABLE_QUOTE_FOLLOWUPS=true.'});
 await ensureOperationsTables();await ensureOutbox();
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query(`SELECT q.id,q.enquiry_id,q.sent_at,q.viewed_at,e.status,e.reference,e.job
 FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 AND q.state='sent' FOR UPDATE OF q`,[req.params.id]);
 const q=rows[0];if(!q||q.status!=='quote_sent'||!q.sent_at||Date.now()-new Date(q.sent_at).getTime()<48*3600000){await c.query('ROLLBACK');return res.status(409).json({error:'Not eligible for follow-up'})}
 const last=await c.query('SELECT last_queued_at,queued_count FROM quote_followups WHERE quote_id=$1',[q.id]);
 const n=last.rows[0]?.queued_count||0;
 if(n>=2||last.rows[0]?.last_queued_at&&Date.now()-new Date(last.rows[0].last_queued_at).getTime()<72*3600000){await c.query('ROLLBACK');return res.status(409).json({error:'Follow-up limit or cooldown reached'})}
 const key='followup:'+q.id+':'+(n+1);
 await enqueueDelivery(c,key,'notification',{event_type:'quote_followup',reference:q.reference,quote_id:q.id,customer_name:q.job.name,customer_email:q.job.email,followup_number:n+1});
 await c.query(`INSERT INTO quote_followups(quote_id,last_queued_at,queued_count) VALUES($1,now(),1)
 ON CONFLICT(quote_id) DO UPDATE SET last_queued_at=now(),queued_count=quote_followups.queued_count+1`,[q.id]);
 await c.query('COMMIT');res.json({ok:true,event_key:key});void processDeliveries();
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
const ensurePhotosTable=()=>pool.query("CREATE TABLE IF NOT EXISTS enquiry_photos (id BIGSERIAL PRIMARY KEY,enquiry_id BIGINT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,filename TEXT NOT NULL,mime_type TEXT NOT NULL,data BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
app.get('/api/admin/enquiries/:id/photos',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});
 await ensurePhotosTable();
 const {rows}=await pool.query('SELECT id,filename,mime_type,octet_length(data) AS size FROM enquiry_photos WHERE enquiry_id=$1 ORDER BY id',[req.params.id]);
 res.json(rows);
}));
app.get('/api/admin/photos/:id',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid photo'});
 await ensurePhotosTable();
 const {rows}=await pool.query('SELECT mime_type,data FROM enquiry_photos WHERE id=$1',[req.params.id]);
 if(!rows[0])return res.status(404).json({error:'Photo not found'});
 res.set({'Content-Type':rows[0].mime_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
 res.send(rows[0].data);
}));
app.post('/api/enquiries',rateLimit({windowMs:15*60*1000,limit:20}),wrap(async(req,res)=>{
 const job=req.body?.job;
 if(!job||typeof job!=='object'||typeof job.from!=='string'||job.from.trim().length<3||typeof job.to!=='string'||job.to.trim().length<3||typeof job.name!=='string'||job.name.trim().length<2||typeof job.email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email)||!job.acknowledge)return res.status(400).json({error:'Incomplete enquiry'});
 const photos=req.body?.photos||[];
 if(!Array.isArray(photos)||photos.length>5)return res.status(400).json({error:'Maximum five photos'});
 const decoded=[];
 for(const p of photos){
  if(!p||p.mime_type!=='image/webp'||typeof p.content_base64!=='string'||p.content_base64.length>600000||!p.content_base64.length)return res.status(400).json({error:'Invalid compressed photo'});
  const data=Buffer.from(p.content_base64,'base64');
  if(data.length>450000||data.length<20||data.subarray(0,4).toString('ascii')!=='RIFF'||data.subarray(8,12).toString('ascii')!=='WEBP')return res.status(400).json({error:'Invalid WebP photo'});
  decoded.push({data,filename:String(p.filename||'photo.webp').slice(0,150)});
 }
 await ensurePhotosTable();
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query('INSERT INTO enquiries(job) VALUES($1) RETURNING id,reference',[JSON.stringify(job)]);
 for(const p of decoded)await c.query('INSERT INTO enquiry_photos(enquiry_id,filename,mime_type,data) VALUES($1,$2,$3,$4)',[rows[0].id,p.filename,'image/webp',p.data]);
 await c.query('COMMIT');
 res.status(201).json(rows[0]);
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}));
app.get('/api/admin/settings',auth,wrap(async(req,res)=>{const {rows}=await pool.query("SELECT value FROM settings WHERE key='rates'");res.json(rows[0]?.value||DEFAULTS);}));
app.put('/api/admin/settings',auth,wrap(async(req,res)=>{const s=req.body;const out={};for(const [key,value] of Object.entries(DEFAULTS)){const v=Number(s?.[key]);if(!Number.isFinite(v)||v<0||v>100000)return res.status(400).json({error:'Invalid rate: '+key});out[key]=v;}await pool.query("INSERT INTO settings(key,value) VALUES('rates',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(out)]);res.json(out);}));
app.post('/api/admin/enquiries/:id/calculate',auth,wrap(async(req,res)=>{const {rows}=await pool.query('SELECT job FROM enquiries WHERE id=$1',[req.params.id]);if(!rows[0])return res.status(404).json({error:'Not found'});const settings=await pool.query("SELECT value FROM settings WHERE key='rates'");res.json(calculate(rows[0].job,settings.rows[0]?.value||DEFAULTS,req.body?.overrides||{}));}));
app.post('/api/admin/enquiries/:id/drafts',auth,wrap(async(req,res)=>{
 const id=Number(req.params.id),scope=String(req.body?.scope||'').trim(),validUntil=String(req.body?.validUntil||'');if(!scope||scope.length>3000||!/\d{4}-\d{2}-\d{2}/.test(validUntil))return res.status(400).json({error:'Scope and valid-until date required'});
 const client=await pool.connect();try{await client.query('BEGIN');const en=await client.query('SELECT job FROM enquiries WHERE id=$1 FOR UPDATE',[id]);if(!en.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Not found'});}const s=await client.query("SELECT value FROM settings WHERE key='rates'");const calculated=calculate(en.rows[0].job,s.rows[0]?.value||DEFAULTS,req.body?.overrides||{});if(!calculated.eligible){await client.query('ROLLBACK');return res.status(422).json({error:'Complete route, handling and feasibility checks before preparing a quote',flags:calculated.flags});}const latest=await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM quotes WHERE enquiry_id=$1',[id]);const revision=latest.rows[0].revision;const quote={...calculated,scope,validUntil,revision,preparedAt:new Date().toISOString()};const {rows}=await client.query("INSERT INTO quotes(enquiry_id,revision,quote,state) VALUES($1,$2,$3,'draft') RETURNING id,revision,state",[id,revision,JSON.stringify(quote)]);await client.query("UPDATE enquiries SET status='draft_ready',updated_at=now() WHERE id=$1",[id]);await client.query('COMMIT');res.status(201).json(rows[0]);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

app.post('/api/admin/enquiries/:id/revise',auth,wrap(async(req,res)=>{
 const id=Number(req.params.id),scope=String(req.body?.scope||'').trim(),validUntil=String(req.body?.validUntil||''),total=Number(req.body?.total);
 if(!Number.isSafeInteger(id)||id<1||!scope||scope.length>3000||!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)||!Number.isFinite(total)||total<=0||total>1000000)return res.status(400).json({error:'Provide a valid scope, expiry date and positive total price'});
 if(Date.parse(validUntil+'T23:59:59Z')<Date.now())return res.status(400).json({error:'Validity date cannot be in the past'});
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const en=await c.query('SELECT id,status FROM enquiries WHERE id=$1 FOR UPDATE',[id]);
 if(!en.rows[0]){await c.query('ROLLBACK');return res.status(404).json({error:'Enquiry not found'})}
 if(en.rows[0].status!=='change_requested'){await c.query('ROLLBACK');return res.status(409).json({error:'Revisions are only available for customer change requests'})}
 const prev=await c.query('SELECT quote,revision FROM quotes WHERE enquiry_id=$1 ORDER BY revision DESC LIMIT 1',[id]);
 if(!prev.rows[0]){await c.query('ROLLBACK');return res.status(409).json({error:'No previous quotation'})}
 const old=prev.rows[0].quote,revision=prev.rows[0].revision+1;
 const vatRate=Number(old.net)>0?Number(old.tax||0)/Number(old.net):0.23;
 const net=Number((total/(1+vatRate)).toFixed(2)),tax=Number((total-net).toFixed(2));
 const quote={...old,scope,validUntil,revision,total:Number(total.toFixed(2)),net,tax,manualRevision:true,previousTotal:old.total,preparedAt:new Date().toISOString()};
 const {rows}=await c.query("INSERT INTO quotes(enquiry_id,revision,quote,state) VALUES($1,$2,$3,'draft') RETURNING id,revision,state",[id,revision,JSON.stringify(quote)]);
 await c.query("UPDATE enquiries SET status='draft_ready',updated_at=now() WHERE id=$1",[id]);
 await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'owner','revision_prepared',$3)",[id,rows[0].id,'Revision '+revision+' prepared following customer changes']);
 await c.query('COMMIT');res.status(201).json(rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));

const quoteUrl=t=>`${(process.env.PUBLIC_ORIGIN||'https://valet-removals-updated.onrender.com').replace(/\/$/,'')}/quote/${encodeURIComponent(t)}`;
const validId=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;
app.post('/api/admin/quotes/:id/whatsapp-link',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid quote'});
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows}=await c.query("SELECT q.id,q.enquiry_id,q.quote,q.state,e.reference,e.job,e.status FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 FOR UPDATE OF q",[req.params.id]);
 const q=rows[0];
 if(!q||q.state!=='sent'||q.status!=='quote_sent'){await c.query('ROLLBACK');return res.status(409).json({error:'Only the current sent quotation can be shared via WhatsApp'})}
 const phone=String(q.job.phone||'');
 let digits=Array.from(phone).filter(ch=>ch>='0'&&ch<='9').join('');
 if(digits.startsWith('00'))digits=digits.slice(2);
 else if(digits.startsWith('0'))digits='353'+digits.slice(1);
 if(digits.length<8||digits.length>15){await c.query('ROLLBACK');return res.status(422).json({error:'Customer phone number is missing or invalid for WhatsApp'})}
 const t=token();
 await c.query("UPDATE quotes SET quote=jsonb_set(quote,'{whatsappTokenHashes}',to_jsonb(ARRAY(SELECT jsonb_array_elements_text(COALESCE(quote->'whatsappTokenHashes','[]'::jsonb))) || $1::text),true) WHERE id=$2",[sha(t),q.id]);
 await c.query('COMMIT');
 const link=quoteUrl(t);
 const msg='Hi '+q.job.name+', your Valet Removals & Transport quotation '+q.reference+' is ready. Total: €'+Number(q.quote.total).toFixed(2)+'. View, accept or request changes: '+link+'\n\nKind regards,\nValet Removals & Transport';
 res.json({whatsapp_url:'https://wa.me/'+digits+'?text='+encodeURIComponent(msg)});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));

const testApi=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
const testAuth=(req,res,next)=>{
 if(process.env.ENABLE_TEST_API!=='true'||process.env.NODE_ENV==='production'&&process.env.ALLOW_TEST_API_IN_PRODUCTION!=='true')return res.status(404).json({error:'Test API disabled'});
 const expected=process.env.TEST_API_KEY||'',supplied=String(req.get('x-test-api-key')||'');
 if(expected.length<32||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.status(401).json({error:'Invalid test API key'});
 next();
};
app.post('/api/test/enquiries/quote-sent',testApi,testAuth,wrap(async(req,res)=>{
 const input=req.body||{};
 const name=String(input.name||'Test Customer').trim(),email=String(input.email||'test@example.com').trim(),phone=String(input.phone||'0871234567').trim();
 const from=String(input.from||'Dublin 2').trim(),to=String(input.to||'Dublin 4').trim(),scope=String(input.scope||'Test removal of household furniture').trim();
 const total=Number(input.total??369);
 if(name.length<2||name.length>150||!email.includes('@')||email.length>254||phone.length>40||from.length<3||from.length>300||to.length<3||to.length>300||scope.length<3||scope.length>3000||!Number.isFinite(total)||total<=0||total>100000)return res.status(400).json({error:'Invalid test enquiry fields'});
 const job={name,email,phone,from,to,description:scope,acknowledge:true};
 const expiry=new Date(Date.now()+14*86400000).toISOString().slice(0,10);
 const quote={total,scope,validUntil:expiry,revision:1,manualRevision:true,preparedAt:new Date().toISOString(),test:true};
 const t=token(),c=await pool.connect();
 try{
 await c.query('BEGIN');
 const {rows:[en]}=await c.query("INSERT INTO enquiries(job,source,status) VALUES($1,'api_test','quote_sent') RETURNING id,reference",[JSON.stringify(job)]);
 const {rows:[q]}=await c.query("INSERT INTO quotes(enquiry_id,revision,quote,state,customer_token_hash,sent_at) VALUES($1,1,$2,'sent',$3,now()) RETURNING id",[en.id,JSON.stringify(quote),sha(t)]);
 await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'system','test_seed','Test quotation created without sending email')",[en.id,q.id]);
 await c.query('COMMIT');
 res.status(201).json({test:true,enquiry_id:en.id,reference:en.reference,quote_id:q.id,status:'quote_sent',quote_url:quoteUrl(t),admin_url:(process.env.PUBLIC_ORIGIN||'https://valet-removals-updated.onrender.com')+'/admin'});
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}));
app.get('/api/test/deliveries',testApi,testAuth,wrap(async(req,res)=>{
 await ensureOutbox();
 const {rows}=await pool.query("SELECT id,event_key,channel,status,attempts,next_attempt_at,delivered_at,last_error,created_at FROM delivery_outbox ORDER BY id DESC LIMIT 50");
 res.json(rows);
}));
app.post('/api/test/enquiries/draft',testApi,testAuth,wrap(async(req,res)=>{
 const input=req.body||{},email=String(input.email||'test@example.com').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:'Invalid email'});
 const job={name:String(input.name||'Test Draft Customer').slice(0,150),email,phone:'0871234567',from:'Dublin 2',to:'Dublin 4',acknowledge:true};
 const quote={total:369,scope:'Test furniture removal',validUntil:new Date(Date.now()+14*86400000).toISOString().slice(0,10),revision:1,test:true};
 const c=await pool.connect();try{
 await c.query('BEGIN');
 const {rows:[en]}=await c.query("INSERT INTO enquiries(job,source,status) VALUES($1,'api_test','draft_ready') RETURNING id,reference",[JSON.stringify(job)]);
 const {rows:[q]}=await c.query("INSERT INTO quotes(enquiry_id,revision,quote,state) VALUES($1,1,$2,'draft') RETURNING id",[en.id,JSON.stringify(quote)]);
 await c.query('COMMIT');
 res.status(201).json({test:true,enquiry_id:en.id,reference:en.reference,quote_id:q.id,status:'draft_ready',admin_url:(process.env.PUBLIC_ORIGIN||'https://valet-removals-updated.onrender.com')+'/admin'});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.get('/api/test/enquiries',testApi,testAuth,wrap(async(req,res)=>{
 const {rows}=await pool.query("SELECT e.id,e.reference,e.status,e.job->>'name' AS name,e.created_at,q.id AS quote_id,q.state AS quote_state FROM enquiries e LEFT JOIN LATERAL (SELECT id,state FROM quotes WHERE enquiry_id=e.id ORDER BY revision DESC LIMIT 1) q ON true WHERE e.source='api_test' ORDER BY e.created_at DESC LIMIT 50");
 res.json(rows);
}));
const customerQuote=wrap(async(req,res,next)=>{const t=String(req.params.token||'');if(!/^[A-Za-z0-9_-]{40,100}$/.test(t))return res.status(404).json({error:'Quote not found'});const {rows}=await pool.query("SELECT q.id,q.enquiry_id,q.revision,q.quote,q.state,q.viewed_at,e.reference,e.job,e.status FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE (q.customer_token_hash=$1 OR COALESCE(q.quote->'whatsappTokenHashes','[]'::jsonb) ? $1) AND q.state IN ('sent','accepted')",[sha(t)]);if(!rows[0])return res.status(404).json({error:'Quote not found'});req.customerQuote=rows[0];next()});
app.get('/api/quotes/:token',customerQuote,wrap(async(req,res)=>{const q=req.customerQuote;if(!q.viewed_at)await pool.query("UPDATE quotes SET viewed_at=now() WHERE id=$1 AND viewed_at IS NULL",[q.id]);const m=await pool.query("SELECT sender,kind,body,created_at FROM messages WHERE quote_id=$1 ORDER BY created_at",[q.id]);res.json({reference:q.reference,job:{name:q.job.name,from:q.job.from,to:q.job.to,date:q.job.date},revision:q.revision,quote:((({whatsappTokenHashes,...safe})=>safe)(q.quote)),state:q.state,status:q.status,messages:m.rows})}));
app.post('/api/quotes/:token/accept',rateLimit({windowMs:15*60*1000,limit:12}),customerQuote,wrap(async(req,res)=>{const q=req.customerQuote;if(q.state==='accepted')return res.json({ok:true,status:'accepted'});if(q.status!=='quote_sent')return res.status(409).json({error:'This quotation is being revised or is no longer available for acceptance'});if(q.quote.validUntil&&Date.parse(q.quote.validUntil+'T23:59:59Z')<Date.now())return res.status(409).json({error:'This quote has expired'});const c=await pool.connect();try{await c.query('BEGIN');const updated=await c.query("UPDATE quotes SET state='accepted',accepted_at=now() WHERE id=$1 AND state='sent' RETURNING id",[q.id]);if(!updated.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'Quote no longer available'})}await c.query("UPDATE enquiries SET status='accepted',updated_at=now() WHERE id=$1",[q.enquiry_id]);await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'customer','acceptance','Customer accepted quotation')",[q.enquiry_id,q.id]);await c.query('COMMIT');res.json({ok:true,status:'accepted'});try{const details=await enquiryNoticeData(q.enquiry_id,q.id);await notifyMake({event_type:'quote_accepted',event_id:'accepted:'+q.id,...details,admin_url:(process.env.PUBLIC_ORIGIN||'https://valet-removals-updated.onrender.com')+'/admin'})}catch(error){console.error('Acceptance notification preparation failed',error)}}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
app.post('/api/quotes/:token/change',rateLimit({windowMs:15*60*1000,limit:12}),customerQuote,wrap(async(req,res)=>{const q=req.customerQuote,body=String(req.body?.message||'').trim();if(body.length<5||body.length>2000)return res.status(400).json({error:'Enter a change request (5–2000 characters)'});if(q.state!=='sent'||q.status!=='quote_sent')return res.status(409).json({error:'Quote is not awaiting review'});await pool.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'customer','change_request',$3)",[q.enquiry_id,q.id,body]);await pool.query("UPDATE enquiries SET status='change_requested',updated_at=now() WHERE id=$1",[q.enquiry_id]);res.json({ok:true});try{const details=await enquiryNoticeData(q.enquiry_id,q.id);await notifyMake({event_type:'change_requested',event_id:'change:'+q.id+':'+sha(body),...details,change_message:body,admin_url:(process.env.PUBLIC_ORIGIN||'https://valet-removals-updated.onrender.com')+'/admin'})}catch(error){console.error('Change notification preparation failed',error)}}));
app.post('/api/admin/quotes/:id/send',auth,wrap(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({error:'Invalid quote ID'});
 if(!process.env.QUOTE_MAKE_WEBHOOK_URL)return res.status(503).json({error:'Configure QUOTE_MAKE_WEBHOOK_URL in Render first'});
 await ensureOutbox();
 const c=await pool.connect();try{
  await c.query('BEGIN');
  const {rows}=await c.query("SELECT q.*,e.reference,e.job FROM quotes q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 FOR UPDATE OF q",[req.params.id]);
  const row=rows[0];if(!row){await c.query('ROLLBACK');return res.status(404).json({error:'Quote not found'})}
  if(row.state!=='draft'){await c.query('ROLLBACK');return res.status(409).json({error:'Quotation already submitted for delivery'})}
  const t=token(),url=quoteUrl(t);
  const payload={type:'valet_quote_approved',reference:row.reference,quote_id:row.id,revision:row.revision,customer_name:row.job.name,customer_email:row.job.email,customer_phone:row.job.phone,from:row.job.from,to:row.job.to,quote:row.quote,quote_url:url};
  await c.query("UPDATE quotes SET state='sent',sent_at=now(),customer_token_hash=$1 WHERE id=$2",[sha(t),row.id]);
  await c.query("UPDATE quotes SET state='superseded' WHERE enquiry_id=$1 AND id<>$2 AND state='sent'",[row.enquiry_id,row.id]);
  await c.query("UPDATE enquiries SET status='quote_sent',updated_at=now() WHERE id=$1",[row.enquiry_id]);
  await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'owner','quote_sent','Approved quotation queued for email')",[row.enquiry_id,row.id]);
  await enqueueDelivery(c,'quote:'+row.id,'quote',payload);
  await c.query('COMMIT');res.json({ok:true,delivery:'queued',quote_url:url});void processDeliveries();
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.post('/api/admin/enquiries/:id/confirm-booking',auth,wrap(async(req,res)=>{if(!validId(req.params.id))return res.status(400).json({error:'Invalid enquiry'});const collectionDate=String(req.body?.collectionDate||''),arrivalWindow=String(req.body?.arrivalWindow||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate)||!arrivalWindow||arrivalWindow.length>120)return res.status(400).json({error:'Collection date and arrival window required'});const c=await pool.connect();try{await c.query('BEGIN');const {rows}=await c.query("SELECT id FROM quotes WHERE enquiry_id=$1 AND state='accepted' ORDER BY revision DESC LIMIT 1",[req.params.id]);if(!rows[0]){await c.query('ROLLBACK');return res.status(409).json({error:'Customer must accept the quote before booking'})}const inserted=await c.query("INSERT INTO bookings(enquiry_id,quote_id,collection_date,arrival_window) VALUES($1,$2,$3,$4) ON CONFLICT(enquiry_id) DO NOTHING RETURNING enquiry_id",[req.params.id,rows[0].id,collectionDate,arrivalWindow]);if(!inserted.rowCount){await c.query('ROLLBACK');return res.json({ok:true,already_booked:true})}await c.query("UPDATE enquiries SET status='booked',updated_at=now() WHERE id=$1",[req.params.id]);await c.query("INSERT INTO messages(enquiry_id,quote_id,sender,kind,body) VALUES($1,$2,'owner','booking_confirmed',$3)",[req.params.id,rows[0].id,'Collection '+collectionDate+' · '+arrivalWindow]);await c.query('COMMIT');res.json({ok:true});try{const details=await enquiryNoticeData(Number(req.params.id),rows[0].id);await notifyMake({event_type:'booking_confirmed',event_id:'booking:'+req.params.id,...details,collection_date:collectionDate,arrival_window:arrivalWindow})}catch(error){console.error('Booking notification preparation failed',error)}}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
app.get('/quote/:token',(req,res)=>res.sendFile(path.join(projectRoot,'customer/quote.html')));
app.get('/customer/quote.js',(req,res)=>res.sendFile(path.join(projectRoot,'customer/quote.js')));

app.use('/api',(req,res)=>res.status(404).json({error:'Endpoint not found'}));
app.get('/',(req,res)=>res.sendFile(path.join(projectRoot,'index.html')));
for(const asset of ['styles.css','app.js','valet-van.png'])app.get('/'+asset,(req,res)=>res.sendFile(path.join(projectRoot,asset)));

const adminPage=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../admin/index.html');
app.get('/journey.css',(req,res)=>res.sendFile(path.join(projectRoot,'journey.css')));
app.get('/admin/desk-upgrades.js',(req,res)=>res.set('Content-Type','text/javascript; charset=utf-8').sendFile(path.join(projectRoot,'admin/desk-upgrades.js')));
app.get('/admin/desk-upgrades.css',(req,res)=>res.type('css').sendFile(path.join(projectRoot,'admin/desk-upgrades.css')));
app.get('/admin/owner.js',(req,res)=>res.sendFile(path.join(projectRoot,'admin/owner.js')));app.get('/admin/owner-v2.js',(req,res)=>res.sendFile(path.join(projectRoot,'admin/owner-v2.js')));
app.get(['/admin','/admin/'],wrap(async(req,res)=>res.type('html').send(await readFile(adminPage,'utf8'))));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Server error'});});
const port=Number(process.env.PORT||3000);
if(process.env.DATABASE_URL){setInterval(()=>{void processDeliveries()},30000).unref();void processDeliveries()}
if(process.env.DATABASE_URL)app.listen(port,()=>console.log(`Valet API listening on ${port}`));
else {console.error('DATABASE_URL is required');process.exitCode=1;}
