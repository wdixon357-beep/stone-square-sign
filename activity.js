import { dbAll, dbGet, dbRun, withTransaction } from './db.js';

export const WORK_AREAS={home:'Home',treasury:'Treasurer Reports',minutes:'Meeting Minutes',reports:'Report Generator',reportGenerator:'Report Generator',receivedReports:'Received Reports',queue:'Live Queue',documents:'Live Queue',builder:'Create Dispensation',createDispensation:'Create Dispensation',approvals:'Approvals',proposals:'Propose a Dispensation',proposalReview:'Warden Proposals',dues:'Dues',profile:'Signature Profile',settings:'Service Settings',access:'Officer Access',activity:'Officer Activity',candidateTracker:'Candidate Tracker'};
const actionNames={signed_in:'Signed in',signed_out:'Signed out',device_session_ended:'Ended a device sign-in',other_device_sessions_ended:'Ended other device sign-ins',workspace_opened:'Opened a work area',officer_role_changed:'Changed account role',account_access_revoked:'Revoked account access',officer_invited:'Created account invitation',officer_account_activated:'Activated account',owner_account_created:'Created administrator account',profile_signature_saved:'Saved signature profile',password_reset_requested:'Requested password reset',password_reset_completed:'Completed password reset',treasury_created:'Saved banking information',treasury_edited:'Updated treasurer report',treasury_assigned:'Selected preparing officer',treasury_preparer_attested:'Signed and finalized treasurer report',treasury_distributed:'Recorded report distribution',treasury_deleted:'Deleted unsigned treasurer report',treasury_upload_access_changed:'Changed bank record upload access',treasury_source_downloaded:'Downloaded original banking record',source_downloaded:'Downloaded original banking record',document_opened:'Opened document',document_downloaded:'Downloaded document',minutes_source_handed_off:'Sent meeting source to the Secretaries',minutes_source_claimed:'Claimed meeting source',minutes_claim_released:'Returned meeting source to the shared queue',minutes_draft_created:'Created minutes draft',minutes_draft_saved:'Updated minutes draft',minutes_draft_deleted:'Deleted minutes draft',minutes_preparer_attested:'Attested to minutes',minutes_master_attested:'Approved minutes for distribution',minutes_lodge_approval_recorded:'Recorded Lodge approval of minutes',dues_viewed:'Viewed dues',document_signed:'Signed a document',document_uploaded:'Uploaded a document'};
const iso=()=>new Date().toISOString();
const recordDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value)):value;
export const clientName=req=>req.get('x-stone-square-client')==='mac'?'Mac app':/ipad|tablet/i.test(req.get('user-agent')||'')?'iPad / tablet browser':/iphone|android.*mobile/i.test(req.get('user-agent')||'')?'Phone browser':'Web browser';
export async function initActivitySchema(){
 await dbRun(`CREATE TABLE IF NOT EXISTS activity_sessions (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),auth_hash TEXT UNIQUE NOT NULL,started_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_heartbeat_at TEXT,was_active BOOLEAN NOT NULL DEFAULT FALSE,active_seconds INTEGER NOT NULL DEFAULT 0,client TEXT NOT NULL,last_area TEXT,ended_at TEXT,end_reason TEXT)`);
 await dbRun('CREATE INDEX IF NOT EXISTS activity_sessions_user_time ON activity_sessions(user_id,last_seen_at)');
 await dbRun('CREATE INDEX IF NOT EXISTS audit_events_user_time ON audit_events(user_id,created_at)');
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
   if(area&&area!==previous.last_area)await dbRun('INSERT INTO audit_events (user_id,action,details_json,created_at) VALUES (?,?,?,?)',[req.user.id,'workspace_opened',JSON.stringify({area}),now]);
  });res.json({ok:true});
 }));
 app.get('/api/admin/activity',requireAuth,requireOwner,route(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const days=[1,7,30,90].includes(Number(req.query.days))?Number(req.query.days):30;
  const userId=Number(req.query.userId)||null,cutoff=new Date(Date.now()-days*86400000).toISOString();
  const eventBefore=Number(req.query.eventBefore)||null,sessionBefore=Number(req.query.sessionBefore)||null;
  const users=await dbAll("SELECT id,name,role,access_revoked_at FROM users WHERE email NOT LIKE '%.local' ORDER BY name");
  const clauses=' AND (?::integer IS NULL OR a.user_id=?)';
  const events=await dbAll(`SELECT a.id,a.user_id,a.action,a.created_at,a.document_id,a.details_json,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.created_at>=?${clauses} AND (?::integer IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101`,[cutoff,userId,userId,eventBefore,eventBefore]);
  const sessions=await dbAll(`SELECT a.id,a.user_id,a.started_at,a.first_seen_at,a.last_seen_at,a.last_heartbeat_at,a.was_active,a.active_seconds,a.client,a.last_area,a.ended_at,a.end_reason,u.name AS actor_name FROM activity_sessions a JOIN users u ON u.id=a.user_id WHERE a.last_seen_at>=?${clauses} AND (?::integer IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101`,[cutoff,userId,userId,sessionBefore,sessionBefore]);
  const detailFor=a=>{try{return JSON.parse(a.details_json||'{}')}catch{return {}}};
  const refs=[...new Set(events.flatMap(a=>{const d=detailFor(a);return [a.document_id,d.reportId,d.minutesId].filter(v=>typeof v==='string'&&v.length<200)}))];
  const titles=new Map();
  if(refs.length){
   const placeholders=refs.map(()=>'?').join(',');
   for(const d of await dbAll(`SELECT id,title FROM documents WHERE id IN (${placeholders})`,refs))titles.set(d.id,d.title||'Lodge document');
   for(const m of await dbAll(`SELECT id,meeting_date FROM meeting_minutes WHERE id IN (${placeholders})`,refs))titles.set(m.id,'Meeting minutes'+(m.meeting_date?' · '+recordDate(m.meeting_date):''));
   for(const t of await dbAll(`SELECT id,draft_json FROM treasury_reports WHERE id IN (${placeholders})`,refs)){let period='';try{period=JSON.parse(t.draft_json).periodEnd||''}catch{}titles.set(t.id,'Treasurer report'+(period?' · Period ending '+recordDate(period):''));}
  }
  const safeEvent=a=>{
   let d={};try{d=JSON.parse(a.details_json||'{}')}catch{}
   const reference=a.document_id||d.reportId||d.minutesId||'';
   let detail=reference?titles.get(reference)||'Lodge record':'';
   const target=id=>users.find(u=>u.id===Number(id))?.name||'Account';
   if(a.action==='workspace_opened')detail=Object.hasOwn(WORK_AREAS,d.area)?WORK_AREAS[d.area]:'';
   if(a.action==='officer_role_changed')detail=`${d.name||target(d.userId)}: ${String(d.before||'').replaceAll('_',' ')} → ${String(d.after||'').replaceAll('_',' ')}`;
   if(a.action==='officer_invited')detail=String(d.name||'Invited officer');
   if(a.action==='treasury_assigned')detail+=` · Preparing officer: ${target(d.preparerUserId)}`;
   if(a.action==='treasury_upload_access_changed')detail=`${target(d.userId)} · ${d.enabled?'Upload access granted':'Upload access removed'}`;
   return {id:a.id,userId:a.user_id,actor:a.actor_name||'System',action:a.action,label:actionNames[a.action]||a.action.replaceAll('_',' '),at:a.created_at,detail};
  };
  res.json({users:users.map(u=>({id:u.id,name:u.name,role:u.role,revoked:Boolean(u.access_revoked_at)})),events:events.slice(0,100).map(safeEvent),eventNext:events.length>100?events[99].id:null,sessions:sessions.slice(0,100).map(a=>({id:a.id,userId:a.user_id,actor:a.actor_name,startedAt:a.started_at,firstSeenAt:a.first_seen_at,lastSeenAt:a.last_seen_at,endedAt:a.ended_at,endReason:a.end_reason,activeSeconds:a.active_seconds,measured:Boolean(a.last_heartbeat_at),client:a.client,area:WORK_AREAS[a.last_area]||'',status:a.ended_at?'Ended':Date.now()-Date.parse(a.last_heartbeat_at||a.last_seen_at)>90000?'Away':a.was_active?'Active recently':'Idle'})),sessionNext:sessions.length>100?sessions[99].id:null,measuredFrom:(await dbGet('SELECT MIN(first_seen_at) AS first FROM activity_sessions'))?.first||null});
 }));
}
