// Valet Removals - Phase 1 enquiry only. No customer pricing or owner dashboard.
const WEBHOOK='https://hook.eu2.make.com/r4k3ymfz2j4zxxbqrikk7dylrjgigks3';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=x=>JSON.parse(JSON.stringify(x));
const access=()=>({service:'ready',floor:'0',lift:'yes',steps:'none',carry:'near',parking:'yes',tight:false});
const blank=()=>({from:'',to:'',date:'',flexible:true,timing:'standard',stops:[],description:'',load:'small',itemKind:'unknown',assembly:'no',listing:'',pickup:access(),dropoff:access(),name:'',email:'',phone:'',notes:'',whatsapp:false,acknowledge:false});
let job=blank(),photos=[],step=0,toastTimer;
const labels={load:{small:'1–3 items / a few boxes',medium:'A small move / part van',large:'A larger move / full van',unknown:'Load to confirm'},itemKind:{light:'Manageable boxes / light items',bulky:'Standard bulky furniture',special:'Unusually heavy / fragile',unknown:'Handling to confirm'},service:{ready:'Ready at ground-floor entrance',indoor:'Indoor help',unsure:'Service to confirm'},carry:{near:'Under 10m',mid:'10–30m',long:'30–50m',far:'Over 50m',unknown:'Distance unknown'}};
function get(path,obj=job){return path.split('.').reduce((a,k)=>a?.[k],obj);}
function put(path,value,obj=job){const keys=path.split('.');let t=obj;keys.slice(0,-1).forEach(k=>t=t[k]);t[keys.at(-1)]=value;}
function input(name,label,type='text',placeholder='',extra=''){return `<label class="field"><span class="field-label">${label}</span><input name="${name}" type="${type}" value="${esc(get(name))}" placeholder="${esc(placeholder)}" ${extra}></label>`;}
function select(name,label,options){return `<label class="field"><span class="field-label">${label}</span><select name="${name}">${options.map(([v,t])=>`<option value="${v}" ${String(get(name))===v?'selected':''}>${t}</option>`).join('')}</select></label>`;}
function check(name,label){return `<label class="check"><input type="checkbox" name="${name}" ${get(name)?'checked':''}><span>${label}</span></label>`;}
function choices(name,label,options){return `<fieldset><legend>${label}</legend><div class="choice-row">${options.map(([v,t,d])=>`<label class="choice"><input type="radio" name="${name}" value="${v}" ${get(name)===v?'checked':''}><span>${t}${d?`<small>${d}</small>`:''}</span></label>`).join('')}</div></fieldset>`;}
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);}
function capture(){for(const e of $('#formStep').querySelectorAll('[name]')){if(e.type==='radio'&&!e.checked)continue;if(e.type==='file')continue;if(e.name.startsWith('stop-')){job.stops[Number(e.name.slice(5))]=e.value;continue;}put(e.name,e.type==='checkbox'?e.checked:e.value);}}

