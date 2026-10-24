// Pricing defaults and time allowances follow Barry's supplied pricing.js.
export const DEFAULTS=Object.freeze({one:65,two:100,minHours:2,vat:23,small:20,medium:40,large:70,stairs:20,lift:15,carryMid:10,carryLong:20,steps:5,extraStop:20,urgent:15,waitGrace:10});
export const money=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(n);
export function calculate(job,settings=DEFAULTS,overrides={}){
 const s={...DEFAULTS,...settings};
 const o={dispatch:20,travel:30,returnTime:20,crew:'auto',assembly:30,handlingAdjustment:0,equipment:0,expenses:0,extraKm:0,kmRate:.5,routeVerified:false,handlingVerified:false,feasibility:false,...overrides};
 const flags=[],rows=[];const add=(label,minutes)=>{if(minutes>0)rows.push({label,minutes});};
 const load=job.load||'small',scale=({small:1,medium:1.5,large:2.5})[load]||1.5,base=s[load]||s.medium;
 let crew=job.itemKind==='light'&&load==='small'?1:2;if(o.crew==='1'||o.crew==='2')crew=Number(o.crew);
 if(crew===1&&(job.itemKind!=='light'||load!=='small'))flags.push('Confirm a safe crew: this load is not classified as a one-person job.');
 if(job.itemKind==='special')flags.push('Special handling: assess weight, dimensions, equipment and route feasibility.');
 if(job.itemKind==='unknown')flags.push('Item weight and handling requirements are unknown.');
 if(load==='large'||load==='unknown')flags.push('Confirm vehicle space, payload and number of loads.');
 add('Travel to collection',Number(o.dispatch));add('Driving between all stops',Number(o.travel));add('Return / onward travel',Number(o.returnTime));
 for(const key of ['pickup','dropoff']){
  const a=job[key]||{},label=key==='pickup'?'Collection':'Delivery';add(label+' — handling & securing',base);
  if(a.service==='unsure')flags.push(label+': confirm service and access.');
  if(a.service==='ready'&&(a.steps!=='none'||a.carry!=='near'))flags.push(label+': entrance access falls outside the standard ready-to-collect service.');
  if(a.service==='indoor'){
   if(a.floor==='unknown')flags.push(label+': floor level is unknown.');const floors=Number(a.floor)||0;
   if(floors>0){if(a.lift==='yes')add(label+' — lift journeys',Math.ceil(s.lift*scale));else if(a.lift==='no'){add(label+' — '+floors+' floor(s) of stairs',Math.ceil(floors*s.stairs*scale));if(floors>=3)flags.push(label+': review the stair route and workload.');}else flags.push(label+': confirm lift access and item fit.');}
  }
  if(a.steps==='few')add(label+' — external steps',Math.ceil(s.steps*scale));
  if(a.steps==='many'){add(label+' — external steps',Math.ceil(s.steps*3*scale));flags.push(label+': review external steps.');}
  if(a.steps==='unknown')flags.push(label+': external steps are unknown.');
  if(a.carry==='mid')add(label+' — 10–30m carry',Math.ceil(s.carryMid*scale));
  if(a.carry==='long')add(label+' — 30–50m carry',Math.ceil(s.carryLong*scale));
  if(a.carry==='far'||a.carry==='unknown')flags.push(label+': confirm the walking distance and handling allowance.');
  if(a.parking!=='yes')flags.push(label+': confirm lawful loading access.');if(a.tight)flags.push(label+': check narrow doors, corridors or turns.');
 }
 if(job.assembly==='yes')add('Agreed dismantling / reassembly',Number(o.assembly));
 if(job.assembly==='unknown')flags.push('Confirm whether dismantling or reassembly is needed.');
 add('Additional handling agreed after review',Number(o.handlingAdjustment));
 const stops=(job.stops||[]).filter(x=>x.trim());if(stops.length){add('Handling at '+stops.length+' extra stop(s)',stops.length*s.extraStop*scale);flags.push('Verify access and driving time for every additional stop.');}
 if(job.timing==='urgent')flags.push('Confirm urgent / out-of-hours availability.');
 if(!o.routeVerified)flags.push('Route times are placeholders; verify the complete route before quoting.');
 if(!o.handlingVerified)flags.push('Review item quantities, handling time and vehicle capacity before quoting.');
 const rawMinutes=rows.reduce((a,r)=>a+r.minutes,0),billedMinutes=Math.max(s.minHours*60,Math.ceil(rawMinutes/15)*15),rate=crew===1?s.one:s.two,labour=billedMinutes/60*rate,premium=job.timing==='urgent'?labour*s.urgent/100:0,mileage=Number(o.extraKm)*Number(o.kmRate),extras=Number(o.equipment)+Number(o.expenses)+mileage,net=Math.round((labour+premium+extras)*100)/100,tax=Math.round(net*s.vat)/100;
 return {rows,flags:[...new Set(flags)],crew,rate,rawMinutes,billedMinutes,labour,premium,extras,mileage,net,tax,total:Math.round((net+tax)*100)/100,overrides:o,eligible:!!o.routeVerified&&!!o.handlingVerified&&!!o.feasibility&&!(crew===1&&(job.itemKind!=='light'||load!=='small'))};
}
