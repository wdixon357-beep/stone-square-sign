import assert from 'node:assert/strict';
import express from 'express';
process.env.DATABASE_URL='';process.env.PGLITE_DIR='';process.env.NODE_ENV='test';
const {connect,close,initSchema,dbRun,dbGet,dbAll}=await import('../db.js');
const {initializeBuildingCalendar,mountBuildingCalendar,validDate,calendarEvent}=await import('../building-calendar.js');
let listener,checks=0;
const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name);};
const baseEvent={title:'Synthetic Lodge event',startDate:'2026-09-20',endDate:'2026-09-20',startTime:'',endTime:'',allDay:false,category:'lodge'};
await connect();
try{
 await initSchema();await initializeBuildingCalendar();
 async function user(label,role,permissions,email=label+'@example.org'){return(await dbRun('INSERT INTO users(email,password_hash,name,role,created_at,permissions_json) VALUES(?,?,?,?,?,?)',[email,'unused-test-password',label,role,new Date().toISOString(),JSON.stringify(permissions)])).lastID;}
 const owner=await user('building-owner','owner',[]),reader=await user('building-reader','officer',['building.view','calendar.view']),outsider=await user('building-outsider','officer',['building.view','building.decide','calendar.view']),manager=await user('calendar-manager','officer',['calendar.view','calendar.manage']),none=await user('building-none','officer',[]),designated=await user('synthetic-designated-warden','warden',['building.view','building.decide'],'designated-warden@example.org');
 const secretary=await user('William M. McDuffie','secretary',['building.view'],'secretary-test@example.org');
 const assistant=await user('Adrian Reese','assistant_secretary',['building.view'],'assistant-test@example.org');
 await dbRun('INSERT INTO profile_signatures (user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',[owner,Buffer.from('synthetic-signature'),'drawn',new Date().toISOString()]);
 await dbRun('INSERT INTO profile_signatures (user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',[designated,Buffer.from('synthetic-signature'),'drawn',new Date().toISOString()]);
 for(const officer of [secretary,assistant])await dbRun('INSERT INTO profile_signatures (user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',[officer,Buffer.from('synthetic-signature'),'drawn',new Date().toISOString()]);
 let sourceMode='ok',portalRejectIdentity=false,portalConflict=false,storeAvailable=true;const remoteCalls=[];
 let busy=[{date:'2026-09-17',start:'19:30',end:'21:00',label:'Stone Square Lodge Stated Meeting',status:'approved'},{date:'2026-09-21',start:'19:00',end:'20:00',label:'Synthetic visiting Chapter',status:'approved'},{date:'2026-09-21',start:'19:00',end:'20:00',label:'Synthetic visiting Chapter',status:'approved'},{date:'2026-09-22',start:'',end:'',label:'Synthetic pending request',status:'pending',ref:'SSL-TEST'},{date:'2026-13-99',label:'Invalid source date',status:'approved'}];
 const app=express();app.use(express.json());
 mountBuildingCalendar(app,{requireAuth:async(req,res,next)=>{req.user=await dbGet('SELECT * FROM users WHERE id=?',[Number(req.get('x-test-user'))||-1]);if(!req.user)return res.status(401).json({error:'Sign in'});req.authRawToken=req.get('x-cookie-session')||String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');next();},fetcher:async(url,init)=>{
  remoteCalls.push({url,init});assert.equal(new URL(url).origin,'https://request.stonesquare22pha.org');
  if(url.includes('/api/calendar')){if(sourceMode==='fail')throw Error('Synthetic unavailable feed');if(sourceMode==='malformed')return new Response('{}',{status:200});return Response.json({busy,warning:sourceMode==='warning'?'Calendar source reports incomplete data.':undefined});}
  if(url.includes('decide='))return portalRejectIdentity?Response.json({error:'Designated officer only'},{status:403}):portalConflict?Response.json({error:'Request changed'},{status:409}):Response.json({ok:true,request:{id:'SSL-TEST',status:'approved',revision:'next'}});
  if(url.includes('attest='))return Response.json({ok:true,request:{id:'SSL-TEST',status:'approved',agreementStatus:'fully_executed'}});
  return Response.json({store:storeAvailable,requests:[{id:'SSL-TEST',organization:'Synthetic organization',revision:'old',status:'pending'}]});
 }});
 app.use((error,req,res,next)=>res.status(error.statusCode||500).json({error:error.message}));
 listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));const origin=`http://127.0.0.1:${listener.address().port}`;
 async function api(path,id,method='GET',body){const response=await fetch(origin+path,{method,headers:{...(id?{'x-test-user':String(id),Authorization:'Bearer synthetic-session'}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};}
 const calendar='/api/lodge-calendar?from=2026-09-01&to=2026-09-30';
 for(const path of ['/api/building/requests',calendar]){check('Anonymous cannot read '+path,(await api(path)).status===401);check('Missing capability cannot read '+path,(await api(path,none)).status===403);}
 const read=await api('/api/building/requests',reader);check('Reader receives requests without decision authority',read.status===200&&!read.data.canDecide);
 check('Decision capability alone cannot impersonate designated decision officer',!(await api('/api/building/requests',outsider)).data.canDecide);
 const callsBefore=remoteCalls.length;
 check('Wrong identity cannot decide despite capability',(await api('/api/building/requests/SSL-TEST/decision',outsider,'POST',{decision:'approved',revision:'old'})).status===403);
 check('Reader cannot decide',(await api('/api/building/requests/SSL-TEST/decision',reader,'POST',{decision:'approved',revision:'old'})).status===403);
 check('Unauthorized decisions never reach portal',remoteCalls.length===callsBefore);
 check('Decision rejects missing revision',(await api('/api/building/requests/SSL-TEST/decision',owner,'POST',{decision:'approved'})).status===400);
 check('Decision rejects unsupported status',(await api('/api/building/requests/SSL-TEST/decision',owner,'POST',{decision:'cancelled',revision:'old'})).status===400);
 portalConflict=true;check('Portal revision conflict propagates',(await api('/api/building/requests/SSL-TEST/decision',owner,'POST',{decision:'approved',revision:'old'})).status===409);portalConflict=false;
 check('Owner decision reaches existing portal',(await api('/api/building/requests/SSL-TEST/decision',owner,'POST',{decision:'approved',note:'Synthetic note',revision:'old'})).status===200);
 check('Authorized designated officer can decide',(await api('/api/building/requests/SSL-TEST/decision',designated,'POST',{decision:'denied',revision:'old'})).status===200);
 portalRejectIdentity=true;check('Private portal identity rejection propagates for a capable warden',(await api('/api/building/requests/SSL-TEST/decision',designated,'POST',{decision:'approved',revision:'old'})).status===403);portalRejectIdentity=false;
 check('Bridge preserves requester authorization',remoteCalls.at(-1).init.headers.Authorization==='Bearer synthetic-session');
 check('Non-Secretary officer cannot attest',(await api('/api/building/requests/SSL-TEST/attest',reader,'POST',{revision:'old'})).status===403);
 for(const [officer,label] of [[secretary,'Secretary'],[assistant,'Assistant Secretary']]){
  check(label+' attestation reaches the agreement portal',(await api('/api/building/requests/SSL-TEST/attest',officer,'POST',{revision:'old'})).status===200);
  check(label+' uses that officer’s saved signature',JSON.parse(remoteCalls.at(-1).init.body).signatureData.startsWith('data:image/png;base64,'));
 }
 const cookieRead=await fetch(origin+'/api/building/requests',{headers:{'x-test-user':String(reader),'x-cookie-session':'verified-cookie-session'}});
 check('Website cookie session is forwarded to the building portal as a verified bearer',cookieRead.status===200&&remoteCalls.at(-1).init.headers.Authorization==='Bearer verified-cookie-session');
 await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify(['building.view']),designated]);check('Designated identity still requires decision capability',(await api('/api/building/requests/SSL-TEST/decision',designated,'POST',{decision:'approved',revision:'old'})).status===403);
 storeAvailable=false;check('Missing reservation storage is not an empty successful queue',(await api('/api/building/requests',owner)).status===503);storeAvailable=true;
 for(const method of ['POST','PUT','DELETE'])check('Reader cannot mutate calendar via '+method,(await api('/api/lodge-calendar'+(method==='POST'?'':'/unknown'),reader,method,baseEvent)).status===403);
 check('Impossible dates rejected',!validDate('2026-02-30')&&validDate('2028-02-29'));
 for(const body of [{...baseEvent,startDate:'2026-02-30'},{...baseEvent,endDate:'2026-09-19'},{...baseEvent,startTime:'25:00'},{...baseEvent,endTime:'19:00'},{...baseEvent,startTime:'20:00',endTime:'19:00'},{...baseEvent,category:'building'},{...baseEvent,sourceUrl:'javascript:alert(1)'}])check('Invalid calendar event rejected',(await api('/api/lodge-calendar',manager,'POST',body)).status===400);
 check('Oversized calendar range rejected',(await api('/api/lodge-calendar?from=2026-01-01&to=2028-01-01',reader)).status===400);
 const created=await api('/api/lodge-calendar',manager,'POST',baseEvent);check('Manager can create a custom event',created.status===201&&created.data.event.revision==='1');const event=created.data.event;
 check('Reader cannot edit rendered custom event',(await api(calendar,reader)).data.events.find(item=>item.id===event.id).editable===false);
 const writes=await Promise.all(['First edit','Second edit'].map(title=>api('/api/lodge-calendar/'+event.id,manager,'PUT',{...baseEvent,title,revision:'1'})));check('Concurrent stale edits have one winner',writes.map(r=>r.status).sort().join(',')==='200,409');
 check('Stale delete rejected',(await api('/api/lodge-calendar/'+event.id,manager,'DELETE',{revision:'1'})).status===409);
 check('Missing delete revision rejected',(await api('/api/lodge-calendar/'+event.id,manager,'DELETE')).status===409);
 check('Current delete succeeds',(await api('/api/lodge-calendar/'+event.id,manager,'DELETE',{revision:'2'})).status===200);
 check('Deleted record disappears',(await api(calendar,reader)).data.events.every(item=>item.id!==event.id));
 check('Source event cannot be edited',(await api('/api/lodge-calendar/building:SSL-TEST',manager,'PUT',{...baseEvent,revision:'1'})).status===404);
 await api('/api/lodge-calendar',manager,'POST',{...baseEvent,title:'Stone Square Stated Communication',startDate:'2026-09-17',endDate:'2026-09-17',startTime:'19:30',endTime:'21:00'});
 let merged=(await api(calendar,reader)).data;
 check('Duplicate feed records collapse',merged.events.filter(item=>item.title==='Synthetic visiting Chapter').length===1);
 check('Custom stated meeting replaces duplicate standing block',merged.events.filter(item=>item.startDate==='2026-09-17').length===1);
 check('Pending building entries remain pending and read only',merged.events.some(item=>item.id==='building:SSL-TEST'&&item.status==='pending'&&!item.editable));
 check('Invalid source dates excluded',merged.events.every(item=>validDate(item.startDate)));
 sourceMode='fail';merged=(await api(calendar,reader)).data;check('Feed failure preserves Lodge events and warns availability is unknown',merged.events.some(item=>item.category==='lodge')&&merged.warnings.some(message=>message.includes('not confirmation')));
 sourceMode='malformed';check('Malformed feed produces source warning',(await api(calendar,reader)).data.warnings.length>0);
 sourceMode='warning';check('Source warning reaches calendar',(await api(calendar,reader)).data.warnings.includes('Calendar source reports incomplete data.'));
 const audits=await dbAll('SELECT action FROM audit_events');check('Successful changes have audit records',audits.filter(row=>row.action==='building_request_decided').length===2&&audits.some(row=>row.action==='lodge_calendar_event_updated')&&audits.some(row=>row.action==='lodge_calendar_event_removed'));
 check('Blank unknown times are not silently all-day',calendarEvent(baseEvent).allDay===false);
 check('Explicit all-day is preserved',calendarEvent({...baseEvent,allDay:true}).allDay===true);
 console.log(`PASS ${checks} isolated building/calendar checks; no live portal or production database used.`);
}finally{if(listener)await new Promise(resolve=>listener.close(resolve));await close();}
