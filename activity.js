import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';

export const WORK_AREAS={home:'Home',building:'Building Requests',lodgeCalendar:'Lodge Calendar',calendar:'Lodge Calendar',treasury:'Treasurer Reports',minutes:'Meeting Minutes',agenda:'Agenda Creator',reports:'Report Generator',reportGenerator:'Report Generator',receivedReports:'Received Reports',queue:'Live Queue',documents:'Live Queue',builder:'Create Dispensation',createDispensation:'Create Dispensation',approvals:'Approvals',proposals:'My Dispensation Proposals',proposalReview:'Warden Proposals',dues:'Dues Ledger',myDues:'My Dues',suggestions:'Suggestion Box',profile:'Signature Profile',settings:'My Settings',access:'Officer Access',memberAccess:'Member Access',activity:'Dashboard Activity',candidateTracker:'Candidate Tracker'};
const actionNames={signed_in:'Signed in',signed_out:'Signed out',device_session_ended:'Ended a device sign-in',other_device_sessions_ended:'Ended other device sign-ins',workspace_opened:'Opened a work area',dashboard_interaction:'Dashboard interaction',officer_role_changed:'Changed account role',account_access_revoked:'Revoked account access',officer_invited:'Created account invitation',officer_account_activated:'Activated account',owner_account_created:'Created administrator account',profile_signature_saved:'Saved signature profile',password_reset_requested:'Requested password reset',password_reset_completed:'Completed password reset',treasury_created:'Saved banking information',treasury_edited:'Updated treasurer report',treasury_assigned:'Selected preparing officer',treasury_preparer_attested:'Signed and finalized treasurer report',treasury_distributed:'Recorded report distribution',treasury_deleted:'Deleted unsigned treasurer report',treasury_upload_access_changed:'Changed bank record upload access',treasury_source_downloaded:'Downloaded original banking record',source_downloaded:'Downloaded original banking record',document_opened:'Opened document',document_downloaded:'Downloaded document',minutes_source_handed_off:'Sent meeting source to the Secretaries',minutes_source_claimed:'Claimed meeting source',minutes_claim_released:'Returned meeting source to the shared queue',minutes_draft_created:'Created minutes draft',minutes_draft_saved:'Updated minutes draft',minutes_draft_deleted:'Deleted minutes draft',minutes_preparer_attested:'Attested to minutes',minutes_master_attested:'Approved minutes for distribution',minutes_lodge_approval_recorded:'Recorded Lodge approval of minutes',dues_viewed:'Viewed dues',document_signed:'Signed a document',document_uploaded:'Uploaded a document',officer_report_received:'Submitted a Lodge report',officer_report_viewed:'Viewed a submitted Lodge report',historical_report_viewed:'Viewed a historical Lodge record'};
const iso=()=>new Date().toISOString();
const recordDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value)):value;
export const clientName=req=>req.get('x-stone-square-client')==='mac'?'Mac app':/ipad|tablet/i.test(req.get('user-agent')||'')?'iPad / tablet browser':/iphone|android.*mobile/i.test(req.get('user-agent')||'')?'Phone browser':'Web browser';
export async function initActivitySchema(){
 await dbRun(`CREATE TABLE IF NOT EXISTS activity_sessions (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),auth_hash TEXT UNIQUE NOT NULL,started_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_heartbeat_at TEXT,was_active BOOLEAN NOT NULL DEFAULT FALSE,active_seconds INTEGER NOT NULL DEFAULT 0,client TEXT NOT NULL,last_area TEXT,ended_at TEXT,end_reason TEXT)`);
 await dbRun(`CREATE TABLE IF NOT EXISTS activity_area_time (session_id INTEGER NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,area TEXT NOT NULL,active_seconds INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,area))`);
 await dbRun('CREATE INDEX IF NOT EXISTS activity_sessions_user_time ON activity_sessions(user_id,last_seen_at)');
 await dbRun('CREATE INDEX IF NOT EXISTS audit_events_user_time ON audit_events(user_id,created_at)');
 await dbRun(`CREATE TABLE IF NOT EXISTS app_incidents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  client TEXT NOT NULL,
  area TEXT,
  request_path TEXT NOT NULL,
  request_method TEXT NOT NULL,
  status_code INTEGER,
  category TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  recovered_at TEXT
 )`);
 await dbRun('CREATE INDEX IF NOT EXISTS app_incidents_time ON app_incidents(last_seen_at)');
 await dbRun('CREATE INDEX IF NOT EXISTS app_incidents_user_time ON app_incidents(user_id,last_seen_at)');
}

