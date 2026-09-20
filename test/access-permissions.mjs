import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolvePermissions, normalizePermissions } from '../access-control.js';
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));const base=`http://127.0.0.1:${port}`;
let log='';const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),NODE_ENV:'test',DATABASE_URL:'',PGLITE_DIR:'',OWNER_EMAIL:'access-owner@example.org',APP_BASE_URL:base,SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',WARDEN_EMAILS:'access-warden@example.org',LODGE_ACCESS_CODE:'',OPENAI_API_KEY:'',MINUTES_TEST_RESPONSE:''},stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
const pause=ms=>new Promise(r=>setTimeout(r,ms));let checks=0;const check=(text,condition)=>{assert.ok(condition,text);checks++;console.log('PASS '+text)};
async function api(p,t,method='GET',body){const r=await fetch(base+p,{method,headers:{...(t?{Authorization:`Bearer ${t}`} :{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};}
const password='Local access preview password';
async function invite(owner,role){const email=`access-${role}@example.org`;const r=await api('/api/officers/invite',owner.token,'POST',{email,name:`Preview ${role}`,role,sendEmail:false});assert.equal(r.status,201);return{email,invitationToken:new URL(r.data.inviteUrl).searchParams.get('invite')};}
async function accept(inv){const r=await api('/api/auth/register',null,'POST',{...inv,name:'Preview Officer',password});assert.equal(r.status,201);return r.data;}
try{
 for(let i=0;i<160;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await pause(100);}
 const o=await api('/api/auth/register',null,'POST',{email:'access-owner@example.org',name:'Preview WM',password});assert.equal(o.status,201);const owner=o.data;
 const officerInvite=await invite(owner,'officer');const catalog=await api('/api/admin/access',owner.token);check('Owner can inspect active and invited access',catalog.status===200&&catalog.data.capabilities.length>=13);
 const pending=catalog.data.accounts.find(x=>x.email===officerInvite.email);assert.ok(pending);
 const selected=['reports.create','minutes.view','treasury.view','signature.manage','settings.manage'];
 check('Owner can customize invitation before acceptance',(await api('/api/admin/access',owner.token,'PUT',{key:pending.key,permissions:selected})).status===200);
 const refreshedInvite=await invite(owner,'officer');
 check('Replacing invitation preserves customized permissions',JSON.stringify((await api('/api/admin/access',owner.token)).data.accounts.find(x=>x.email===officerInvite.email).permissions)===JSON.stringify([...selected].sort()));
 const officer=await accept(refreshedInvite);check('Accepted account inherits the exact invited permissions',JSON.stringify([...officer.user.permissions].sort())===JSON.stringify([...selected].sort()));
 check('Officer cannot change access',(await api('/api/admin/access',officer.token,'PUT',{key:pending.key,permissions:[]})).status===403);
 check('Anonymous access administration refused',(await api('/api/admin/access')).status===401);
 const ownerKey=`user:${owner.user.id}`;check('Owner cannot remove own administrative access',(await api('/api/admin/access',owner.token,'PUT',{key:ownerKey,permissions:[]})).status===403);
 const key=`user:${officer.user.id}`;check('Unknown permission rejected',(await api('/api/admin/access',owner.token,'PUT',{key,permissions:['admin.everything']})).status===400);
 for(const p of ['/api/minutes','/api/treasury'])check('Final reader can open '+p,(await api(p,officer.token)).status===200);
 for(const p of ['/api/minutes/generate','/api/treasury/generate','/api/treasury/drafts'])check('Final reader cannot create via '+p,(await api(p,officer.token,'POST',{})).status===403);
 const source='Meeting date: September 17, 2026\nThe meeting opened at 7:30 PM. Discussion of the meeting schedule. Lodge closed at 9:00 PM.';
 const form=new FormData();form.set('transcriptText',source);const r=await fetch(base+'/api/minutes/generate',{method:'POST',headers:{Authorization:`Bearer ${owner.token}`},body:form});const m=await r.json();assert.equal(r.status,201,JSON.stringify(m));
 check('Unfinished minutes hidden from final reader',(await api('/api/minutes',officer.token)).data.minutes.length===0);
 check('Unfinished minutes PDF cannot be guessed',(await api(`/api/minutes/${m.minutes.id}/pdf`,officer.token)).status===404);
 check('Arbitrary minutes preview blocked',(await api(`/api/minutes/${m.minutes.id}/preview`,officer.token,'POST',{})).status===403);
 const grant=[...selected,'minutes.prepare'];check('Owner grants preparation independently of role',(await api('/api/admin/access',owner.token,'PUT',{key,permissions:grant})).status===200);
 check('Preparation access does not expose another preparer draft',!(await api('/api/minutes',officer.token)).data.minutes.some(x=>x.id===m.minutes.id));
 check('Existing session receives updated capabilities',(await api('/api/auth/me',officer.token)).data.user.permissions.includes('minutes.prepare'));
 const ownForm=new FormData();ownForm.set('transcriptText',source);const ownResponse=await fetch(base+'/api/minutes/generate',{method:'POST',headers:{Authorization:`Bearer ${officer.token}`},body:ownForm});const ownMinutes=await ownResponse.json();
 check('A preparer can create and read his own unfinished minutes',ownResponse.status===201&&(await api('/api/minutes',officer.token)).data.minutes.some(x=>x.id===ownMinutes.minutes.id));
 await api('/api/admin/access',owner.token,'PUT',{key,permissions:selected});check('Revocation immediately hides drafts',(await api('/api/minutes',officer.token)).data.minutes.length===0);
 const assistant=await accept(await invite(owner,'assistant_secretary'));check('Adrian role can prepare treasury but cannot upload',assistant.user.permissions.includes('treasury.prepare')&&!assistant.user.permissions.includes('treasury.upload'));
 check('Assistant secretary can start blank treasury report',(await api('/api/treasury/drafts',assistant.token,'POST',{})).status===201);
 check('Assistant secretary cannot upload bank source',(await api('/api/treasury/generate',assistant.token,'POST',{})).status===403);
 const treasurer=await accept(await invite(owner,'treasurer'));check('Treasurer has personal dues, upload, and universal minutes viewing without the full Lodge ledger',treasurer.user.permissions.includes('dues.self')&&!treasurer.user.permissions.includes('dues.ledger')&&treasurer.user.permissions.includes('treasury.upload')&&treasurer.user.permissions.includes('minutes.view'));
 const warden=await accept(await invite(owner,'warden'));check('Warden has own proposals and final reports',warden.user.permissions.includes('proposals.create')&&warden.user.permissions.includes('minutes.view')&&warden.user.permissions.includes('treasury.view'));
 const viewer=await accept(await invite(owner,'viewer'));
 const pdf=await PDFDocument.create();pdf.addPage();const docForm=new FormData();docForm.set('document',new Blob([await pdf.save()],{type:'application/pdf'}),'test.pdf');docForm.set('title','Unassigned synthetic document');
 const docResponse=await fetch(base+'/api/documents',{method:'POST',headers:{Authorization:`Bearer ${owner.token}`},body:docForm});assert.equal(docResponse.status,201);const doc=(await docResponse.json()).document;
 await api('/api/admin/access',owner.token,'PUT',{key:`user:${viewer.user.id}`,permissions:['documents.sign']});
 check('Signing grant never exposes unassigned queue documents',(await api('/api/documents',viewer.token)).data.documents.length===0);
 check('Signing grant never exposes unassigned document detail',(await api(`/api/documents/${doc.id}`,viewer.token)).status===403);
 await api('/api/admin/access',owner.token,'PUT',{key:`user:${viewer.user.id}`,permissions:[]});
 check('Revoked status permission also blocks approvals',(await api('/api/approvals',viewer.token)).status===403);
 const treasuryInvite=await invite(owner,'treasury_preparer');
 const treasuryPending=(await api('/api/admin/access',owner.token)).data.accounts.find(x=>x.email===treasuryInvite.email);
 const treasuryPermissions=['treasury.prepare','treasury.view','dues.self','reports.create','signature.manage','settings.manage'];
 await api('/api/admin/access',owner.token,'PUT',{key:treasuryPending.key,permissions:treasuryPermissions});
 const expiryBefore=(await api('/api/officers',owner.token)).data.pending.find(x=>x.email===treasuryInvite.email).expires_at;
 check('Other officers cannot correct an invitation office',(await api('/api/officers/invitations/role',officer.token,'PUT',{email:treasuryInvite.email,role:'assistant_treasurer'})).status===403);
 check('Owner corrects Treasury Preparer to Assistant Treasurer',(await api('/api/officers/invitations/role',owner.token,'PUT',{email:treasuryInvite.email,role:'assistant_treasurer'})).status===200);
 const corrected=(await api('/api/officers',owner.token)).data.pending.find(x=>x.email===treasuryInvite.email);
 check('Corrected office preserves invitation expiry',corrected.role==='assistant_treasurer'&&corrected.expires_at===expiryBefore);
 const assistantTreasurer=await accept(treasuryInvite);
 check('Original link accepts correct office and preserves restricted access',assistantTreasurer.user.role==='assistant_treasurer'&&JSON.stringify(normalizePermissions(assistantTreasurer.user.permissions,'assistant_treasurer'))===JSON.stringify(normalizePermissions(treasuryPermissions,'assistant_treasurer')));
 const otherEmail='other-treasury@example.org';
 assert.equal((await api('/api/officers/invite',owner.token,'POST',{email:otherEmail,name:'Other test preparer',role:'treasury_preparer',sendEmail:false})).status,201);
 check('An occupied Assistant Treasurer seat cannot be assigned again',(await api('/api/officers/invitations/role',owner.token,'PUT',{email:otherEmail,role:'assistant_treasurer'})).status===409);
 check('Preparer implies view permission',normalizePermissions(['minutes.prepare']).includes('minutes.view'));
 check('Universal archives cannot be removed from an officer',JSON.stringify(resolvePermissions({role:'secretary',permissions_json:'[]'}))===JSON.stringify(['minutes.view','treasury.view']));
 const unlinkedMember=resolvePermissions({role:'member',permissions_json:'[]',roster_id:null});
 check('An unlinked legacy member receives no private Lodge record access',JSON.stringify(unlinkedMember)===JSON.stringify(['settings.manage']));
 const memberBaseline=resolvePermissions({role:'member',permissions_json:'[]',roster_id:999});
 check('Roster-linked member baseline survives an old empty permission record',['reports.create','minutes.view','treasury.view','dues.self','suggestions.create','settings.manage'].every(permission=>memberBaseline.includes(permission)));
 check('Officer can list both historical archives',(await api('/api/archives/minutes',officer.token)).status===200&&(await api('/api/archives/treasury',officer.token)).status===200);
 check('An unlinked officer cannot become an orphaned member account',(await api(`/api/admin/accounts/${officer.user.id}/role`,owner.token,'PUT',{role:'member'})).status===409);
 check('General Officer Access refuses unlinked Lodge Member invitations',(await api('/api/officers/invite',owner.token,'POST',{email:'unlinked-member@example.org',name:'Unlinked Member',role:'member',sendEmail:false})).status===400);
 console.log(`${checks} granular access checks passed.`);
 if(process.env.ACCESS_PREVIEW==='1'){console.log(`PREVIEW ${base} login access-warden@example.org password ${password}`);await new Promise(()=>{});}
}finally{server.kill('SIGTERM');}
