import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL='';process.env.PGLITE_DIR='';process.env.NODE_ENV='test';
const {connect,close,initSchema,dbRun,dbGet,dbAll}=await import('../db.js');
const {initializeBuildingCalendar,mountBuildingCalendar,validDate,calendarEvent}=await import('../building-calendar.js');
const {initBuildingStoreSchema}=await import('../building-store.js');
const {createAssistantService,initAssistantSchema,rotateAssistantToken}=await import('../assistant-access.js');
const {installAssistantGateway}=await import('../assistant-gateway.js');
const {mountAssistantMcp}=await import('../assistant-mcp.js');
let listener,reviewListener,checks=0;
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
 const requireAuth=async(req,res,next)=>{
  if(req.assistant)return next();
  req.user=await dbGet('SELECT * FROM users WHERE id=?',[Number(req.get('x-test-user'))||-1]);
  if(!req.user)return res.status(401).json({error:'Sign in'});
  req.authRawToken=req.get('x-cookie-session')||String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
  next();
 };
 const fetcher=async(url,init)=>{
  remoteCalls.push({url,init});assert.equal(new URL(url).origin,'https://request.stonesquare22pha.org');
  if(url.includes('/api/calendar')){if(sourceMode==='fail')throw Error('Synthetic unavailable feed');if(sourceMode==='malformed')return new Response('{}',{status:200});return Response.json({busy,gcalConnected:sourceMode==='ok',warning:sourceMode==='warning'?'Calendar source reports incomplete data.':undefined});}
  if(url.includes('decide='))return portalRejectIdentity?Response.json({error:'Designated officer only'},{status:403}):portalConflict?Response.json({error:'Request changed'},{status:409}):Response.json({ok:true,request:{id:'SSL-TEST',status:'approved',revision:'next'}});
  if(url.includes('attest='))return Response.json({ok:true,request:{id:'SSL-TEST',status:'approved',agreementStatus:'fully_executed'}});
  return Response.json({store:storeAvailable,requests:[{id:'SSL-TEST',organization:'Synthetic organization',revision:'old',status:'pending'}]});
 };
 const handleError=(error,req,res,next)=>res.status(error.statusCode||500).json({error:error.message});
 const app=express();app.use(express.json());
 mountBuildingCalendar(app,{requireAuth,fetcher});
 app.use(handleError);
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

 await initBuildingStoreSchema();
 await initAssistantSchema();
 await createAssistantService({ownerUserId:owner,permissions:['building.view','calendar.view']});
 const {token:museToken}=await rotateAssistantToken(owner);
 const limitedOwner=await user('limited-building-owner','owner',[]);
 await createAssistantService({ownerUserId:limitedOwner,permissions:['calendar.view']});
 const {token:limitedToken}=await rotateAssistantToken(limitedOwner);
 const buildingOnlyOwner=await user('building-only-owner','owner',[]);
 await createAssistantService({ownerUserId:buildingOnlyOwner,permissions:['building.view']});
 const {token:buildingOnlyToken}=await rotateAssistantToken(buildingOnlyOwner);
 const reviewApp=express();
 installAssistantGateway(reviewApp,{expectedOrigin:()=>origin});
 reviewApp.use(express.json());
 mountBuildingCalendar(reviewApp,{requireAuth,fetcher});
 reviewListener=reviewApp.listen(0,'127.0.0.1');await new Promise(resolve=>reviewListener.once('listening',resolve));
 const reviewOrigin=`http://127.0.0.1:${reviewListener.address().port}`;
 mountAssistantMcp(reviewApp,{requireAuth,port:reviewListener.address().port});
 reviewApp.use(handleError);
 await dbRun("UPDATE building_store_state SET state='ready' WHERE id=1");
 const createdAt='2026-09-20T13:15:00.000Z', decisionAt='2026-09-21T13:15:00.000Z';
 const booking={id:'SSL-REVIEW',org:'Synthetic organization',date:'2026-09-22',start:'19:00',end:'22:01',status:'pending',
  createdAt,receiptSent:true,wmNotified:false,wmNotifiedAt:createdAt,wardenNotified:true,wardenNotifiedAt:createdAt,
  requesterNotifiedAt:decisionAt,statusAccessHash:'PRIVATE_STATUS',paymentUrl:'PRIVATE_PAYMENT',
  agreement:{signatureData:'PRIVATE_SIGNATURE',text:'PRIVATE_TERMS'}};
 const coincident={id:'SSL-COINCIDENT',org:booking.org,date:booking.date,start:booking.start,end:booking.end,status:'pending'};
 const rescheduled={id:'SSL-INCOMPLETE',org:booking.org,date:'2026-09-31',start:'19:00:12',end:'22:01',status:'approved',
  createdAt:'2026-02-30T13:15:00.000Z',requesterNotified:true,requesterNotifiedAt:decisionAt};
 const storeReservationFixture=async records=>{
  const value=JSON.stringify(records),digest=crypto.createHash('sha256').update(value).digest('hex');
  await dbRun(`INSERT INTO building_store_entries (key,value_text,value_sha256,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT (key) DO UPDATE SET value_text=excluded.value_text,value_sha256=excluded.value_sha256,revision=building_store_entries.revision+1`,
  ['resv:all',value,digest,1,createdAt,createdAt]);
 };
 await storeReservationFixture([booking,coincident,rescheduled]);
 const anonymousBooking={date:booking.date,start:booking.start,end:booking.end,label:booking.org,status:'pending',source:'reservation'};
 const adjacent={date:booking.date,start:'22:01',end:'23:00',label:'Adjacent meeting',source:'gcal',status:'approved'};
 const readReview=async(id='SSL-REVIEW',headers={Authorization:`Bearer ${museToken}`})=>{
  const response=await fetch(reviewOrigin+'/api/building/requests/'+id+'/review',{headers});
  return {status:response.status,data:await response.json(),cacheControl:response.headers.get('Cache-Control')};
 };
 const reviewBaseline=await dbAll('SELECT * FROM building_store_entries');
 const auditBaseline=await dbAll('SELECT * FROM audit_events');
 sourceMode='ok';busy=[anonymousBooking,anonymousBooking,adjacent];
 const portalReadsBefore=remoteCalls.length;
 check('Review rejects non-Muse and ungranted credentials before portal reads',(await readReview('SSL-REVIEW',{'x-test-user':String(owner)})).status===403&&(await readReview('SSL-REVIEW',{Authorization:`Bearer ${limitedToken}`})).status===403&&remoteCalls.length===portalReadsBefore);
 const museWrite=await fetch(reviewOrigin+'/api/building/requests/SSL-REVIEW/decision',{method:'POST',headers:{Authorization:`Bearer ${museToken}`,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved',revision:'old'})});
 check('Muse review permission does not permit deciding a Building Request',museWrite.status===403&&remoteCalls.length===portalReadsBefore);
 const reviewed=await readReview();
 check('Review preserves the exact authority revision and Eastern time without granting decisions',reviewed.status===200&&reviewed.cacheControl==='private, no-store'&&reviewed.data.readOnly&&!reviewed.data.canDecide&&reviewed.data.request.revision===crypto.createHash('sha256').update(JSON.stringify(booking)).digest('hex')&&reviewed.data.dateTime.start==='7:00 PM'&&reviewed.data.dateTime.end==='10:01 PM'&&reviewed.data.dateTime.timezone==='America/New_York');
 check('Initial and decision notices stay separate, with absent delivery evidence unknown',reviewed.data.request.createdAt===createdAt&&reviewed.data.request.requesterNotified===null&&reviewed.data.request.notices.requesterReceipt.sent===true&&reviewed.data.request.notices.requesterReceipt.sentAt===null&&reviewed.data.request.notices.worshipfulMasterSubmission.sent===false&&reviewed.data.request.notices.worshipfulMasterSubmission.sentAt===null&&reviewed.data.request.notices.wardenSubmission.sentAt===createdAt&&reviewed.data.request.notices.requesterDecision.sentAt===null);
 check('Review excludes only the exact reservation and still detects another identical hold',reviewed.data.availability.status==='overlap'&&reviewed.data.availability.overlaps.length===1&&reviewed.data.availability.overlaps[0].reference===coincident.id&&reviewed.data.availability.limitations.length===0);
 check('Review omits private data and reaches the calendar without a session credential',!JSON.stringify(reviewed.data).includes('PRIVATE_')&&new URL(remoteCalls.at(-1).url).searchParams.get('from')===booking.date&&!remoteCalls.at(-1).init.headers?.Authorization);
 const mcpReview=await fetch(reviewOrigin+'/api/assistant/mcp',{method:'POST',headers:{Authorization:`Bearer ${museToken}`,'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read',arguments:{path:'/api/building/requests/SSL-REVIEW/review'}}})});
 const mcpResult=(await mcpReview.json()).result;
 check('Muse MCP receives the same exact read without an owner browser session',mcpReview.status===200&&!mcpResult?.isError&&JSON.stringify(JSON.parse(mcpResult.content[0].text))===JSON.stringify(reviewed.data));
 const invalidReview=await readReview(rescheduled.id);
 check('Malformed request time is unknown, separate valid decision notice is retained',invalidReview.status===200&&invalidReview.data.request.createdAt===null&&invalidReview.data.request.notices.requesterDecision.sentAt===decisionAt&&invalidReview.data.availability.status==='incomplete'&&invalidReview.data.dateTime.date===null&&invalidReview.data.dateTime.start===null);
 check('Read-only review leaves the archive and audit records untouched',JSON.stringify(await dbAll('SELECT * FROM building_store_entries'))===JSON.stringify(reviewBaseline)&&JSON.stringify(await dbAll('SELECT * FROM audit_events'))===JSON.stringify(auditBaseline));
 check('Unknown record returns not found',(await readReview('SSL-MISSING')).status===404);

 await storeReservationFixture([booking]);
 busy=[anonymousBooking,adjacent];
 check('A request does not overlap itself or an immediately adjacent booking',(await readReview()).data.availability.status==='no_recorded_overlap');
 busy=[anonymousBooking,anonymousBooking,adjacent];
 check('A stale or differently observed reservation snapshot prevents a clear schedule claim',(await readReview()).data.availability.status==='incomplete');
 busy=[anonymousBooking,adjacent,{date:booking.date,allDay:true,status:'approved',source:'gcal',label:'All-day stay',id:'PRIVATE_ID',newField:'PRIVATE_INPUT'}];
 const allDayReview=(await readReview()).data.availability;
 check('An all-day calendar block is an overlap and returns only allowlisted data',allDayReview.status==='overlap'&&allDayReview.overlaps[0]?.allDay&&allDayReview.overlaps[0]?.reference===null&&!JSON.stringify(allDayReview).includes('PRIVATE_'));
 const manualFixture=async(id,fields={},deletedAt=null)=>{
  const event=calendarEvent({...baseEvent,title:id,startDate:booking.date,endDate:booking.date,
   startTime:'20:00',endTime:'21:00',location:'208 E. Lake St., Middletown, DE 19709',...fields});
  await dbRun('INSERT INTO lodge_calendar_events (id,event_json,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?)',[id,JSON.stringify(event),createdAt,createdAt,deletedAt]);
 };
 busy=[anonymousBooking,adjacent];
 await manualFixture('on-site-adjacent',{startTime:'22:01',endTime:'23:00'});
 await manualFixture('on-site-cancelled',{status:'cancelled'});
 await manualFixture('on-site-deleted',{},createdAt);
 await manualFixture('explicitly-remote',{location:'Virtual'});
 await manualFixture('explicitly-off-site',{location:'500 Example Avenue, Dover, DE 19901'});
 check('Excluded manual events do not block the booking when cancelled, deleted, off-site, or immediately adjacent',(await readReview()).data.availability.status==='no_recorded_overlap');
 await manualFixture('on-site-potential',{status:'tentative'});
 await manualFixture('multi-day-last',{startDate:'2026-09-21',endTime:'19:01',location:'Stone Square Lodge No. 22'});
 await manualFixture('multi-day-first',{endDate:'2026-09-23',startTime:'21:59'});
 await manualFixture('multi-day-middle',{startDate:'2026-09-21',endDate:'2026-09-23'});
 await manualFixture('multi-day-all-day-ending',{startDate:'2026-09-21',startTime:'',endTime:'',allDay:true});
 await manualFixture('multi-day-ending-at-midnight',{startDate:'2026-09-21',endTime:'00:00'});
 const manualBaseline=await dbAll('SELECT * FROM lodge_calendar_events ORDER BY id');
 const manualReview=(await readReview()).data.availability;
 const manualHolds=new Map(manualReview.overlaps.map(hold=>[hold.reference,hold]));
 check('Known on-site manual bookings appear with Eastern times and their recorded status',manualReview.status==='overlap'&&manualReview.limitations.length===0&&manualHolds.get('on-site-potential')?.source==='lodge_calendar'&&manualHolds.get('on-site-potential')?.status==='tentative'&&manualHolds.get('on-site-potential')?.start==='8:00 PM');
 check('Manual event ranges cover the first, interior, and inclusive last date with precise boundaries',manualHolds.size===5&&manualHolds.get('multi-day-first')?.start==='9:59 PM'&&manualHolds.get('multi-day-last')?.end==='7:01 PM'&&manualHolds.get('multi-day-middle')?.allDay&&manualHolds.get('multi-day-all-day-ending')?.allDay&&!manualHolds.has('multi-day-ending-at-midnight'));
 const buildingOnlyReview=(await readReview(booking.id,{Authorization:`Bearer ${buildingOnlyToken}`})).data.availability;
 check('A Building Requests-only service cannot read manual calendar details or claim a clear schedule',buildingOnlyReview.status==='incomplete'&&buildingOnlyReview.overlaps.length===0&&buildingOnlyReview.limitations.some(message=>message.includes('Lodge Calendar access'))&&!JSON.stringify(buildingOnlyReview).includes('on-site-potential'));
 check('Reviewing manual calendar conflicts does not change the source records',JSON.stringify(await dbAll('SELECT * FROM lodge_calendar_events ORDER BY id'))===JSON.stringify(manualBaseline));
 await dbRun("UPDATE lodge_calendar_events SET deleted_at=? WHERE id IN ('on-site-potential','multi-day-last','multi-day-first','multi-day-middle','multi-day-all-day-ending')",[createdAt]);
 await manualFixture('unknown-location',{location:'Check venue'});
 await manualFixture('unknown-time',{startTime:'',endTime:''});
 const uncertainManualReview=(await readReview()).data.availability;
 check('A manual event with an unknown location or time prevents a clear availability claim',uncertainManualReview.status==='incomplete'&&uncertainManualReview.overlaps.length===0&&uncertainManualReview.limitations.some(message=>message.includes('unverified location'))&&uncertainManualReview.limitations.some(message=>message.includes('uncertain time')));
 await dbRun("UPDATE lodge_calendar_events SET deleted_at=? WHERE id IN ('unknown-location','unknown-time')",[createdAt]);
 await manualFixture('ambiguous-campus-address',{location:'208 Lake Street, Middletown, DE 19709'});
 check('An incomplete Lodge address is not treated as an off-site venue',(await readReview()).data.availability.limitations.some(message=>message.includes('unverified location')));
 await dbRun("UPDATE lodge_calendar_events SET deleted_at=? WHERE id='ambiguous-campus-address'",[createdAt]);
 busy=[anonymousBooking,adjacent];sourceMode='warning';
 check('Calendar warning prevents an apparent clear schedule',(await readReview()).data.availability.status==='incomplete');
 sourceMode='disconnected';
 check('A disconnected feed without a warning still prevents a clear schedule claim',(await readReview()).data.availability.status==='incomplete');
 const disconnectedBuildingOnly=(await readReview(booking.id,{Authorization:`Bearer ${buildingOnlyToken}`})).data.availability;
 check('Independent calendar source limitations are both reported',disconnectedBuildingOnly.limitations.some(message=>message.includes('connected calendar feed'))&&disconnectedBuildingOnly.limitations.some(message=>message.includes('Lodge Calendar access')));
 sourceMode='fail';
 check('Unavailable calendar never reports a clear schedule',(await readReview()).data.availability.status==='incomplete');
 console.log(`PASS ${checks} isolated building/calendar checks; no live portal or production database used.`);
}finally{for(const server of [listener,reviewListener])if(server)await new Promise(resolve=>server.close(resolve));await close();}
