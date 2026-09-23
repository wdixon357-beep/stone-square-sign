import crypto from 'node:crypto';
import multer from 'multer';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { normalizeTreasury, calculateTreasury } from './treasury.js';
import { hasPermission, resolvePermissions } from './access-control.js';
import { generateTreasuryDraft } from './treasury-ai.js';
import { readTreasurySources } from './treasury-source.js';
import { buildTreasuryPdf } from './treasury-pdf.js';
import { easternDate, treasuryReportingWindow, treasuryWindowForDraft, applyTreasuryMeetingCycle } from './treasury-period.js';
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const bytes = v => v ? Buffer.from(v) : null;
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:12*1024*1024, files:5, fields:6, fieldSize:180000 }, fileFilter:(_req,file,done)=>/\.(pdf|png|jpe?g|txt)$/i.test(file.originalname)?done(null,true):done(error(400,'Choose a PDF, PNG, JPG or TXT file.')) });
const uploadFields = upload.fields([{name:'files',maxCount:5},{name:'checkingFiles',maxCount:5},{name:'savingsFiles',maxCount:5}]);
const fileList = files => Array.isArray(files) ? files : Object.values(files||{}).flat();
export const treasuryPeriodCovered = (pending, finalizedDrafts = []) => {
  const start=String(pending?.periodStart||''),end=String(pending?.periodEnd||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))return false;
  return finalizedDrafts.some(draft=>{
    const finalStart=String(draft?.periodStart||''),finalEnd=String(draft?.periodEnd||'');
    return /^\d{4}-\d{2}-\d{2}$/.test(finalStart)&&/^\d{4}-\d{2}-\d{2}$/.test(finalEnd)
      &&finalStart<=start&&finalEnd>=end;
  });
};
async function accountSources(req) {
  const legacy=Array.isArray(req.files)?req.files:fileList(req.files?.files);
  const checking=fileList(req.files?.checkingFiles),savings=fileList(req.files?.savingsFiles);
  if(!checking.length&&!savings.length&&!String(req.body.checkingSourceText||'').trim()&&!String(req.body.savingsSourceText||'').trim()){
    const source=await readTreasurySources(legacy,req.body.sourceText);
    return {...source,files:legacy.map(file=>({file,accountLabel:''}))};
  }
  const groups=[];
  for(const [label,files,typed] of [['Checking',checking,req.body.checkingSourceText],['Savings',savings,req.body.savingsSourceText]]){
    if(!files.length&&!String(typed||'').trim())continue;
    const source=await readTreasurySources(files,typed,{minimumLength:3});
    groups.push({label,source,files});
  }
  if(legacy.length||String(req.body.sourceText||'').trim()){
    const source=await readTreasurySources(legacy,req.body.sourceText);
    groups.push({label:'Additional banking information',source,files:legacy});
  }
  const text=groups.map(({label,source})=>`Application account assignment: ${label}.\n${label} account\n${source.text}`).join('\n\n');
  return {
    text,
    names:groups.flatMap(({label,source})=>source.names.map(name=>`${label}: ${name}`)),
    notes:groups.flatMap(({label,source})=>source.notes.map(note=>`${label}: ${note}`)),
    files:groups.flatMap(({label,files})=>files.map(file=>({file,accountLabel:label}))),
  };
}
const serial = row => {const draft=normalizeTreasury(JSON.parse(row.draft_json));return { preparerUserId:row.preparer_user_id, supersededByReportId:row.superseded_by_report_id||null, uploadedBy:row.uploader_name||row.preparer_name, id:row.id, status:row.status, revision:row.revision, createdByUserId:row.created_by_user_id, createdBy:row.preparer_name, preparerRole:row.preparer_role, updatedAt:row.updated_at, draft, submittedDraft:row.submitted_json?normalizeTreasury(JSON.parse(row.submitted_json)):null, calculation:calculateTreasury(draft), preparerAttestedAt:row.preparer_attested_at };};
const fetchRecord = id => dbGet('SELECT * FROM treasury_reports WHERE id = ? AND deleted_at IS NULL',[id]);
const canPrepare = user => hasPermission(user,'treasury.prepare');
// A report has exactly one active editor. The administrator can take over through the
// assignment route, which immediately removes the previous preparer's write access.
const editable = (row,user) => canPrepare(user)&&row.status==='draft'&&row.preparer_user_id===user.id;
const canOpenWorkingReport = (row,user) => user.role==='owner'
  || row.created_by_user_id===user.id
  || row.preparer_user_id===user.id
  || (canPrepare(user)&&row.status==='awaiting_preparer'&&row.preparer_user_id===null);
