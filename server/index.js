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
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'200kb'}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='require'?{rejectUnauthorized:true}:undefined});
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const cookieName='valet_admin';
const parseCookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const auth=wrap(async(req,res,next)=>{const t=parseCookies(req)[cookieName];if(!t)return res.status(401).json({error:'Authentication required'});const {rows}=await pool.query('SELECT a.id,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()',[sha(t)]);if(!rows[0])return res.status(401).json({error:'Session expired'});req.admin=rows[0];next();});
const sameOrigin=(req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.headers.origin;if(origin&&origin!==`${req.protocol}://${req.get('host')}`&&origin!==process.env.PUBLIC_ORIGIN)return res.status(403).json({error:'Origin not allowed'});}next();};
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
app.get('/api/admin/enquiries/:id',auth,wrap(async(req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Invalid ID'});const e=await pool.query('SELECT * FROM enquiries WHERE id=$1',[id]);if(!e.rows[0])return res.status(404).json({error:'Not found'});const q=await pool.query('SELECT id,revision,quote,state,sent_at,viewed_at,accepted_at FROM quotes WHERE enquiry_id=$1 ORDER BY revision DESC',[id]);const m=await pool.query('SELECT * FROM messages WHERE enquiry_id=$1 ORDER BY created_at',[id]);res.json({...e.rows[0],quotes:q.rows,messages:m.rows});}));
app.post('/api/enquiries',rateLimit({windowMs:15*60*1000,limit:20}),wrap(async(req,res)=>{
 const job=req.body?.job;
 if(!job||typeof job!=='object'||typeof job.from!=='string'||job.from.trim().length<3||typeof job.to!=='string'||job.to.trim().length<3||typeof job.name!=='string'||job.name.trim().length<2||typeof job.email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email)||!job.acknowledge)return res.status(400).json({error:'Incomplete enquiry'});
 const {rows}=await pool.query('INSERT INTO enquiries(job) VALUES($1) RETURNING id,reference',[JSON.stringify(job)]);
 res.status(201).json(rows[0]);
}));
app.get('/api/admin/settings',auth,wrap(async(req,res)=>{const {rows}=await pool.query("SELECT value FROM settings WHERE key='rates'");res.json(rows[0]?.value||DEFAULTS);}));
app.put('/api/admin/settings',auth,wrap(async(req,res)=>{const s=req.body;const out={};for(const [key,value] of Object.entries(DEFAULTS)){const v=Number(s?.[key]);if(!Number.isFinite(v)||v<0||v>100000)return res.status(400).json({error:'Invalid rate: '+key});out[key]=v;}await pool.query("INSERT INTO settings(key,value) VALUES('rates',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(out)]);res.json(out);}));
app.post('/api/admin/enquiries/:id/calculate',auth,wrap(async(req,res)=>{const {rows}=await pool.query('SELECT job FROM enquiries WHERE id=$1',[req.params.id]);if(!rows[0])return res.status(404).json({error:'Not found'});const settings=await pool.query("SELECT value FROM settings WHERE key='rates'");res.json(calculate(rows[0].job,settings.rows[0]?.value||DEFAULTS,req.body?.overrides||{}));}));
app.post('/api/admin/enquiries/:id/drafts',auth,wrap(async(req,res)=>{
 const id=Number(req.params.id),scope=String(req.body?.scope||'').trim(),validUntil=String(req.body?.validUntil||'');if(!scope||scope.length>3000||!/\d{4}-\d{2}-\d{2}/.test(validUntil))return res.status(400).json({error:'Scope and valid-until date required'});
 const client=await pool.connect();try{await client.query('BEGIN');const en=await client.query('SELECT job FROM enquiries WHERE id=$1 FOR UPDATE',[id]);if(!en.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Not found'});}const s=await client.query("SELECT value FROM settings WHERE key='rates'");const calculated=calculate(en.rows[0].job,s.rows[0]?.value||DEFAULTS,req.body?.overrides||{});if(!calculated.eligible){await client.query('ROLLBACK');return res.status(422).json({error:'Complete route, handling and feasibility checks before preparing a quote',flags:calculated.flags});}const latest=await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM quotes WHERE enquiry_id=$1',[id]);const revision=latest.rows[0].revision;const quote={...calculated,scope,validUntil,revision,preparedAt:new Date().toISOString()};const {rows}=await client.query("INSERT INTO quotes(enquiry_id,revision,quote,state) VALUES($1,$2,$3,'draft') RETURNING id,revision,state",[id,revision,JSON.stringify(quote)]);await client.query("UPDATE enquiries SET status='draft_ready',updated_at=now() WHERE id=$1",[id]);await client.query('COMMIT');res.status(201).json(rows[0]);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.use('/api',(req,res)=>res.status(404).json({error:'Endpoint not found'}));
const adminPage=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../admin/index.html');
app.get(['/admin','/admin/'],wrap(async(req,res)=>res.type('html').send(await readFile(adminPage,'utf8'))));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Server error'});});
const port=Number(process.env.PORT||3000);
if(process.env.DATABASE_URL)app.listen(port,()=>console.log(`Valet API listening on ${port}`));
else {console.error('DATABASE_URL is required');process.exitCode=1;}