const incidentReference=()=>`SS22-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const safeIncidentPath=value=>{
 const path=String(value||'/').split('?')[0].slice(0,240);
 return path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig,':record').replace(/\/\d+(?=\/|$)/g,'/:record');
};
const safeIncidentArea=value=>Object.hasOwn(WORK_AREAS,value)?WORK_AREAS[value]:String(value||'Dashboard').replace(/[^a-z0-9 ._-]/ig,'').slice(0,80)||'Dashboard';
export async function recordAppIncident({reference,userId,client,area,path,method,status,category,state}){
 const ref=/^SS22-[A-Z0-9]{6,16}$/.test(String(reference||''))?String(reference):incidentReference();
 const now=iso(),nextState=state==='recovered'?'recovered':'open';
 const existing=await dbGet('SELECT id FROM app_incidents WHERE reference=?',[ref]);
 if(existing){
  await dbRun('UPDATE app_incidents SET state=?,last_seen_at=?,recovered_at=CASE WHEN ? = \'recovered\' THEN ? ELSE recovered_at END WHERE reference=?',[nextState,now,nextState,now,ref]);
 }else{
  await dbRun(`INSERT INTO app_incidents (reference,user_id,client,area,request_path,request_method,status_code,category,state,first_seen_at,last_seen_at,recovered_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[ref,userId||null,String(client||'Unknown client').slice(0,60),safeIncidentArea(area),safeIncidentPath(path),String(method||'GET').toUpperCase().slice(0,10),Number.isInteger(Number(status))?Number(status):null,String(category||'request_failed').replace(/[^a-z0-9_-]/ig,'').slice(0,60)||'request_failed',nextState,now,now,nextState==='recovered'?now:null]);
 }
 return ref;
}
export async function startActivitySession(userId,hash,req){const now=iso();await dbRun('INSERT INTO activity_sessions (user_id,auth_hash,started_at,first_seen_at,last_seen_at,client) VALUES (?,?,?,?,?,?) ON CONFLICT(auth_hash) DO NOTHING',[userId,hash,now,now,now,clientName(req)]);}
export async function endActivitySession(hash,reason){await dbRun('UPDATE activity_sessions SET ended_at=?,end_reason=?,was_active=FALSE WHERE auth_hash=? AND ended_at IS NULL',[iso(),reason,hash]);}
export async function endUserActivity(userId,reason){await dbRun('UPDATE activity_sessions SET ended_at=?,end_reason=?,was_active=FALSE WHERE user_id=? AND ended_at IS NULL',[iso(),reason,userId]);}
// Only consecutive foreground, recently-interacted-with intervals count. Long gaps,
// background polling and a remembered login do not count as time spent working.
export function measuredSeconds(previous,active,now=Date.now()){
 const gap=now-Date.parse(previous.last_heartbeat_at||'');
 return active&&previous.was_active&&gap>=0&&gap<=90000?Math.floor(gap/1000):0;
}
export function mountActivityRoutes(app,{requireAuth,requireOwner,rateLimit}){
 const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 app.post('/api/activity/heartbeat',requireAuth,rateLimit({key:'activity-heartbeat',maximum:2400,windowMs:3600000}),route(async(req,res)=>{
  const active=req.body.active===true,area=Object.hasOwn(WORK_AREAS,req.body.area)?req.body.area:null,now=iso();
  await withTransaction(async()=>{
   await dbRun('INSERT INTO activity_sessions (user_id,auth_hash,first_seen_at,last_seen_at,client) VALUES (?,?,?,?,?) ON CONFLICT(auth_hash) DO NOTHING',[req.user.id,req.authTokenHash,now,now,clientName(req)]);
   const previous=await dbGet('SELECT * FROM activity_sessions WHERE auth_hash=? FOR UPDATE',[req.authTokenHash]);
   if(previous.ended_at)return;
   const seconds=measuredSeconds(previous,active,Date.parse(now));
   await dbRun('UPDATE activity_sessions SET last_seen_at=?,last_heartbeat_at=?,was_active=?,active_seconds=active_seconds+?,last_area=COALESCE(?,last_area),client=? WHERE id=?',[now,now,active,seconds,area,clientName(req),previous.id]);
   if(seconds>0&&Object.hasOwn(WORK_AREAS,previous.last_area||''))await dbRun('INSERT INTO activity_area_time (session_id,area,active_seconds) VALUES (?,?,?) ON CONFLICT(session_id,area) DO UPDATE SET active_seconds=activity_area_time.active_seconds+EXCLUDED.active_seconds',[previous.id,previous.last_area,seconds]);
   if(area&&area!==previous.last_area)await dbRun('INSERT INTO audit_events (user_id,action,details_json,created_at) VALUES (?,?,?,?)',[req.user.id,'workspace_opened',JSON.stringify({area}),now]);
  });res.json({ok:true});
 }));
 app.post('/api/activity/interaction',requireAuth,rateLimit({key:'activity-interaction',maximum:1200,windowMs:3600000}),route(async(req,res)=>{
  const kind=['activate','scroll'].includes(req.body?.kind)?req.body.kind:null;
  const area=Object.hasOwn(WORK_AREAS,req.body?.area)?req.body.area:null;
  const target=String(req.body?.target||'').replace(/\s+/g,' ').trim().slice(0,120);
  if(!kind||!area||(kind==='activate'&&!target))return res.status(400).json({error:'Choose a valid dashboard interaction.'});
  await dbRun('INSERT INTO audit_events (user_id,action,details_json,created_at) VALUES (?,?,?,?)',[req.user.id,'dashboard_interaction',JSON.stringify({kind,area,target:kind==='activate'?target:''}),iso()]);
  res.json({ok:true});
 }));
 app.post('/api/activity/incidents',requireAuth,rateLimit({key:'activity-incidents',maximum:120,windowMs:3600000}),route(async(req,res)=>{
  const reference=await recordAppIncident({reference:req.body?.reference,userId:req.user.id,client:clientName(req),area:req.body?.area,path:req.body?.path,method:req.body?.method,status:req.body?.status,category:req.body?.category,state:req.body?.state});
  res.status(201).json({reference});
 }));
 app.get('/api/admin/activity',requireAuth,requireOwner,route(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const days=[1,7,30,90].includes(Number(req.query.days))?Number(req.query.days):30;
  const userId=Number(req.query.userId)||null,cutoff=new Date(Date.now()-days*86400000).toISOString();
  const eventBefore=Number(req.query.eventBefore)||null,sessionBefore=Number(req.query.sessionBefore)||null;
  const users=await dbAll("SELECT id,name,role,roster_id,access_revoked_at FROM users WHERE email NOT LIKE '%.local' ORDER BY name");
  const clauses=' AND (?::integer IS NULL OR a.user_id=?)';
  const events=await dbAll(`SELECT a.id,a.user_id,a.action,a.created_at,a.document_id,a.details_json,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.created_at>=?${clauses} AND (?::integer IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101`,[cutoff,userId,userId,eventBefore,eventBefore]);
  const sessions=await dbAll(`SELECT a.id,a.user_id,a.started_at,a.first_seen_at,a.last_seen_at,a.last_heartbeat_at,a.was_active,a.active_seconds,a.client,a.last_area,a.ended_at,a.end_reason,u.name AS actor_name FROM activity_sessions a JOIN users u ON u.id=a.user_id WHERE a.last_seen_at>=?${clauses} AND (?::integer IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101`,[cutoff,userId,userId,sessionBefore,sessionBefore]);
  const incidents=await dbAll(`SELECT i.id,i.reference,i.user_id,i.client,i.area,i.request_path,i.request_method,i.status_code,i.category,i.state,i.first_seen_at,i.last_seen_at,i.recovered_at,u.name AS actor_name FROM app_incidents i LEFT JOIN users u ON u.id=i.user_id WHERE i.last_seen_at>=? AND (?::integer IS NULL OR i.user_id=?) ORDER BY CASE WHEN i.state='open' THEN 0 ELSE 1 END,i.last_seen_at DESC LIMIT 200`,[cutoff,userId,userId]);
  const detailFor=a=>{try{return JSON.parse(a.details_json||'{}')}catch{return {}}};
  const refs=[...new Set(events.flatMap(a=>{const d=detailFor(a);return [a.document_id,d.reportId,d.minutesId,d.archiveId].filter(v=>typeof v==='string'&&v.length<200)}))];
  const titles=new Map();
  if(refs.length){
   const placeholders=refs.map(()=>'?').join(',');
   for(const d of await dbAll(`SELECT id,title FROM documents WHERE id IN (${placeholders})`,refs))titles.set(d.id,d.title||'Lodge document');
   for(const m of await dbAll(`SELECT id,meeting_date FROM meeting_minutes WHERE id IN (${placeholders})`,refs))titles.set(m.id,'Meeting minutes'+(m.meeting_date?' · '+recordDate(m.meeting_date):''));
   for(const t of await dbAll(`SELECT id,draft_json FROM treasury_reports WHERE id IN (${placeholders})`,refs)){let period='';try{period=JSON.parse(t.draft_json).periodEnd||''}catch{}titles.set(t.id,'Treasurer report'+(period?' · Period ending '+recordDate(period):''));}
   for(const r of await dbAll(`SELECT id,title FROM officer_reports WHERE id IN (${placeholders})`,refs))titles.set(r.id,r.title||'Submitted Lodge report');
   for(const h of await dbAll(`SELECT id,title FROM historical_reports WHERE id IN (${placeholders})`,refs))titles.set(h.id,h.title||'Historical Lodge record');
  }
  const safeEvent=a=>{
   let d={};try{d=JSON.parse(a.details_json||'{}')}catch{}
   const reference=a.document_id||d.reportId||d.minutesId||d.archiveId||'';
   let detail=reference?titles.get(reference)||'Lodge record':'';
   const target=id=>users.find(u=>u.id===Number(id))?.name||'Account';
   if(a.action==='workspace_opened')detail=Object.hasOwn(WORK_AREAS,d.area)?WORK_AREAS[d.area]:'';
   if(a.action==='dashboard_interaction')detail=`${d.kind==='scroll'?'Scrolled through':'Clicked'} ${WORK_AREAS[d.area]||'Dashboard'}${d.target?' · '+d.target:''}`;
   if(a.action==='officer_role_changed')detail=`${d.name||target(d.userId)}: ${String(d.before||'').replaceAll('_',' ')} → ${String(d.after||'').replaceAll('_',' ')}`;
   if(a.action==='officer_invited')detail=String(d.name||'Invited officer');
   if(a.action==='treasury_assigned')detail+=` · Preparing officer: ${target(d.preparerUserId)}`;
   if(a.action==='treasury_upload_access_changed')detail=`${target(d.userId)} · ${d.enabled?'Upload access granted':'Upload access removed'}`;
   return {id:a.id,userId:a.user_id,actor:a.actor_name||'System',action:a.action,label:actionNames[a.action]||a.action.replaceAll('_',' '),at:a.created_at,detail};
  };
  const visibleSessions=sessions.slice(0,100),sessionIds=visibleSessions.map(a=>a.id),areaTimes=new Map();
  if(sessionIds.length){const placeholders=sessionIds.map(()=>'?').join(',');for(const row of await dbAll(`SELECT session_id,area,active_seconds FROM activity_area_time WHERE session_id IN (${placeholders}) ORDER BY active_seconds DESC`,sessionIds)){if(!areaTimes.has(row.session_id))areaTimes.set(row.session_id,[]);areaTimes.get(row.session_id).push({area:WORK_AREAS[row.area]||row.area,seconds:row.active_seconds});}}
  res.json({users:users.map(u=>({id:u.id,name:u.name,role:u.role,rosterLinked:Boolean(u.roster_id),revoked:Boolean(u.access_revoked_at)})),events:events.slice(0,100).map(safeEvent),eventNext:events.length>100?events[99].id:null,sessions:visibleSessions.map(a=>({id:a.id,userId:a.user_id,actor:a.actor_name,startedAt:a.started_at,firstSeenAt:a.first_seen_at,lastSeenAt:a.last_seen_at,endedAt:a.ended_at,endReason:a.end_reason,activeSeconds:a.active_seconds,measured:Boolean(a.last_heartbeat_at),client:a.client,area:WORK_AREAS[a.last_area]||'',areas:areaTimes.get(a.id)||[],status:a.ended_at?'Ended':Date.now()-Date.parse(a.last_heartbeat_at||a.last_seen_at)>90000?'Away':a.was_active?'Active recently':'Idle'})),sessionNext:sessions.length>100?sessions[99].id:null,incidents:incidents.map(i=>({id:i.id,reference:i.reference,userId:i.user_id,actor:i.actor_name||'Unknown account',client:i.client,area:i.area||'Dashboard',path:i.request_path,method:i.request_method,status:i.status_code,state:i.state,category:i.category,firstSeenAt:i.first_seen_at,lastSeenAt:i.last_seen_at,recoveredAt:i.recovered_at})),measuredFrom:(await dbGet('SELECT MIN(first_seen_at) AS first FROM activity_sessions'))?.first||null});
 }));
}
