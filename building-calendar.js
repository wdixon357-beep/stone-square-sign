import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { hasPermission } from './access-control.js';
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const DATE=/^\d{4}-\d{2}-\d{2}$/;const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function validDate(value){return typeof value==='string'&&DATE.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
export function calendarEvent(input){
 const s=(key,max=500)=>String(input?.[key]??'').trim().slice(0,max);
 const title=s('title',200),startDate=s('startDate'),endDate=s('endDate')||startDate,startTime=s('startTime'),endTime=s('endTime');
 if(!title||!validDate(startDate)||!validDate(endDate)||endDate<startDate)throw fail(400,'Enter an event title and valid start and end dates.');
 if((startTime&&!TIME.test(startTime))||(endTime&&!TIME.test(endTime))||(endTime&&!startTime)||(startDate===endDate&&startTime&&endTime&&endTime<=startTime))throw fail(400,'Check the event times. End time must follow start time.');
 const category=s('category')||'lodge',status=s('status')||'scheduled';
 if(!['lodge','jurisdiction','community'].includes(category)||!['scheduled','tentative','cancelled'].includes(status))throw fail(400,'Choose an available event category and status.');
 const sourceUrl=s('sourceUrl',2000);if(sourceUrl){try{if(!['https:','http:'].includes(new URL(sourceUrl).protocol))throw Error();}catch{throw fail(400,'Use a valid event information link.');}}
 return {title,startDate,endDate,startTime,endTime,allDay:Boolean(input?.allDay)&&!startTime,location:s('location',500),description:s('description',10000),category,status,source:s('source',300)||'Lodge calendar',sourceUrl};
}
export function buildingSubmission(input,user) {
 const text=(key,max)=>String(input?.[key]??'').trim().slice(0,max);
 const submissionId=text('submissionId',64);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId))throw fail(400,'Start a new building request before submitting.');
 const purpose=text('purpose',1000),phone=text('phone',40);
 if(!purpose)throw fail(400,'Describe the event or activity.');
 const spaces=Array.isArray(input?.spaces)?[...new Set(input.spaces)]:[];
 if(!spaces.length||spaces.some(v=>!['Lodge building','Back yard','Front yard'].includes(v)))throw fail(400,'Select the spaces you need.');
 const frontYardOnly=spaces.length===1&&spaces[0]==='Front yard';
 if(frontYardOnly&&typeof input?.bathroomAccess!=='boolean')throw fail(400,'Choose whether you will need restroom access.');
 const bathroomAccess=frontYardOnly?input.bathroomAccess:null;
 if(!Array.isArray(input?.bookings)||input.bookings.length<1||input.bookings.length>12)throw fail(400,'Include between one and twelve dates.');
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
 const bookings=input.bookings.map(b=>({date:String(b?.date||''),start:String(b?.start||''),end:String(b?.end||'')}));
 if(bookings.some(b=>!validDate(b.date)||b.date<today||!TIME.test(b.start)||!TIME.test(b.end)||b.end<=b.start))throw fail(400,'Use valid upcoming dates and an end time later than the start time.');
 if(new Set(bookings.map(b=>b.date)).size!==bookings.length)throw fail(400,'List each date only once.');
 if(!user?.name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email||''))throw fail(400,'Your officer account needs a name and valid email address.');
 return {org:'Stone Square Lodge No. 22',name:user.name,contact:user.email,phone,purpose,spaces,bathroomAccess,bookings:bookings.sort((a,b)=>a.date.localeCompare(b.date)),clientSubmissionKey:crypto.createHash('sha256').update(String(user.id)+':'+submissionId).digest('hex')};
}
export async function initializeBuildingCalendar(){await dbRun(`CREATE TABLE IF NOT EXISTS lodge_calendar_events (id TEXT PRIMARY KEY,event_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT)`);}
const showEvent=(r,editable)=>({...JSON.parse(r.event_json),id:r.id,revision:String(r.revision),editable});
const audit=(req,action,details)=>dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',[req.user.id,action,req.ip,JSON.stringify(details),new Date().toISOString()]);
const PORTAL='https://request.stonesquare22pha.org';
export function mountBuildingCalendar(app,{requireAuth,fetcher=fetch}){
 const permit=key=>(req,res,next)=>hasPermission(req.user,key)?next():res.status(403).json({error:'This area or action is not enabled for your account.'});
 const remote=async(path,req,body)=>{
  const response=await fetcher(PORTAL+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(18000),headers:{Authorization:`Bearer ${req.authRawToken}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  let payload;try{payload=await response.json();}catch{throw fail(502,'Building Requests could not be reached. Try again shortly.');}
  if(!response.ok)throw fail([400,401,403,404,409].includes(response.status)?response.status:502,payload.error||'Building Requests could not be loaded.');
  return payload;
 };
 const availability=async(from,to)=>{
  if(!validDate(from)||!validDate(to)||to<from||(Date.parse(to)-Date.parse(from))/86400000>370)throw fail(400,'Choose a calendar range of no more than one year.');
  try{const response=await fetcher(PORTAL+'/api/calendar?from='+from+'&to='+to,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const data=await response.json();if(!Array.isArray(data.busy))throw Error();return {busy:data.busy,warning:data.warning||null};}
  catch{return {busy:[],warning:'Building availability could not be fully checked. Your request will need a conflict review before approval.'};}
 };
 app.get('/api/building/availability',requireAuth,permit('building.request'),async(req,res,next)=>{try{res.setHeader('Cache-Control','no-store');res.json(await availability(String(req.query.from||''),String(req.query.to||'')));}catch(e){next(e)}});
 app.post('/api/building/requests',requireAuth,permit('building.request'),async(req,res,next)=>{try{
  const body=buildingSubmission(req.body,req.user);
  // An existing reference wins over a new availability check on a retry, because
  // the request's own pending hold otherwise appears to conflict with itself.
  const prior=await remote('/api/reservation?submission='+body.clientSubmissionKey+'&fingerprint='+crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),req);
  if(prior.ok&&Array.isArray(prior.refs)&&prior.refs.length){res.json(prior);return;}
  const calendar=await availability(body.bookings[0].date,body.bookings.at(-1).date);
  const conflict=body.bookings.find(b=>calendar.busy.some(e=>e.date===b.date&&e.status!=='denied'&&(e.allDay||(e.start&&e.end&&e.start<b.end&&e.end>b.start))));
  if(calendar.busy.some(e=>body.bookings.some(b=>b.date===e.date)&&e.status!=='denied'&&!e.allDay&&(!e.start||!e.end)))calendar.warning=[calendar.warning,'Some calendar entries have incomplete times and need review before approval.'].filter(Boolean).join(' ');
  if(conflict)throw fail(409,'The building calendar shows a booking or pending hold on '+conflict.date+'. Choose another time.');
  if(calendar.warning&&req.body.acknowledgeAvailabilityWarning!==true)throw fail(400,'Availability is incomplete. Review and acknowledge the warning before submitting.');
  const result=await remote('/api/reservation',req,body);
  if(!result.ok||!Array.isArray(result.refs)||!result.refs.length)throw fail(502,'The request outcome could not be confirmed. Keep this form and try again to retrieve its reference.');
  await audit(req,'building_request_submitted',{refs:result.refs,dates:body.bookings.map(b=>b.date)});
  res.status(201).json(result);
 }catch(e){next(e)}});
 app.get('/api/building/requests',requireAuth,permit('building.view'),async(req,res,next)=>{try{const payload=await remote('/api/reservation?list&dashboard=1',req);if(!Array.isArray(payload.requests)||payload.store===false)throw fail(503,'Building request storage is temporarily unavailable.');res.setHeader('Cache-Control','no-store');res.json({requests:payload.requests,canDecide:hasPermission(req.user,'building.decide')&&(req.user.role==='owner'||req.user.role==='warden')});}catch(e){next(e)}});
 app.post('/api/building/requests/:id/decision',requireAuth,permit('building.decide'),async(req,res,next)=>{try{
  if(req.user.role!=='owner'&&req.user.role!=='warden')throw fail(403,'Building decisions are assigned to the Worshipful Master and Xavier White.');
  const {decision,note,revision,authorization}=req.body||{};if(!['approved','denied'].includes(decision)||typeof revision!=='string'||!revision)throw fail(400,'Review the current request before choosing a decision.');
  let signatureData=null;
  if(decision==='approved'){
   const signature=await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?',[req.user.id]);
   if(!signature?.signature_bytes)throw fail(409,'Save your signature profile before approving this agreement.');
   signatureData='data:image/png;base64,'+Buffer.from(signature.signature_bytes).toString('base64');
  }
  const payload=await remote('/api/reservation?dashboard=1&decide='+encodeURIComponent(req.params.id),req,{decision,note:String(note||'').slice(0,3000),revision,authorization,signatureData});
  await audit(req,'building_request_decided',{id:req.params.id,decision});res.json(payload);
 }catch(e){next(e)}});
 app.post('/api/building/requests/:id/attest',requireAuth,async(req,res,next)=>{try{
  if(!['secretary','assistant_secretary'].includes(req.user.role))throw fail(403,'This attestation is assigned to a Secretary officer.');
  const {revision}=req.body||{};if(typeof revision!=='string'||!revision)throw fail(400,'Review the current agreement before attesting.');
  const signature=await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?',[req.user.id]);if(!signature?.signature_bytes)throw fail(409,'Save your signature profile before attesting.');
  const payload=await remote('/api/reservation?dashboard=1&attest='+encodeURIComponent(req.params.id),req,{revision,signatureData:'data:image/png;base64,'+Buffer.from(signature.signature_bytes).toString('base64')});
  await audit(req,'building_agreement_attested',{id:req.params.id});res.json(payload);
 }catch(e){next(e)}});
 app.get('/api/lodge-calendar',requireAuth,permit('calendar.view'),async(req,res,next)=>{try{
  const from=String(req.query.from||''),to=String(req.query.to||'');if(!validDate(from)||!validDate(to)||to<from||(Date.parse(to)-Date.parse(from))/86400000>370)throw fail(400,'Choose a calendar range of no more than one year.');
  const rows=await dbAll('SELECT * FROM lodge_calendar_events WHERE deleted_at IS NULL ORDER BY created_at');
  const custom=rows.map(r=>showEvent(r,hasPermission(req.user,'calendar.manage'))).filter(e=>e.startDate<=to&&e.endDate>=from);
  const warnings=[];let building=[];
  try{const r=await fetcher(PORTAL+'/api/calendar?from='+from+'&to='+to,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();const data=await r.json();if(!Array.isArray(data.busy))throw Error();
   if(data.warning)warnings.push(data.warning);
   building=data.busy.filter(b=>validDate(b.date)&&b.date>=from&&b.date<=to).map(b=>({id:'building:'+String(b.ref||crypto.createHash('sha256').update(JSON.stringify([b.date,b.start,b.end,b.label])).digest('hex').slice(0,20)),title:String(b.label||'Building reservation'),startDate:b.date,endDate:b.date,startTime:b.start||'',endTime:b.end||'',allDay:Boolean(b.allDay),location:'208 East Lake Street, Middletown, DE 19709',description:b.status==='pending'?'Building request pending approval.':'Building calendar entry.',category:'building',status:b.status==='pending'?'pending':b.status==='denied'?'cancelled':'scheduled',source:'Building calendar',sourceUrl:'',editable:false}));
  }catch{warnings.push('The building calendar is temporarily unavailable. Lodge events are still shown; this is not confirmation that the building is free.');}
  // Enrich stated-meeting dates from the Lodge template without showing the
  // same standing building entry again. Keep all other organizations and holds.
  const customStated=new Set(custom.filter(e=>e.category==='lodge'&&/Stone Square.*stated (meeting|communication)/i.test(e.title)&&e.status!=='cancelled').map(e=>e.startDate));
  const seen=new Set();const events=[...custom,...building.filter(e=>!(customStated.has(e.startDate)&&/Stone Square.*Stated/i.test(e.title)))].filter(e=>{const k=[e.startDate,e.endDate,e.startTime,e.endTime,e.location.trim().toLowerCase(),e.title.trim().toLowerCase(),e.status].join('|');if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>(a.startDate+a.startTime+a.title).localeCompare(b.startDate+b.startTime+b.title));
  res.setHeader('Cache-Control','no-store');res.json({events,warnings,timezone:'America/New_York'});
 }catch(e){next(e)}});
 app.post('/api/lodge-calendar',requireAuth,permit('calendar.manage'),async(req,res,next)=>{try{const event=calendarEvent(req.body),id=crypto.randomUUID(),now=new Date().toISOString();await withTransaction(async()=>{await dbRun('INSERT INTO lodge_calendar_events (id,event_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?)',[id,JSON.stringify(event),req.user.id,now,now]);await audit(req,'lodge_calendar_event_created',{id,title:event.title,startDate:event.startDate});});res.status(201).json({event:{...event,id,revision:'1',editable:true}});}catch(e){next(e)}});
 app.put('/api/lodge-calendar/:id',requireAuth,permit('calendar.manage'),async(req,res,next)=>{try{const event=calendarEvent(req.body);let revision;await withTransaction(async()=>{const old=await dbGet('SELECT * FROM lodge_calendar_events WHERE id=? AND deleted_at IS NULL FOR UPDATE',[req.params.id]);if(!old)throw fail(404,'This Lodge event was not found.');if(String(req.body.revision||'')!==String(old.revision))throw fail(409,'This event changed. Reload it before saving your edits.');revision=Number(old.revision)+1;await dbRun('UPDATE lodge_calendar_events SET event_json=?,revision=?,updated_at=? WHERE id=?',[JSON.stringify(event),revision,new Date().toISOString(),old.id]);await audit(req,'lodge_calendar_event_updated',{id:old.id,before:JSON.parse(old.event_json),after:event});});res.json({event:{...event,id:req.params.id,revision:String(revision),editable:true}});}catch(e){next(e)}});
 app.delete('/api/lodge-calendar/:id',requireAuth,permit('calendar.manage'),async(req,res,next)=>{try{await withTransaction(async()=>{const old=await dbGet('SELECT * FROM lodge_calendar_events WHERE id=? AND deleted_at IS NULL FOR UPDATE',[req.params.id]);if(!old)throw fail(404,'This Lodge event was not found.');if(String(req.query.revision||req.body?.revision||'')!==String(old.revision))throw fail(409,'This event changed. Reload it before removing it.');await dbRun('UPDATE lodge_calendar_events SET deleted_at=?,revision=revision+1 WHERE id=?',[new Date().toISOString(),old.id]);await audit(req,'lodge_calendar_event_removed',{id:old.id,event:JSON.parse(old.event_json)});});res.json({ok:true});}catch(e){next(e)}});
}