let placesLibraryPromise;
function loadPlacesLibrary(){
 if(!placesLibraryPromise)placesLibraryPromise=(async()=>{
  const response=await fetch('/api/public/maps-config');
  if(!response.ok)throw Error('Maps configuration unavailable');
  const {apiKey}=await response.json();
  if(!apiKey)throw Error('Maps key not configured');
  if(!window.google?.maps?.importLibrary)await new Promise((resolve,reject)=>{
   const script=document.createElement('script');
   window.valetMapsReady=resolve;
   script.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(apiKey)+'&v=weekly&loading=async&callback=valetMapsReady';
   script.async=true;script.onerror=reject;document.head.appendChild(script);
  });
  return google.maps.importLibrary('places');
 })().catch(error=>{console.warn('Address autocomplete unavailable',error);return null});
 return placesLibraryPromise;
}
async function attachAddressAutocomplete(){
 const inputs=[...document.querySelectorAll('#formStep input[name="from"],#formStep input[name="to"],#formStep input[name^="stop-"]')];
 if(!inputs.length)return;
 const library=await loadPlacesLibrary();
 if(!library?.PlaceAutocompleteElement)return;
 for(const field of inputs){
  if(!field.isConnected||field.dataset.placesAttached)continue;
  try{
   const host=document.createElement('div');host.style.cssText='display:grid;gap:6px;min-width:0;width:100%';
   const widget=new library.PlaceAutocompleteElement({includedRegionCodes:['ie']});
   widget.setAttribute('placeholder',field.placeholder||'Search address or Eircode');
   widget.setAttribute('aria-label',field.getAttribute('aria-label')||field.placeholder||'Search address');
   widget.style.cssText='display:block;width:100%;color-scheme:light';
   const toggle=document.createElement('button');toggle.type='button';toggle.className='textbutton';toggle.style.cssText='font-size:12px;justify-self:start;margin:0';
   field.before(host);host.append(widget,toggle,field);
   field.hidden=!field.value;
   widget.hidden=!!field.value;
   function sync(){field.style.display=field.hidden?'none':'';widget.style.display=widget.hidden?'none':'block';toggle.textContent=field.hidden?'Enter address manually':'Search Google addresses';}
   sync();
   toggle.onclick=()=>{field.hidden=!field.hidden;widget.hidden=!field.hidden;sync();if(!field.hidden)field.focus();};
   widget.addEventListener('gmp-select',async event=>{
    try{
     const place=event.placePrediction.toPlace();
     await place.fetchFields({fields:['formattedAddress']});
     if(!field.isConnected)return;
     field.value=place.formattedAddress||event.placePrediction.text.toString();
     field.hidden=false;widget.hidden=true;sync();capture();
    }catch(error){field.hidden=false;widget.hidden=true;sync();field.focus();console.warn('Address selection unavailable',error);}
   });
   widget.addEventListener('gmp-error',()=>{field.hidden=false;widget.hidden=true;sync();toggle.hidden=true;});
   field.dataset.placesAttached='1';
  }catch(error){console.warn('Address autocomplete unavailable',error);}
 }
}


let mobileSession=null,mobileTimer=null,mobileBusy=false;
async function syncMobilePhotos(){
 if(!mobileSession||mobileBusy)return;mobileBusy=true;const session=mobileSession;
 try{const r=await fetch('/api/mobile-photos/'+session.id,{cache:'no-store'});if(!r.ok){if(r.status===404){clearInterval(mobileTimer);mobileSession=null;const status=$('#mobileStatus');if(status)status.textContent='QR expired. Generate a new code.';const b=$('#mobileStart');if(b)b.hidden=false;}return;}
 const data=await r.json();if(mobileSession!==session)return;
 let changed=false;
 for(const p of data.photos){if(photos.some(x=>x.mobileId===p.id)||photos.length>=5)continue;const bytes=Uint8Array.from(atob(p.content_base64),c=>c.charCodeAt(0));const file=new File([bytes],p.filename,{type:'image/webp'});photos.push({name:p.filename,file,url:URL.createObjectURL(file),mobileId:p.id,compressed:p});changed=true;}
 if(changed)renderPhotos();const status=$('#mobileStatus');if(status)status.textContent=photos.length+' of 5 photos added. Phone uploads appear here automatically.';
 }catch(e){}finally{mobileBusy=false;}
}
function wireMobilePhotos(){
 const b=$('#mobileStart'),panel=$('#mobileQR');if(!b||!panel)return;
 function show(){panel.innerHTML='';const img=document.createElement('img');img.src=mobileSession.qr;img.alt='Scan to upload photos';img.width=160;img.height=160;panel.append(img);b.hidden=true;}
 if(mobileSession)show();
 b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/api/mobile-photos',{method:'POST'});if(!r.ok)throw Error('Unable to create QR code');mobileSession=await r.json();show();clearInterval(mobileTimer);mobileTimer=setInterval(syncMobilePhotos,10000);void syncMobilePhotos();}catch(e){toast(e.message);}finally{b.disabled=false;}};
}