const canReadSource = canOpenWorkingReport;
const finalized = row => ['ready_for_distribution','distributed'].includes(row.status)&&Boolean(row.preparer_attested_at&&row.submitted_json);
const signedSnapshot = row => dbGet("SELECT draft_json,signature_bytes FROM treasury_attestations WHERE report_id=? AND phase='preparer' ORDER BY created_at DESC,id DESC LIMIT 1",[row.id]);
const finalSql = "status IN ('ready_for_distribution','distributed') AND preparer_attested_at IS NOT NULL AND submitted_json IS NOT NULL AND EXISTS (SELECT 1 FROM treasury_attestations a WHERE a.report_id=treasury_reports.id AND a.phase='preparer')";
async function currentTreasuryReportingWindow(reference=easternDate()) {
  const rows=await dbAll("SELECT a.draft_json FROM treasury_attestations a JOIN treasury_reports r ON r.id=a.report_id WHERE a.phase='preparer' AND r.deleted_at IS NULL AND r.status IN ('ready_for_distribution','distributed')");
  return treasuryReportingWindow(reference,rows.map(row=>JSON.parse(row.draft_json).periodEnd));
}
async function visibleReport(row,user) {
  if(user.role==='owner'||(canPrepare(user)&&(row.preparer_user_id===user.id||(row.status==='awaiting_preparer'&&row.preparer_user_id===null))))return serial(row);
  const snapshot=finalized(row)?await signedSnapshot(row):null;
  const draft=snapshot?normalizeTreasury(JSON.parse(snapshot.draft_json)):normalizeTreasury();
  draft.sourceNames=[];draft.unmappedLines=[];draft.extractionNotes=[];
  // Keep the shared client shape, without exposing a working draft or its source.
  return {...serial({...row,draft_json:JSON.stringify(draft),submitted_json:null}),submittedDraft:null};
}
export async function treasuryAccess(user) {
  return canPrepare(user)?'prepare':hasPermission(user,'treasury.upload')?'upload':hasPermission(user,'treasury.view')?'view':null;
}
export async function initTreasurySchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_reports (
    id TEXT PRIMARY KEY, draft_json TEXT NOT NULL, source_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id), preparer_name TEXT NOT NULL, preparer_role TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_json TEXT, changes_json TEXT,
    preparer_attested_at TEXT, master_attested_at TEXT, master_name TEXT, deleted_at TEXT)`);
  await dbRun('ALTER TABLE treasury_reports ADD COLUMN IF NOT EXISTS preparer_user_id INTEGER REFERENCES users(id)');
  await dbRun('ALTER TABLE treasury_reports ADD COLUMN IF NOT EXISTS uploader_name TEXT');
  await dbRun('ALTER TABLE treasury_reports ADD COLUMN IF NOT EXISTS superseded_by_report_id TEXT REFERENCES treasury_reports(id)');
  await dbRun('ALTER TABLE treasury_reports ADD COLUMN IF NOT EXISTS superseded_at TEXT');
  await dbRun("UPDATE treasury_reports SET preparer_user_id=created_by_user_id,uploader_name=preparer_name WHERE uploader_name IS NULL");
  await dbRun('CREATE TABLE IF NOT EXISTS treasury_upload_access (user_id INTEGER PRIMARY KEY REFERENCES users(id), granted_by INTEGER NOT NULL REFERENCES users(id), granted_at TEXT NOT NULL)');
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_sources (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES treasury_reports(id), name TEXT NOT NULL, mime TEXT NOT NULL, bytes BYTEA NOT NULL)`);
  await dbRun("ALTER TABLE treasury_sources ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT ''");
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_attestations (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES treasury_reports(id), phase TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), draft_json TEXT NOT NULL, signature_bytes BYTEA NOT NULL, created_at TEXT NOT NULL)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_alert_dismissals (
    report_id TEXT NOT NULL REFERENCES treasury_reports(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (report_id,user_id)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_period_lock (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL)`);
  await dbRun("INSERT INTO treasury_period_lock (id,updated_at) VALUES (1,?) ON CONFLICT(id) DO NOTHING",[new Date().toISOString()]);
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  // Correct drafts created under the former upcoming-meeting rule exactly once.
  // A draft's corrected window remains frozen after this migration.
  await withTransaction(async()=>{
    const key='rolling_report_window_2026_09_15',applied=await dbGet('SELECT key FROM treasury_migrations WHERE key=? FOR UPDATE',[key]);
    if(applied)return;
    const today=easternDate(),currentWindow=await currentTreasuryReportingWindow(today),time=new Date().toISOString();
    for(const row of await dbAll("SELECT id,draft_json FROM treasury_reports WHERE deleted_at IS NULL AND status IN ('draft','awaiting_preparer')")){
      const saved=normalizeTreasury(JSON.parse(row.draft_json));
      if(!saved.periodEnd||saved.periodEnd<=today)continue;
      const revised=normalizeTreasury(applyTreasuryMeetingCycle(saved,currentWindow));
      await dbRun('UPDATE treasury_reports SET draft_json=?,revision=revision+1,updated_at=? WHERE id=?',[JSON.stringify(revised),time,row.id]);
    }
    await dbRun('INSERT INTO treasury_migrations (key,applied_at) VALUES (?,?)',[key,time]);
  });
  // Preserve existing upload grants once; an explicit permissions selection always wins.
  for(const user of await dbAll('SELECT u.* FROM users u JOIN treasury_upload_access g ON g.user_id=u.id WHERE u.permissions_json IS NULL')){
    const permissions=[...new Set([...resolvePermissions(user),'treasury.view','treasury.upload'])];
    await dbRun('UPDATE users SET permissions_json=? WHERE id=? AND permissions_json IS NULL',[JSON.stringify(permissions),user.id]);
  }
}
export function mountTreasuryRoutes(app,{requireAuth,rateLimit,sendEmail,baseUrl,broadcast,generationFor=()=>undefined}) {
  const access=async(req,res,next)=>{try{req.treasuryAccess=await treasuryAccess(req.user);return req.treasuryAccess?next():res.status(403).json({error:'Treasurer report access has not been assigned to this account.'});}catch(e){next(e);}};
  app.use('/api/treasury',requireAuth,access,(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const route=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
  const requirePrepare=(req,_res,next)=>canPrepare(req.user)?next():next(error(403,'Treasurer report preparation access is required.'));
  const requireUpload=(req,_res,next)=>hasPermission(req.user,'treasury.upload')?next():next(error(403,'Bank record upload access is required to provide statements, screenshots or banking notes.'));
  const reportingWindow=()=>currentTreasuryReportingWindow();
  const record=async req=>{
    const row=await fetchRecord(req.params.id);
    const visible=row&&(canOpenWorkingReport(row,req.user)||(hasPermission(req.user,'treasury.view')&&finalized(row)&&await signedSnapshot(row)));
    if(!visible)throw error(404,'Treasurer report not found.');return row;
  };
  const revision=(req,row)=>{if(req.body?.revision!==row.revision)throw error(409,'This report changed in another window. Reopen it before saving or signing.');};
  const audit=async(req,id,action,details={})=>dbRun('INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',[req.user.id,`treasury_${action}`,req.ip,req.get('user-agent')||'',JSON.stringify({reportId:id,...details}),new Date().toISOString()]);
  app.get('/api/treasury/access',route(async(req,res)=>{
    if(req.user.role!=='owner')throw error(403,'Only the administrator can manage bank record access.');
    const users=await dbAll("SELECT id,name,role,permissions_json,roster_id FROM users WHERE access_revoked_at IS NULL AND email NOT LIKE '%.local' ORDER BY name");
    res.json({users:users.map(u=>({id:u.id,name:u.name,role:u.role,canPrepare:canPrepare(u),uploadEnabled:hasPermission(u,'treasury.upload')}))});
  }));
  app.put('/api/treasury/access/:userId',route(async(req,res)=>{
    if(req.user.role!=='owner')throw error(403,'Only the administrator can manage bank record access.');
    if(typeof req.body.enabled!=='boolean')throw error(400,'Choose an active account and its bank record access.');
    await withTransaction(async()=>{
      const user=await dbGet('SELECT id,role,permissions_json,roster_id FROM users WHERE id=? AND access_revoked_at IS NULL FOR UPDATE',[Number(req.params.userId)]);
      if(!user)throw error(400,'Choose an active account and its bank record access.');
      if(user.role==='owner')throw error(409,'The Worshipful Master retains full access.');
      const permissions=new Set(resolvePermissions(user));
      if(req.body.enabled){permissions.add('treasury.upload');permissions.add('treasury.view');}else permissions.delete('treasury.upload');
      await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify([...permissions]),user.id]);
      if(req.body.enabled)await dbRun('INSERT INTO treasury_upload_access (user_id,granted_by,granted_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET granted_by=excluded.granted_by,granted_at=excluded.granted_at',[user.id,req.user.id,new Date().toISOString()]);
      else await dbRun('DELETE FROM treasury_upload_access WHERE user_id=?',[user.id]);
      await audit(req,null,'upload_access_changed',{userId:user.id,enabled:req.body.enabled});
    });res.json({ok:true});
  }));
  app.get('/api/treasury/preparers',requirePrepare,route(async(_req,res)=>{
    const users=await dbAll("SELECT id,name,role,permissions_json,roster_id FROM users WHERE access_revoked_at IS NULL AND email NOT LIKE '%.local' ORDER BY name");res.json({preparers:users.filter(canPrepare).map(({id,name,role})=>({id,name,role}))});
  }));
  app.get('/api/treasury/alerts',requirePrepare,route(async(req,res)=>{
    const rows=await dbAll(`SELECT r.id,r.uploader_name,r.created_at,r.draft_json
      FROM treasury_reports r
      LEFT JOIN treasury_alert_dismissals dismissed ON dismissed.report_id=r.id AND dismissed.user_id=?
      WHERE r.deleted_at IS NULL AND r.status='awaiting_preparer' AND r.preparer_user_id IS NULL
        AND dismissed.report_id IS NULL
      ORDER BY r.created_at ASC`,[req.user.id]);
    const completed=await dbAll("SELECT draft_json,preparer_attested_at FROM treasury_reports WHERE deleted_at IS NULL AND status IN ('ready_for_distribution','distributed') AND preparer_attested_at IS NOT NULL");
    res.json({alerts:rows.filter(row=>!completed.some(item=>item.preparer_attested_at>row.created_at&&treasuryPeriodCovered(JSON.parse(row.draft_json),[JSON.parse(item.draft_json)]))).map(row=>{
      const draft=JSON.parse(row.draft_json),period=draft.periodEnd||draft.periodStart||'';
      return {
        id:row.id,
        title:'Banking information is awaiting report preparation',
        message:`Uploaded by ${row.uploader_name||'an authorized officer'}${period?` for the period ending ${period}`:''}. Claim the prefilled report to confirm or correct the values.`,
        uploadedBy:row.uploader_name||'',
        createdAt:row.created_at,
      };
    })});
  }));
  app.post('/api/treasury/alerts/:id/dismiss',requirePrepare,route(async(req,res)=>{
    const row=await dbGet("SELECT id FROM treasury_reports WHERE id=? AND deleted_at IS NULL AND status='awaiting_preparer' AND preparer_user_id IS NULL",[req.params.id]);
    if(!row)throw error(404,'That banking-information alert is no longer active.');
    const time=new Date().toISOString();
    await dbRun(`INSERT INTO treasury_alert_dismissals (report_id,user_id,dismissed_at)
      VALUES (?,?,?) ON CONFLICT(report_id,user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at`,[row.id,req.user.id,time]);
    await audit(req,row.id,'alert_dismissed');
    res.json({ok:true});
  }));
  app.get('/api/treasury',route(async(req,res)=>{
    let filter='',params=[];
    if(req.user.role!=='owner'){
      const working=canPrepare(req.user)
        ? " OR created_by_user_id=? OR preparer_user_id=? OR (status='awaiting_preparer' AND preparer_user_id IS NULL)"
        : hasPermission(req.user,'treasury.upload')
          ? " OR (created_by_user_id=? AND status IN ('awaiting_preparer','draft','superseded'))"
          : '';
      filter=` AND ((${finalSql})${working})`;
      params=canPrepare(req.user)?[req.user.id,req.user.id]:hasPermission(req.user,'treasury.upload')?[req.user.id]:[];
    }
    const rows=await dbAll('SELECT * FROM treasury_reports WHERE deleted_at IS NULL'+filter+' ORDER BY created_at DESC',params);
    res.json({reports:await Promise.all(rows.map(row=>visibleReport(row,req.user)))});
  }));
  app.post('/api/treasury/drafts',requirePrepare,route(async(req,res)=>{
    const id=crypto.randomUUID(),time=new Date().toISOString(),draft=normalizeTreasury(applyTreasuryMeetingCycle(normalizeTreasury(),await reportingWindow()));
    await withTransaction(async()=>{
      await dbRun('INSERT INTO treasury_reports (id,draft_json,source_text,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,preparer_user_id,uploader_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[id,JSON.stringify(draft),'',req.user.id,req.user.name,req.user.role,time,time,req.user.id,req.user.name,'draft']);
      await audit(req,id,'created',{manual:true});
    });broadcast('treasury_changed');res.status(201).json({report:serial(await fetchRecord(id))});
  }));
  app.post('/api/treasury/generate',requireUpload,rateLimit({key:'treasury-generate',maximum:12,windowMs:3600000}),uploadFields,route(async(req,res)=>{
    const uploaded=fileList(req.files);if(uploaded.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw error(400,'Keep the combined uploads under 20 MB.');
    const intent=req.body.intent || (req.body.deferAssignment==='true'||req.treasuryAccess!=='prepare'?'save':'complete');
    if(!['save','complete'].includes(intent))throw error(400,'Choose whether to save banking information or complete the report.');
    if(intent==='complete'&&req.treasuryAccess!=='prepare')throw error(403,'This account can save banking information, but report preparation access is required to complete a report.');
    const deferAssignment=intent==='save';
    const source=await accountSources(req);
    const draft=await generateTreasuryDraft(source.text,{sourceNames:source.names,sourceNotes:source.notes,meetingCycle:await reportingWindow(),generateStructured:generationFor(req.user.id)}),id=crypto.randomUUID(),time=new Date().toISOString();
    draft.extractionNotes=[...(draft.extractionNotes||[]),'Application: uploaded banking information organized into this prefilled report.'];
    await withTransaction(async()=>{
      await dbRun('INSERT INTO treasury_reports (id,draft_json,source_text,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,preparer_user_id,uploader_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[id,JSON.stringify(draft),source.text,req.user.id,deferAssignment?'':req.user.name,deferAssignment?'':req.user.role,time,time,deferAssignment?null:req.user.id,req.user.name,deferAssignment?'awaiting_preparer':'draft']);
      for(const {file:f,accountLabel} of source.files)await dbRun('INSERT INTO treasury_sources (id,report_id,name,mime,bytes,account_label) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),id,f.originalname.slice(0,150),f.mimetype,f.buffer,accountLabel]);
      await audit(req,id,'created');
    });
    broadcast('treasury_changed',{reason:deferAssignment?'banking_information_waiting':'report_started',reportId:id});
    res.status(201).json({report:await visibleReport(await fetchRecord(id),req.user)});
  }));
  app.post('/api/treasury/:id/assign',requirePrepare,route(async(req,res)=>{
    const row=await record(req);revision(req,row);
    if(!['awaiting_preparer','draft'].includes(row.status))throw error(409,'A signed report cannot be reassigned.');
    const requestedPreparerId=Number(req.body.preparerUserId);
    if(row.status==='draft'&&row.preparer_user_id&&row.preparer_user_id!==requestedPreparerId&&req.user.role!=='owner'){
      throw error(409,`This report has already been claimed by ${row.preparer_name}. Only that preparing officer can edit it.`);
    }
    const claimingAvailable=row.status==='awaiting_preparer'&&row.preparer_user_id===null&&req.treasuryAccess==='prepare'&&requestedPreparerId===req.user.id;
    if(!claimingAvailable&&req.user.role!=='owner'&&row.created_by_user_id!==req.user.id&&row.preparer_user_id!==req.user.id)throw error(403,'You can start an available report yourself. Reassignment requires the uploader, assigned preparer or administrator.');
    const preparer=await dbGet("SELECT id,name,role,permissions_json,roster_id FROM users WHERE id=? AND access_revoked_at IS NULL AND email NOT LIKE '%.local'",[requestedPreparerId]);
    if(!preparer||!canPrepare(preparer))throw error(400,'Choose an active officer with treasurer report preparation access.');
    const draft=JSON.parse(row.draft_json);draft.sourceReviewed=false;
    await withTransaction(async()=>{
      const result=await dbRun("UPDATE treasury_reports SET preparer_user_id=?,preparer_name=?,preparer_role=?,status='draft',draft_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[preparer.id,preparer.name,preparer.role,JSON.stringify(draft),new Date().toISOString(),row.id,row.revision]);
      if(!result.changes){
        const current=await fetchRecord(row.id);
        if(current?.status==='draft'&&current.preparer_user_id)throw error(409,`This report has already been claimed by ${current.preparer_name}. Only that preparing officer can edit it.`);
        throw error(409,'This report changed. Reopen it before assigning.');
      }
      await audit(req,row.id,'assigned',{previousPreparerUserId:row.preparer_user_id,preparerUserId:preparer.id});
    });
    let organizationWarning='';
    const alreadyOrganized=(draft.extractionNotes||[]).includes('Application: uploaded banking information organized into this prefilled report.');
    if(row.status==='awaiting_preparer'&&row.source_text.trim()&&!alreadyOrganized){
      try{
        const meetingCycle=treasuryWindowForDraft(draft)||await reportingWindow();
        const organized=await generateTreasuryDraft(row.source_text,{sourceNames:draft.sourceNames,sourceNotes:draft.extractionNotes?.filter(note=>!/^(?:Terra|Luna)|^Source evidence|^Reporting window fixed|^\d+ source entr(?:y|ies)|^Full-statement balances|^Only balances and totals|^Balances and totals|^Figures retained/i.test(note)),meetingCycle,generateStructured:generationFor(preparer.id)});
        const current=await fetchRecord(row.id);
        if(current?.status==='draft'&&current.preparer_user_id===preparer.id&&current.revision===row.revision+1){
          const changed=await dbRun('UPDATE treasury_reports SET draft_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND preparer_user_id=?',[JSON.stringify(organized),new Date().toISOString(),row.id,current.revision,preparer.id]);
          if(changed.changes)await audit(req,row.id,'source_organized',{automatic:true});
        }
      }catch{
        organizationWarning='The report was claimed, but the banking source could not be organized automatically. Select Reorganize original source to try again, or enter corrections in the marked fields.';
      }
    }
    broadcast('treasury_changed',{reason:'report_claimed',reportId:row.id});res.json({report:serial(await fetchRecord(row.id)),organizationWarning});
  }));
  // Return an unsaved replacement. Existing corrections and signatures stay intact.
  app.post('/api/treasury/:id/organize',requirePrepare,rateLimit({key:'treasury-generate',maximum:12,windowMs:3600000}),route(async(req,res)=>{
    const row=await record(req);revision(req,row);
    if(!editable(row,req.user))throw error(403,'Only the assigned preparing officer can organize this unsigned draft. The Worshipful Master can take over the report first.');
    if(!row.source_text.trim())throw error(400,'This manually entered report has no uploaded source to organize. Continue editing its report fields.');
    const previous=JSON.parse(row.draft_json);
    const meetingCycle=treasuryWindowForDraft(previous)||await reportingWindow();
    const draft=await generateTreasuryDraft(row.source_text,{sourceNames:previous.sourceNames,sourceNotes:previous.extractionNotes?.filter(note=>!/^(?:Terra|Luna)|^Source evidence|^Reporting window fixed|^\d+ source entr(?:y|ies)|^Full-statement balances|^Only balances and totals|^Balances and totals|^Figures retained/i.test(note)),meetingCycle,generateStructured:generationFor(req.user.id)});
    const current=await record(req);revision(req,current);
    if(!editable(current,req.user))throw error(409,'This report changed while its source was being organized. Reopen it before continuing.');
    await audit(req,row.id,'source_organized');
    res.json({draft});
  }));
  app.get('/api/treasury/:id/source',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!canReadSource(row,req.user))throw error(403,'Only the uploader, assigned preparing officer or administrator can open these banking records.');const files=await dbAll('SELECT id,name,mime,account_label AS "accountLabel" FROM treasury_sources WHERE report_id=? ORDER BY account_label,name',[row.id]);res.json({text:row.source_text,files});
  }));
  app.get('/api/treasury/:id/sources/:sourceId',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!canReadSource(row,req.user))throw error(403,'Only the uploader, assigned preparing officer or administrator can download these banking records.');const file=await dbGet('SELECT name,bytes FROM treasury_sources WHERE id=? AND report_id=?',[req.params.sourceId,row.id]);
    if(!file)throw error(404,'Source file not found.');
    await audit(req,row.id,'source_downloaded');
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream').send(bytes(file.bytes));
  }));
  app.put('/api/treasury/:id',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!editable(row,req.user))throw error(403,'This report is read-only. Only its assigned preparing officer can edit it. The Worshipful Master can take over the report first.');revision(req,row);
    const saved=JSON.parse(row.draft_json),meetingCycle=treasuryWindowForDraft(saved)||await reportingWindow();
    const draft=normalizeTreasury(applyTreasuryMeetingCycle(normalizeTreasury(req.body.draft),meetingCycle));
    const result=await dbRun('UPDATE treasury_reports SET draft_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',[JSON.stringify(draft),new Date().toISOString(),row.id,row.revision]);
    if(!result.changes)throw error(409,'This report changed. Reopen it before saving.');await audit(req,row.id,'edited');res.json({report:serial(await fetchRecord(row.id))});
  }));
  app.get('/api/treasury/:id/pdf',route(async(req,res)=>{
    const row=await record(req),snapshot=finalized(row)?await signedSnapshot(row):null;
    if(!snapshot?.signature_bytes)throw error(404,'Signed treasurer report not found.');
    const pdf=await buildTreasuryPdf({draft:JSON.parse(snapshot.draft_json),status:row.status,preparedBy:row.preparer_name,preparerRole:row.preparer_role,preparerSignature:bytes(snapshot.signature_bytes)});
    res.type('application/pdf').send(pdf);
  }));
  app.post('/api/treasury/:id/preview',requirePrepare,route(async(req,res)=>{
    const row=await record(req),saved=JSON.parse(row.draft_json),meetingCycle=treasuryWindowForDraft(saved)||await reportingWindow(),draft=editable(row,req.user)&&req.body.draft?normalizeTreasury(applyTreasuryMeetingCycle(normalizeTreasury(req.body.draft),meetingCycle)):saved;
    const snapshot=await signedSnapshot(row);
    const pdf=await buildTreasuryPdf({draft:finalized(row)&&snapshot?JSON.parse(snapshot.draft_json):draft,status:row.status,preparedBy:row.preparer_name,preparerRole:row.preparer_role,preparerSignature:bytes(snapshot?.signature_bytes)});
    res.type('application/pdf').send(pdf);
  }));
  app.post('/api/treasury/:id/preparer-attest',requirePrepare,route(async(req,res)=>{
    const initial=await record(req);revision(req,initial);
    if(initial.preparer_user_id!==req.user.id||initial.status!=='draft'||req.treasuryAccess!=='prepare')throw error(403,'Only the preparing officer can attest to an unsigned draft.');
    const signature=await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?',[req.user.id]);if(!signature?.signature_bytes)throw error(409,'Save your signature profile before attesting.');
    let row;const time=new Date().toISOString();
    await withTransaction(async()=>{
      await dbGet('SELECT id FROM treasury_period_lock WHERE id=1 FOR UPDATE');
      row=await dbGet('SELECT * FROM treasury_reports WHERE id=? AND deleted_at IS NULL FOR UPDATE',[req.params.id]);
      if(!row)throw error(404,'Treasurer report not found.');revision(req,row);
      if(row.preparer_user_id!==req.user.id||row.status!=='draft'||req.treasuryAccess!=='prepare')throw error(403,'Only the preparing officer can attest to an unsigned draft.');
      const draft=normalizeTreasury(JSON.parse(row.draft_json)),calculation=calculateTreasury(draft);if(!calculation.ready)throw error(409,calculation.issues.join(' '));
      const snapshots=await dbAll("SELECT a.report_id,a.draft_json FROM treasury_attestations a JOIN treasury_reports r ON r.id=a.report_id WHERE a.phase='preparer' AND a.report_id<>? AND r.deleted_at IS NULL AND r.status IN ('ready_for_distribution','distributed')",[row.id]);
      const signed=snapshots.map(item=>normalizeTreasury(JSON.parse(item.draft_json))).filter(item=>item.periodStart&&item.periodEnd);
      if(signed.some(item=>item.periodStart<=draft.periodEnd&&item.periodEnd>=draft.periodStart))throw error(409,'A finalized Treasurer Report already covers some or all of these dates. Start the next report on the day after the last finalized report.');
      const expected=treasuryReportingWindow(draft.periodEnd,signed.map(item=>item.periodEnd));
      if(draft.periodStart!==expected.periodStart)throw error(409,`This report must begin on ${expected.periodStart}, the day after the last completed reporting period. Reopen the report before signing.`);
      const changed=await dbRun("UPDATE treasury_reports SET status='ready_for_distribution',submitted_json=draft_json,preparer_attested_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[time,time,row.id,row.revision]);
      if(!changed.changes)throw error(409,'This report changed. Reopen it before signing.');
      await dbRun('INSERT INTO treasury_attestations (id,report_id,phase,user_id,draft_json,signature_bytes,created_at) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),row.id,'preparer',req.user.id,row.draft_json,bytes(signature.signature_bytes),time]);await audit(req,row.id,'preparer_attested');
      const waiting=await dbAll("SELECT id,draft_json,created_at FROM treasury_reports WHERE id<>? AND deleted_at IS NULL AND status='awaiting_preparer' AND preparer_user_id IS NULL FOR UPDATE",[row.id]);
      for(const pending of waiting.filter(item=>item.created_at<time&&treasuryPeriodCovered(JSON.parse(item.draft_json),[draft]))){
        const closed=await dbRun("UPDATE treasury_reports SET status='superseded',superseded_by_report_id=?,superseded_at=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND status='awaiting_preparer' AND preparer_user_id IS NULL AND created_at<?",[row.id,time,time,pending.id,time]);
        if(closed.changes)await audit(req,pending.id,'superseded_by_completed_report',{completedReportId:row.id});
      }
    });
    const recipients=await dbAll("SELECT DISTINCT email FROM users WHERE access_revoked_at IS NULL AND (id=? OR role='secretary')",[row.preparer_user_id]);
    const warnings=[];
    for(const recipient of recipients){try{const sent=await sendEmail({to:recipient.email,subject:"Treasurer report signed and ready for distribution",text:`${row.preparer_name} signed and finalized the treasurer report. Open the report to download the signed copy for distribution.\n\n${baseUrl(req)}/?section=treasury`});if(!sent)warnings.push('The report is saved, but an email notice could not be delivered.');}catch{warnings.push('The report is saved, but an email notice could not be delivered.');}}
    broadcast('treasury_changed');res.json({report:serial(await fetchRecord(row.id)),notificationWarnings:[...new Set(warnings)]});
  }));
  app.post('/api/treasury/:id/mark-distributed',requirePrepare,route(async(req,res)=>{
    const row=await record(req);revision(req,row);if(!['owner','secretary'].includes(req.user.role)||row.status!=='ready_for_distribution')throw error(403,'The Secretary records distribution after the preparing officer signs the report.');
    const result=await dbRun("UPDATE treasury_reports SET status='distributed',revision=revision+1,updated_at=? WHERE id=? AND revision=?",[new Date().toISOString(),row.id,row.revision]);if(!result.changes)throw error(409,'The report changed. Reopen it.');await audit(req,row.id,'distributed');broadcast('treasury_changed',{reason:'report_distributed',reportId:row.id});res.json({report:serial(await fetchRecord(row.id))});
  }));
  app.delete('/api/treasury/:id',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!['awaiting_preparer','draft'].includes(row.status)||row.preparer_attested_at)throw error(409,'Signed reports cannot be deleted.');if(req.user.role!=='owner'&&row.created_by_user_id!==req.user.id&&row.preparer_user_id!==req.user.id)throw error(403,'Only the preparer or Worshipful Master can delete this draft.');
    const result=await dbRun("UPDATE treasury_reports SET deleted_at=?,revision=revision+1 WHERE id=? AND revision=? AND status IN ('draft','awaiting_preparer')",[new Date().toISOString(),row.id,row.revision]);if(!result.changes)throw error(409,'The report changed. Reopen it.');await audit(req,row.id,'deleted');broadcast('treasury_changed',{reason:'report_deleted',reportId:row.id});res.json({ok:true});
  }));
}
