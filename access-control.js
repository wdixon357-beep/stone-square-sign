import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
export const CAPABILITIES = [
 ['building.view','View building requests'],['building.decide','Approve or decline building requests'],['calendar.view','View Lodge Calendar'],['calendar.manage','Manage Lodge Calendar events'],
 ['reports.create','Prepare reports'],['minutes.view','View finished meeting minutes'],['minutes.prepare','Prepare and edit meeting minutes'],
 ['treasury.view','View finished treasurer reports'],['treasury.prepare','Prepare and edit treasurer reports'],['treasury.upload','Provide bank records and screenshots'],
 ['dues.view','View dues'],['documents.status','View dispensation statuses'],['documents.sign','Sign assigned dispensations'],['candidates.view','View Candidate Tracker'],
 ['proposals.create','Submit and track personal dispensation proposals'],['signature.manage','Manage own signature'],['settings.manage','Own service settings']
].map(([id,label])=>({id,label}));
const personal=['signature.manage','settings.manage'];
const reader=['calendar.view','reports.create','minutes.view','treasury.view',...personal];
export function normalizePermissions(values){
 if(!Array.isArray(values)||values.some(v=>!CAPABILITIES.some(c=>c.id===v)))throw Object.assign(new Error('Choose valid officer permissions.'),{statusCode:400});
 const p=new Set(values);for(const prefix of ['minutes','treasury'])if(p.has(prefix+'.prepare'))p.add(prefix+'.view');
 if(p.has('building.decide'))p.add('building.view');if(p.has('calendar.manage'))p.add('calendar.view');
 if(p.has('treasury.upload'))p.add('treasury.view');if(p.has('documents.sign'))p.add('documents.status');
 return [...p].sort();
}
export function resolvePermissions(user){
 if(user?.role==='owner')return CAPABILITIES.map(c=>c.id);
 if(Array.isArray(user?.permissions))return normalizePermissions(user.permissions);
 if(user?.permissions_json!==null&&user?.permissions_json!==undefined){try{return normalizePermissions(JSON.parse(user.permissions_json));}catch{return [];}}
 switch(user?.role){
 case 'secretary': return [...reader,'building.view','minutes.prepare','treasury.prepare','treasury.upload','dues.view','documents.status','documents.sign','candidates.view'];
 case 'assistant_secretary': return [...reader,'building.view','minutes.prepare','treasury.prepare','dues.view','documents.status','documents.sign','candidates.view'];
 case 'treasurer':return ['calendar.view','reports.create','treasury.view','treasury.prepare','treasury.upload','dues.view',...personal];
 case 'assistant_treasurer':case 'treasury_preparer':return ['calendar.view','reports.create','treasury.view','treasury.prepare','dues.view',...personal];
 case 'warden':return [...reader,'building.view','dues.view','documents.status','candidates.view','proposals.create'];
 case 'officer':return reader;
 case 'signer':return ['reports.create','documents.status','documents.sign',...personal];
 case 'viewer':return ['documents.status','candidates.view','settings.manage'];
 default:return personal;
 }
}
export const hasPermission=(user,key)=>resolvePermissions(user).includes(key);
export function mountAccessRoutes(app,{requireAuth,requireOwner}){
 app.get('/api/admin/access',requireAuth,requireOwner,async(req,res,next)=>{try{
 const users=await dbAll("SELECT id,name,email,role,permissions_json,access_revoked_at FROM users WHERE email NOT LIKE '%.local' ORDER BY name");
 const invites=await dbAll('SELECT id,name,email,role,permissions_json FROM invitations WHERE used_at IS NULL AND expires_at>? ORDER BY name',[new Date().toISOString()]);
 const rows=(items,pending)=>items.map(u=>({key:`${pending?'invite':'user'}:${u.id}`,id:u.id,name:u.name,email:u.email,role:u.role,pending,revoked:Boolean(u.access_revoked_at),permissions:resolvePermissions(u)}));
 res.setHeader('Cache-Control','no-store');res.json({capabilities:CAPABILITIES,accounts:[...rows(users,false),...rows(invites,true)]});
 }catch(e){next(e)}});
 app.put('/api/admin/access',requireAuth,requireOwner,async(req,res,next)=>{try{
 const match=/^(user|invite):([1-9]\d*)$/.exec(req.body?.key||'');if(!match)throw Object.assign(new Error('Choose an officer account or invitation.'),{statusCode:400});
 const table=match[1]==='user'?'users':'invitations',id=Number(match[2]),permissions=normalizePermissions(req.body.permissions);
 await withTransaction(async()=>{
 const account=await dbGet(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[id]);
 if(!account||(table==='invitations'&&(account.used_at||account.expires_at<=new Date().toISOString())))throw Object.assign(new Error('Officer account or pending invitation not found.'),{statusCode:404});
 if(account.role==='owner')throw Object.assign(new Error('The Worshipful Master administrator retains full access.'),{statusCode:403});
 await dbRun(`UPDATE ${table} SET permissions_json=? WHERE id=?`,[JSON.stringify(permissions),id]);
 await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',[req.user.id,'officer_permissions_changed',req.ip,JSON.stringify({key:req.body.key,name:account.name,before:resolvePermissions(account),after:permissions}),new Date().toISOString()]);
 });res.json({ok:true});
 }catch(e){next(e)}});
}