let visionEnabled=false,visionConsent=false;
fetch('/api/public/vision-config').then(r=>r.json()).then(c=>{visionEnabled=!!c.enabled;wireVisionConsent();}).catch(()=>{});
function wireVisionConsent(){const p=$('#visionConsentPanel');if(!p)return;p.hidden=!visionEnabled;const c=$('#visionConsent');if(c){c.checked=visionConsent;c.onchange=()=>{visionConsent=c.checked;};}}
function renderStep(){
 $('#formError').hidden=true;
 document.querySelectorAll('.stepper li').forEach((li,i)=>{li.classList.toggle('active',i===step);li.classList.toggle('done',i<step);if(i===step)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
 $('#backBtn').hidden=step===0;$('#nextBtn').innerHTML=step===2?'Request my quote <span>↗</span>':'Continue <span>→</span>';
 if(step===0)$('#formStep').innerHTML=`<div class="route-fields">${input('from','Collection address or Eircode','text','e.g. Sandyford, Dublin 18','autocomplete="off" maxlength="180"')}${input('to','Delivery address or Eircode','text','e.g. Bray, Co. Wicklow','autocomplete="off" maxlength="180"')}</div><div id="extraStops">${job.stops.map((s,i)=>`<div class="stop-row"><input aria-label="Extra stop ${i+1}" name="stop-${i}" value="${esc(s)}" placeholder="Extra stop address or Eircode" maxlength="180"><button type="button" class="textbutton" data-remove-stop="${i}">Remove</button></div>`).join('')}</div><button type="button" class="textbutton" id="addStop">+ Add another stop</button><div class="two-col">${input('date','Preferred moving date','date','','min="'+new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Dublin'})+'"')}${select('timing','Timing',[['standard','Standard daytime'],['urgent','Urgent / out of hours']])}</div>${check('flexible','My date is flexible — a suitable route slot could cost less.')}<p class="soft-note">An area or Eircode is enough to get started. We’ll confirm the exact addresses and route before quoting.</p>`;
 if(step===1)$('#formStep').innerHTML=`<label class="field"><span class="field-label">What are we moving?</span><textarea name="description" maxlength="2500" rows="3" placeholder="e.g. One 3-seater sofa, a dismantled double bed and 8 packed boxes. Add dimensions or weight if known.">${esc(job.description)}</textarea><small>A short description is perfect. No item-by-item inventory required.</small></label>${select('load','Roughly how much is there?',Object.entries(labels.load))}${select('itemKind','What best describes the items?',Object.entries(labels.itemKind))}${select('assembly','Will anything need dismantling or reassembly?',[['no','No — everything will be ready'],['yes','Yes — please include this'],['unknown','Not sure yet']])}<label class="upload">Add a few photos <span class="muted">(optional)</span><input id="photoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple><span class="helper">Up to 5 JPG, PNG or WebP photos, 2 MB each (maximum 6 MB combined). Photos will be included with your enquiry.</span></label><div style="border:1px solid #dce5ec;border-radius:12px;padding:16px;margin:12px 0;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:160px"><strong>Photos on your phone?</strong><p class="helper">Scan a QR code with your phone camera to upload directly to this enquiry.</p><button type="button" class="button outline" id="mobileStart">Show QR code</button><p id="mobileStatus" class="helper" role="status"></p></div><div id="mobileQR"></div></div><div id="photos" class="photos"></div><div id="visionConsentPanel" hidden><label class="field"><span><input type="checkbox" id="visionConsent"> Use AI to summarise my uploaded photos</span><small>Optional: photos are sent to OpenAI for analysis. Avoid including people or private documents. The summary is an estimate for review.</small></label></div>${input('listing','Or paste an item listing link (optional)','url','https://…','maxlength="2000"')}<p class="helper">For bulky or unusual items, photos and dimensions help us confirm a suitable crew.</p>`;
 if(step===2)$('#formStep').innerHTML=`<p class="helper">Choose the help you need at <strong>both</strong> addresses. Select “Not sure” whenever you need us to check.</p>${accessCard('pickup','Collection',job.from)}${accessCard('dropoff','Delivery',job.to)}<div class="subhead">Where should we send your quote?</div>${input('name','Your name','text','Full name','autocomplete="name" maxlength="100"')}<div class="two-col">${input('phone','Phone number','tel','Your number','autocomplete="tel" maxlength="40"')}${input('email','Email address (required)','email','you@example.com','autocomplete="email" maxlength="180"')}</div>${check('whatsapp','I am happy to be contacted about my enquiry by WhatsApp.')}<p class="helper">We will review your enquiry and contact you directly.</p><label class="field"><span class="field-label">Anything else we should know? <span class="muted">(optional)</span></span><textarea name="notes" rows="2" maxlength="2000" placeholder="Collection times, access arrangements or anything that might help…">${esc(job.notes)}</textarea></label>${check('acknowledge','I’ve checked both addresses as best I can. I understand the price and job details will be confirmed before booking.')}<p class="soft-note">Submitting sends your details to our team. No booking is made until confirmed.</p>`;
 if(step===0)void attachAddressAutocomplete();
 if(step===1){renderPhotos();wireMobilePhotos();wireVisionConsent();}
 $('#formStep').querySelectorAll('[name]').forEach(el=>{el.addEventListener('input',capture);el.addEventListener('change',()=>{capture();if(el.name.endsWith('.service')||el.name.endsWith('.floor'))renderStep();});});
 $('#addStop')?.addEventListener('click',()=>{capture();if(job.stops.length>=3)return toast('For more than 3 extra stops, add the details in your notes.');job.stops.push('');renderStep();});
 document.querySelectorAll('[data-remove-stop]').forEach(b=>b.onclick=()=>{capture();job.stops.splice(Number(b.dataset.removeStop),1);renderStep();});
 $('#photoInput')?.addEventListener('change',e=>{let errors=[];for(const f of e.target.files){if(photos.reduce((n,p)=>n+p.file.size,0)+f.size>6*1024*1024){errors.push('Photos must total under 6 MB.');break;}if(photos.length>=5){errors.push('Maximum 5 photos.');break;}if(!['image/jpeg','image/png','image/webp'].includes(f.type)){errors.push('Use JPG, PNG or WebP.');continue;}if(f.size>2*1024*1024){errors.push('Each photo must be under 2 MB.');continue;}photos.push({name:f.name,url:URL.createObjectURL(f),file:f});}if(errors.length)toast([...new Set(errors)].join(' '));renderPhotos();e.target.value='';});
}
function accessCard(key,title,address){const a=job[key];return `<section class="address-card"><div class="address-head"${title==='Delivery'?' style="background:#fce9df"':''}><strong>${title}</strong><span>${esc(address)}</span></div><div class="address-body">${choices(key+'.service','Where do you need our help?',[['ready','Ready at entrance','Ground floor, packed and ready'],['indoor','Inside the property','From / to a room or upstairs'],['unsure','Not sure','Please help me decide']])}${a.service==='ready'?'<p class="helper">Standard entrance service assumes level access, no steps and the vehicle within 10 metres. Different access will be reviewed.</p>':''}${a.service==='indoor'?`<div class="two-col">${select(key+'.floor','Which floor?',[['0','Ground floor'],['1','First floor'],['2','Second floor'],['3','Third floor'],['4','Fourth floor'],['5','Fifth floor'],['unknown','Not sure / multiple floors']])}${Number(a.floor)>0?select(key+'.lift','Lift fits all items?',[['yes','Yes — suitable lift'],['no','No — use the stairs'],['unknown','Not sure']]):''}</div>`:''}<div class="two-col">${select(key+'.steps','Steps outside?',[['none','No steps'],['few','1–3 steps'],['many','4 or more steps'],['unknown','Not sure']])}${select(key+'.carry','Vehicle to entrance',Object.entries(labels.carry))}</div>${select(key+'.parking','Can the vehicle stop safely and legally?',[['yes','Yes — loading access available'],['no','No — access is difficult'],['unknown','Not sure']])}${check(key+'.tight','Narrow doors, tight turns or other awkward access')}</div></section>`;}
function renderPhotos(){const p=$('#photos');if(!p)return;p.innerHTML=photos.map((f,i)=>`<div class="photo"><img src="${f.url}" alt="Preview of ${esc(f.name)}"><button type="button" aria-label="Remove ${esc(f.name)}" data-photo="${i}">×</button><span>${esc(f.name)}</span></div>`).join('');p.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const photo=photos[Number(b.dataset.photo)];if(!photo)return;if(photo.mobileId&&mobileSession){b.disabled=true;try{const r=await fetch('/api/mobile-photos/'+mobileSession.id+'/'+photo.mobileId,{method:'DELETE'});if(!r.ok)throw Error('Unable to remove photo');}catch(e){toast(e.message);b.disabled=false;return;}}URL.revokeObjectURL(photo.url);photos=photos.filter(x=>x!==photo);renderPhotos();});}
function validation(){if(step===0){if(job.from.trim().length<3||job.to.trim().length<3)return 'Please add the collection and delivery locations.';if(!job.flexible&&!job.date)return 'Choose a preferred date, or select “My date is flexible”.';if(job.date&&job.date<new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Dublin'}))return 'Please choose today or a future date.';if(job.stops.some(x=>x.trim().length<3))return 'Please complete each extra stop or remove it.';}if(step===1){if(job.description.trim().length<10)return 'Please add a short description of what needs moving.';if(job.listing&&!/^https?:\/\/[^\s]+$/i.test(job.listing))return 'Please use a full listing link beginning with https:// or http://.';}if(step===2){if(job.name.trim().length<2)return 'Please add your name.';if(!job.email.trim())return 'Please provide an email address for your quote.';if(job.whatsapp&&!job.phone.trim())return 'Please add a phone number for WhatsApp updates.';if(job.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email))return 'Please check the email address.';if(job.phone&&job.phone.replace(/\D/g,'').length<7)return 'Please check the phone number.';if(!job.acknowledge)return 'Please confirm that you have checked the details before continuing.';}return '';}

const photoData = file => new Promise((resolve,reject)=>{
 const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read photo.'));reader.readAsDataURL(file);
});
async function compressedPhoto(file){
 const bitmap=await createImageBitmap(file);
 try{
  const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  for(const quality of [.8,.68,.55,.42]){
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
   if(blob&&blob.type==='image/webp'&&blob.size<=450000){
    return {filename:file.name.replace(/\.[^.]+$/,'')+'.webp',mime_type:'image/webp',content_base64:await photoData(blob)};
   }
  }
  throw Error('One photo could not be compressed below 450 KB. Please choose a smaller image.');
 }finally{bitmap.close()}
}
function plainSummary(j){
 const accessSummary=a=>[a.service==='ready'?'Ready at entrance':a.service==='indoor'?'Indoor help':'Not sure',`floor ${a.floor}`,`lift ${a.lift}`,`outside steps ${a.steps}`,`carry ${a.carry}`,`parking ${a.parking}`,`tight access ${a.tight?'yes':'no'}`].join(', ');
 return [
 'VALET REMOVALS — NEW ENQUIRY',
 `Name: ${j.name}`,`Email: ${j.email}`,`Phone: ${j.phone||'Not provided'}`,`WhatsApp contact consent: ${j.whatsapp?'Yes':'No'}`,
 `Collection: ${j.from}`,`Delivery: ${j.to}`,`Extra stops: ${j.stops.join('; ')||'None'}`,
 `Preferred date: ${j.date||'Not specified'}`,`Flexible date: ${j.flexible?'Yes':'No'}`,`Timing: ${j.timing}`,
 `Items: ${j.description}`,`Load: ${j.load}`,`Item type: ${j.itemKind}`,`Assembly: ${j.assembly}`,
 `Listing: ${j.listing||'None'}`,`Collection access: ${accessSummary(j.pickup)}`,`Delivery access: ${accessSummary(j.dropoff)}`,
 `Notes: ${j.notes||'None'}`,`Photos: ${photos.map(p=>p.name).join(', ')||'None'}`
 ].join('\n');
}
async function submitJob(){
 const btn=$('#nextBtn');btn.disabled=true;btn.textContent='Sending enquiry…';$('#formError').hidden=true;
 try{
  await syncMobilePhotos();
  const attachments=await Promise.all(photos.map(async p=>({filename:p.name,mime_type:p.file.type,content_base64:await photoData(p.file)})));
  const payload={source:'Valet Removals Phase 1',type:'removals_enquiry',submitted_at:new Date().toISOString(),plain_text_summary:plainSummary(job),...job,photos:attachments};
  // Save the enquiry before notifying the owner; never claim success if persistence fails.
  const compressed=await Promise.all(photos.map(p=>p.compressed||compressedPhoto(p.file)));
  const saved=await fetch('/api/enquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job,photos:compressed,visionConsent})});
  if(!saved.ok)throw new Error('Unable to save your enquiry ('+saved.status+').');
  const record=await saved.json();
  payload.reference=record.reference;if(record.photoSummary)payload.photoSummary=record.photoSummary;
  const response=await fetch(WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!response.ok)throw new Error('The enquiry service returned '+response.status+'.');
  clearInterval(mobileTimer);mobileSession=null;
  $('#wizard').hidden=true;$('#success').hidden=false;
  $('#success').innerHTML=`<div class="success-icon">✓</div><h2>Thank you, ${esc(job.name)}.</h2><p class="muted">Your enquiry has been submitted. Our team will review your details and contact you with a personalised quote.</p><div style="display:flex;gap:10px;align-items:center;background:#edf7f4;border:1px solid #c7e5dc;border-radius:9px;padding:12px;margin:14px 0;color:#174b43;font-size:14px"><span aria-hidden="true" style="font-size:20px">✓</span><div><strong>Insurance included as standard</strong><div>Goods in transit cover, subject to policy terms, limits and exclusions.</div></div></div>${record.photoSummary?`<div class="soft-note"><strong>AI photo summary</strong><p>${esc(record.photoSummary)}</p><small>Estimated from your photos; our team will review it.</small></div>`:""}<div class="success-summary"><div><span>Collection</span><strong>${esc(job.from)}</strong></div><div><span>Delivery</span><strong>${esc(job.to)}</strong></div><div><span>Email</span><strong>${esc(job.email)}</strong></div></div><button class="button teal" type="button" id="newEnquiry">Send another enquiry</button>`;
  $('#newEnquiry').onclick=()=>{job=blank();visionConsent=false;photos.forEach(p=>URL.revokeObjectURL(p.url));photos=[];step=0;$('#wizard').hidden=false;$('#success').hidden=true;renderStep();};
  $('#quote').scrollIntoView({behavior:'smooth',block:'start'});
 }catch(err){$('#formError').textContent='Your enquiry could not be sent. Please try again. '+err.message;$('#formError').hidden=false;}
 finally{btn.disabled=false;btn.innerHTML='Request my quote <span>↗</span>';}
}
$('#quoteForm').addEventListener('submit',e=>{
 e.preventDefault();capture();const error=validation();
 if(error){$('#formError').textContent=error;$('#formError').hidden=false;return;}
 if(step<2){step++;renderStep();$('#quote').scrollIntoView({behavior:'smooth',block:'start'});}else submitJob();
});
$('#backBtn').onclick=()=>{capture();step--;renderStep();$('#quote').scrollIntoView({behavior:'smooth',block:'start'});};
renderStep();
