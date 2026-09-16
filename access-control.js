import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
export const CAPABILITIES = [
 ['building.request','Request use of the Lodge building'],['building.view','View building requests'],['building.decide','Approve or decline building requests'],['calendar.view','View Lodge Calendar'],['calendar.manage','Manage Lodge Calendar events'],
 ['reports.create','Prepare reports'],['minutes.view','View finished meeting minutes'],['minutes.prepare','Prepare and edit meeting minutes'],
 ['treasury.view','View finished treasurer reports'],['treasury.prepare','Prepare and edit treasurer reports'],['treasury.upload','Provide bank records and screenshots'],
 ['dues.self','View own dues'],['dues.ledger','View full dues ledger'],['dues.manage','Record non-Zeffy dues activity'],['suggestions.create','Send confidential suggestions'],['documents.status','View dispensation statuses'],['documents.sign','Sign assigned dispensations'],['candidates.view','View Candidate Tracker'],['candidates.edit','Edit Candidate Tracker records'],
 ['proposals.create','Submit and track personal dispensation proposals'],['signature.manage','Manage own signature'],['settings.manage','Own service settings']
].map(([id,label])=>({id,label}));
const personal=['building.request','signature.manage','settings.manage'];
const reader=['calendar.view','reports.create','minutes.view','treasury.view',...personal];
export const UNIVERSAL_RECORD_ROLES=new Set(['secretary','assistant_secretary','treasurer','assistant_treasurer','treasury_preparer','warden','officer']);
export function permissionsForStorage(values,role){
 const normalized=normalizePermissions(values,role);
 return UNIVERSAL_RECORD_ROLES.has(role)?normalized.filter(value=>!['minutes.view','treasury.view'].includes(value)):normalized;
}
export function normalizePermissions(values,role){
 if(!Array.isArray(values))throw Object.assign(new Error('Choose valid officer permissions.'),{statusCode:400});
 const legacyDues=values.includes('dues.view');
 const migrated=values.filter(v=>v!=='dues.view');
 if(legacyDues){migrated.push('dues.self');if(['secretary','assistant_secretary','warden'].includes(role))migrated.push('dues.ledger');if(['secretary','assistant_secretary'].includes(role))migrated.push('dues.manage');}
 if(migrated.some(v=>!CAPABILITIES.some(c=>c.id===v)))throw Object.assign(new Error('Choose valid officer permissions.'),{statusCode:400});
 const p=new Set(migrated);for(const prefix of ['minutes','treasury'])if(p.has(prefix+'.prepare'))p.add(prefix+'.view');
 if(p.has('building.decide'))p.add('building.view');if(p.has('calendar.manage'))p.add('calendar.view');
 if(p.has('treasury.upload'))p.add('treasury.view');if(p.has('documents.sign'))p.add('documents.status');
 if(p.has('candidates.edit'))p.add('candidates.view');
 if(UNIVERSAL_RECORD_ROLES.has(role)){p.add('minutes.view');p.add('treasury.view');}
 return [...p].sort();
}
export function resolvePermissions(user){
 if(user?.role==='owner')return CAPABILITIES.map(c=>c.id);
 if(Array.isArray(user?.permissions))return normalizePermissions(user.permissions,user.role);
 if(user?.permissions_json!==null&&user?.permissions_json!==undefined){try{return normalizePermissions(JSON.parse(user.permissions_json),user.role);}catch{return [];}}
 switch(user?.role){
 case 'secretary': return [...reader,'building.view','minutes.prepare','treasury.prepare','treasury.upload','dues.self','dues.ledger','dues.manage','suggestions.create','documents.status','documents.sign','candidates.view'];
 case 'assistant_secretary': return [...reader,'building.view','minutes.prepare','treasury.prepare','dues.self','dues.ledger','dues.manage','suggestions.create','documents.status','documents.sign','candidates.view'];
 case 'treasurer':return ['calendar.view','reports.create','minutes.view','treasury.view','treasury.prepare','treasury.upload','dues.self','suggestions.create',...personal];
 case 'assistant_treasurer':case 'treasury_preparer':return ['calendar.view','reports.create','minutes.view','treasury.view','treasury.prepare','dues.self','suggestions.create',...personal];
 case 'warden':return [...reader,'building.view','dues.self','dues.ledger','suggestions.create','documents.status','candidates.view','proposals.create'];
 case 'member':return ['reports.create','minutes.view','treasury.view','dues.self','suggestions.create','settings.manage'];
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
 const table=match[1]==='user'?'users':'invitations',id=Number(match[2]);
 await withTransaction(async()=>{
 const account=await dbGet(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[id]);
 if(!account||(table==='invitations'&&(account.used_at||account.expires_at<=new Date().toISOString())))throw Object.assign(new Error('Officer account or pending invitation not found.'),{statusCode:404});
 if(account.role==='owner')throw Object.assign(new Error('The Worshipful Master administrator retains full access.'),{statusCode:403});
 const permissions=normalizePermissions(req.body.permissions,account.role),stored=permissionsForStorage(req.body.permissions,account.role);
 await dbRun(`UPDATE ${table} SET permissions_json=? WHERE id=?`,[JSON.stringify(stored),id]);
 await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',[req.user.id,'officer_permissions_changed',req.ip,JSON.stringify({key:req.body.key,name:account.name,before:resolvePermissions(account),after:permissions}),new Date().toISOString()]);
 });res.json({ok:true});
 }catch(e){next(e)}});
}
