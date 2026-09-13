import crypto from 'node:crypto';
import multer from 'multer';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { normalizeTreasury, calculateTreasury } from './treasury.js';
import { hasPermission, resolvePermissions } from './access-control.js';
import { generateTreasuryDraft } from './treasury-ai.js';
import { readTreasurySources } from './treasury-source.js';
import { buildTreasuryPdf } from './treasury-pdf.js';
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const bytes = v => v ? Buffer.from(v) : null;
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:12*1024*1024, files:5, fields:4, fieldSize:180000 }, fileFilter:(_req,file,done)=>/\.(pdf|png|jpe?g|txt)$/i.test(file.originalname)?done(null,true):done(error(400,'Choose a PDF, PNG, JPG or TXT file.')) });
const serial = row => ({ preparerUserId:row.preparer_user_id, uploadedBy:row.uploader_name||row.preparer_name, id:row.id, status:row.status, revision:row.revision, createdByUserId:row.created_by_user_id, createdBy:row.preparer_name, preparerRole:row.preparer_role, updatedAt:row.updated_at, draft:JSON.parse(row.draft_json), submittedDraft:row.submitted_json?JSON.parse(row.submitted_json):null, calculation:calculateTreasury(JSON.parse(row.draft_json)), preparerAttestedAt:row.preparer_attested_at });
const fetchRecord = id => dbGet('SELECT * FROM treasury_reports WHERE id = ? AND deleted_at IS NULL',[id]);
const canPrepare = user => hasPermission(user,'treasury.prepare');
const editable = (row,user) => canPrepare(user)&&row.status==='draft'&&(row.preparer_user_id===user.id||user.role==='owner');
const finalized = row => ['ready_for_distribution','distributed'].includes(row.status)&&Boolean(row.preparer_attested_at&&row.submitted_json);
const signedSnapshot = row => dbGet("SELECT draft_json,signature_bytes FROM treasury_attestations WHERE report_id=? AND phase='preparer' ORDER BY created_at DESC,id DESC LIMIT 1",[row.id]);
const finalSql = "status IN ('ready_for_distribution','distributed') AND preparer_attested_at IS NOT NULL AND submitted_json IS NOT NULL AND EXISTS (SELECT 1 FROM treasury_attestations a WHERE a.report_id=treasury_reports.id AND a.phase='preparer')";
async function visibleReport(row,user) {
  if(canPrepare(user))return serial(row);
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
  await dbRun("UPDATE treasury_reports SET preparer_user_id=created_by_user_id,uploader_name=preparer_name WHERE uploader_name IS NULL");
  await dbRun('CREATE TABLE IF NOT EXISTS treasury_upload_access (user_id INTEGER PRIMARY KEY REFERENCES users(id), granted_by INTEGER NOT NULL REFERENCES users(id), granted_at TEXT NOT NULL)');
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_sources (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES treasury_reports(id), name TEXT NOT NULL, mime TEXT NOT NULL, bytes BYTEA NOT NULL)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS treasury_attestations (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES treasury_reports(id), phase TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), draft_json TEXT NOT NULL, signature_bytes BYTEA NOT NULL, created_at TEXT NOT NULL)`);
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
  const record=async req=>{
    const row=await fetchRecord(req.params.id);
    const visible=row&&(canPrepare(req.user)||(hasPermission(req.user,'treasury.upload')&&row.created_by_user_id===req.user.id&&['awaiting_preparer','draft'].includes(row.status))||(hasPermission(req.user,'treasury.view')&&finalized(row)&&await signedSnapshot(row)));
    if(!visible)throw error(404,'Treasurer report not found.');return row;
  };
  const revision=(req,row)=>{if(req.body?.revision!==row.revision)throw error(409,'This report changed in another window. Reopen it before saving or signing.');};
  const audit=async(req,id,action,details={})=>dbRun('INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',[req.user.id,`treasury_${action}`,req.ip,req.get('user-agent')||'',JSON.stringify({reportId:id,...details}),new Date().toISOString()]);
  app.get('/api/treasury/access',route(async(req,res)=>{
    if(req.user.role!=='owner')throw error(403,'Only the administrator can manage bank record access.');
    const users=await dbAll("SELECT id,name,role,permissions_json FROM users WHERE access_revoked_at IS NULL AND email NOT LIKE '%.local' ORDER BY name");
    res.json({users:users.map(u=>({id:u.id,name:u.name,role:u.role,canPrepare:canPrepare(u),uploadEnabled:hasPermission(u,'treasury.upload')}))});
  }));
  app.put('/api/treasury/access/:userId',route(async(req,res)=>{
    if(req.user.role!=='owner')throw error(403,'Only the administrator can manage bank record access.');
    if(typeof req.body.enabled!=='boolean')throw error(400,'Choose an active account and its bank record access.');
    await withTransaction(async()=>{
      const user=await dbGet('SELECT id,role,permissions_json FROM users WHERE id=? AND access_revoked_at IS NULL FOR UPDATE',[Number(req.params.userId)]);
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
    const users=await dbAll("SELECT id,name,role,permissions_json FROM users WHERE access_revoked_at IS NULL AND email NOT LIKE '%.local' ORDER BY name");res.json({preparers:users.filter(canPrepare).map(({id,name,role})=>({id,name,role}))});
  }));
  app.get('/api/treasury',route(async(req,res)=>{
    const ownUploads=!canPrepare(req.user)&&hasPermission(req.user,'treasury.upload');
    const filter=canPrepare(req.user)?'':` AND ((${finalSql})${ownUploads?" OR (created_by_user_id=? AND status IN ('awaiting_preparer','draft'))":''})`;
    const rows=await dbAll('SELECT * FROM treasury_reports WHERE deleted_at IS NULL'+filter+' ORDER BY created_at DESC',ownUploads?[req.user.id]:[]);
    res.json({reports:await Promise.all(rows.map(row=>visibleReport(row,req.user)))});
  }));
  app.post('/api/treasury/drafts',requirePrepare,route(async(req,res)=>{
    const id=crypto.randomUUID(),time=new Date().toISOString(),draft=normalizeTreasury();
    await withTransaction(async()=>{
      await dbRun('INSERT INTO treasury_reports (id,draft_json,source_text,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,preparer_user_id,uploader_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[id,JSON.stringify(draft),'',req.user.id,req.user.name,req.user.role,time,time,req.user.id,req.user.name,'draft']);
      await audit(req,id,'created',{manual:true});
    });broadcast('treasury_changed');res.status(201).json({report:serial(await fetchRecord(id))});
  }));
  app.post('/api/treasury/generate',requireUpload,rateLimit({key:'treasury-generate',maximum:12,windowMs:3600000}),upload.array('files',5),route(async(req,res)=>{
    if((req.files||[]).reduce((n,f)=>n+f.size,0)>20*1024*1024)throw error(400,'Keep the combined uploads under 20 MB.');
    const intent=req.body.intent || (req.body.deferAssignment==='true'||req.treasuryAccess!=='prepare'?'save':'complete');
    if(!['save','complete'].includes(intent))throw error(400,'Choose whether to save banking information or complete the report.');
    if(intent==='complete'&&req.treasuryAccess!=='prepare')throw error(403,'This account can save banking information, but report preparation access is required to complete a report.');
    const deferAssignment=intent==='save';
    const source=await readTreasurySources(req.files,req.body.sourceText);
    const draft=await generateTreasuryDraft(source.text,{sourceNames:source.names,sourceNotes:source.notes,generateStructured:deferAssignment?undefined:generationFor(req.user.id)}),id=crypto.randomUUID(),time=new Date().toISOString();
    await withTransaction(async()=>{
      await dbRun('INSERT INTO treasury_reports (id,draft_json,source_text,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,preparer_user_id,uploader_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[id,JSON.stringify(draft),source.text,req.user.id,deferAssignment?'':req.user.name,deferAssignment?'':req.user.role,time,time,deferAssignment?null:req.user.id,req.user.name,deferAssignment?'awaiting_preparer':'draft']);
      for(const f of req.files||[])await dbRun('INSERT INTO treasury_sources (id,report_id,name,mime,bytes) VALUES (?,?,?,?,?)',[crypto.randomUUID(),id,f.originalname.slice(0,150),f.mimetype,f.buffer]);
      await audit(req,id,'created');
    });
    res.status(201).json({report:await visibleReport(await fetchRecord(id),req.user)});
  }));
  app.post('/api/treasury/:id/assign',requirePrepare,route(async(req,res)=>{
    const row=await record(req);revision(req,row);
    if(!['awaiting_preparer','draft'].includes(row.status))throw error(409,'A signed report cannot be reassigned.');
    const claimingAvailable=row.status==='awaiting_preparer'&&row.preparer_user_id===null&&req.treasuryAccess==='prepare'&&Number(req.body.preparerUserId)===req.user.id;
    if(!claimingAvailable&&req.user.role!=='owner'&&row.created_by_user_id!==req.user.id&&row.preparer_user_id!==req.user.id)throw error(403,'You can start an available report yourself. Reassignment requires the uploader, assigned preparer or administrator.');
    const preparer=await dbGet("SELECT id,name,role,permissions_json FROM users WHERE id=? AND access_revoked_at IS NULL AND email NOT LIKE '%.local'",[Number(req.body.preparerUserId)]);
    if(!preparer||!canPrepare(preparer))throw error(400,'Choose an active officer with treasurer report preparation access.');
    const draft=JSON.parse(row.draft_json);draft.sourceReviewed=false;
    await withTransaction(async()=>{
      const result=await dbRun("UPDATE treasury_reports SET preparer_user_id=?,preparer_name=?,preparer_role=?,status='draft',draft_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[preparer.id,preparer.name,preparer.role,JSON.stringify(draft),new Date().toISOString(),row.id,row.revision]);
      if(!result.changes)throw error(409,'This report changed. Reopen it before assigning.');
      await audit(req,row.id,'assigned',{previousPreparerUserId:row.preparer_user_id,preparerUserId:preparer.id});
    });broadcast('treasury_changed');res.json({report:serial(await fetchRecord(row.id))});
  }));
  // Return an unsaved replacement. Existing corrections and signatures stay intact.
  app.post('/api/treasury/:id/organize',requirePrepare,rateLimit({key:'treasury-generate',maximum:12,windowMs:3600000}),route(async(req,res)=>{
    const row=await record(req);revision(req,row);
    if(!editable(row,req.user))throw error(403,'Only the assigned preparer or Worshipful Master can organize an unsigned draft.');
    if(!row.source_text.trim())throw error(400,'This manually entered report has no uploaded source to organize. Continue editing its report fields.');
    const previous=JSON.parse(row.draft_json);
    const draft=await generateTreasuryDraft(row.source_text,{sourceNames:previous.sourceNames,sourceNotes:previous.extractionNotes?.filter(note=>!/^Terra|^Source evidence/i.test(note)),generateStructured:generationFor(req.user.id)});
    const current=await record(req);revision(req,current);
    if(!editable(current,req.user))throw error(409,'This report changed while its source was being organized. Reopen it before continuing.');
    await audit(req,row.id,'source_organized');
    res.json({draft});
  }));
  app.get('/api/treasury/:id/source',requirePrepare,route(async(req,res)=>{
    const row=await record(req);const files=await dbAll('SELECT id,name,mime FROM treasury_sources WHERE report_id=? ORDER BY name',[row.id]);res.json({text:row.source_text,files});
  }));
  app.get('/api/treasury/:id/sources/:sourceId',requirePrepare,route(async(req,res)=>{
    const row=await record(req),file=await dbGet('SELECT name,bytes FROM treasury_sources WHERE id=? AND report_id=?',[req.params.sourceId,row.id]);
    if(!file)throw error(404,'Source file not found.');
    await audit(req,row.id,'source_downloaded');
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream').send(bytes(file.bytes));
  }));
  app.put('/api/treasury/:id',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!editable(row,req.user))throw error(403,'This report is read-only. Only its preparer or the Worshipful Master can edit a draft.');revision(req,row);
    const draft=normalizeTreasury(req.body.draft);
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
    const row=await record(req),draft=editable(row,req.user)&&req.body.draft?normalizeTreasury(req.body.draft):JSON.parse(row.draft_json);
    const snapshot=await signedSnapshot(row);
    const pdf=await buildTreasuryPdf({draft:finalized(row)&&snapshot?JSON.parse(snapshot.draft_json):draft,status:row.status,preparedBy:row.preparer_name,preparerRole:row.preparer_role,preparerSignature:bytes(snapshot?.signature_bytes)});
    res.type('application/pdf').send(pdf);
  }));
  app.post('/api/treasury/:id/preparer-attest',requirePrepare,route(async(req,res)=>{
    const row=await record(req);revision(req,row);
    if(row.preparer_user_id!==req.user.id||row.status!=='draft'||req.treasuryAccess!=='prepare')throw error(403,'Only the preparing officer can attest to an unsigned draft.');
    const calculation=calculateTreasury(JSON.parse(row.draft_json));if(!calculation.ready)throw error(409,calculation.issues.join(' '));
    const signature=await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?',[req.user.id]);if(!signature?.signature_bytes)throw error(409,'Save your signature profile before attesting.');
    const time=new Date().toISOString();
    await withTransaction(async()=>{
      const changed=await dbRun("UPDATE treasury_reports SET status='ready_for_distribution',submitted_json=draft_json,preparer_attested_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",[time,time,row.id,row.revision]);
      if(!changed.changes)throw error(409,'This report changed. Reopen it before signing.');
      await dbRun('INSERT INTO treasury_attestations (id,report_id,phase,user_id,draft_json,signature_bytes,created_at) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),row.id,'preparer',req.user.id,row.draft_json,bytes(signature.signature_bytes),time]);await audit(req,row.id,'preparer_attested');
    });
    const recipients=await dbAll("SELECT DISTINCT email FROM users WHERE access_revoked_at IS NULL AND (id=? OR role='secretary')",[row.preparer_user_id]);
    const warnings=[];
    for(const recipient of recipients){try{const sent=await sendEmail({to:recipient.email,subject:"Treasurer report signed and ready for distribution",text:`${row.preparer_name} signed and finalized the treasurer report. Open the report to download the signed copy for distribution.\n\n${baseUrl(req)}/?section=treasury`});if(!sent)warnings.push('The report is saved, but an email notice could not be delivered.');}catch{warnings.push('The report is saved, but an email notice could not be delivered.');}}
    broadcast('treasury_changed');res.json({report:serial(await fetchRecord(row.id)),notificationWarnings:[...new Set(warnings)]});
  }));
  app.post('/api/treasury/:id/mark-distributed',requirePrepare,route(async(req,res)=>{
    const row=await record(req);revision(req,row);if(!['owner','secretary'].includes(req.user.role)||row.status!=='ready_for_distribution')throw error(403,'The Secretary records distribution after the preparing officer signs the report.');
    const result=await dbRun("UPDATE treasury_reports SET status='distributed',revision=revision+1,updated_at=? WHERE id=? AND revision=?",[new Date().toISOString(),row.id,row.revision]);if(!result.changes)throw error(409,'The report changed. Reopen it.');await audit(req,row.id,'distributed');res.json({report:serial(await fetchRecord(row.id))});
  }));
  app.delete('/api/treasury/:id',requirePrepare,route(async(req,res)=>{
    const row=await record(req);if(!['awaiting_preparer','draft'].includes(row.status)||row.preparer_attested_at)throw error(409,'Signed reports cannot be deleted.');if(req.user.role!=='owner'&&row.created_by_user_id!==req.user.id&&row.preparer_user_id!==req.user.id)throw error(403,'Only the preparer or Worshipful Master can delete this draft.');
    const result=await dbRun("UPDATE treasury_reports SET deleted_at=?,revision=revision+1 WHERE id=? AND revision=? AND status IN ('draft','awaiting_preparer')",[new Date().toISOString(),row.id,row.revision]);if(!result.changes)throw error(409,'The report changed. Reopen it.');await audit(req,row.id,'deleted');res.json({ok:true});
  }));
}
