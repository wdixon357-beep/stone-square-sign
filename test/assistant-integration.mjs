import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const port=3587,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.js'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,
 PORT:String(port),NODE_ENV:'test',DATABASE_URL:'',PGLITE_DIR:'',OWNER_EMAIL:'muse-owner@example.invalid',APP_BASE_URL:base,
 SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',OPENAI_API_KEY:'',MISSIVE_API_TOKEN:'',TRACKER_SSO_SHARED_SECRET:'',LODGE_ACCESS_CODE:''},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
const call=async(path,{token,method='GET',body,headers={}}={})=>{
 const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
};
try{
 let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 assert(ready,logs);
 const register=await call('/api/auth/register',{method:'POST',body:{email:'muse-owner@example.invalid',name:'Synthetic Master',password:'Synthetic example passphrase'}});
 assert.equal(register.status,201,JSON.stringify(register.data));const owner=register.data.token;assert(owner);
 const workspace=await call('/api/assistant/workspace',{token:owner});assert.equal(workspace.status,200,JSON.stringify(workspace.data));
 const permissions=workspace.data.capabilities.filter(item=>['standing','approval'].includes(item.mode)).map(item=>item.id);
 assert.equal((await call('/api/assistant/access',{method:'PUT',token:owner,body:{name:'Muse Test',permissions,enabled:true,expiresInDays:7}})).status,200);
 const issued=await call('/api/assistant/access/token',{method:'POST',token:owner,body:{}});assert.equal(issued.status,200);const muse=issued.data.token;assert(muse.startsWith('ss22_muse_'));
 assert.equal((await call('/api/assistant/me',{token:muse})).status,200);
 assert.equal((await call('/api/assistant/mcp',{token:muse})).status,405);
 const me=await call('/api/auth/me',{token:muse,headers:{'X-Stone-Square-Client':'web'}});assert.equal(me.status,200);assert.equal(me.cookie,null);assert.equal(me.data.session,null);
 assert.equal((await call('/api/minutes',{token:muse})).status,200);
 for(const [method,path] of [['POST','/api/documents/fake/sign'],['POST','/api/minutes/fake/master-attest'],['POST','/api/dispensations'],['POST','/api/proposals/fake/decision'],['POST','/api/building/requests/fake/decision'],['PUT','/api/profile/signature'],['POST','/api/reports/handoff'],['POST','/api/tracker/handoff'],['POST','/api/assistant/access/token'],['POST','/api/unknown']]){
  assert.equal((await call(path,{method,token:muse,body:{consent:true}})).status,403,path);
 }
 assert.equal((await call('/api/assistant/me',{headers:{Cookie:`ss22_session=${muse}`}})).status,401);
 assert.equal((await call('/api/assistant/mcp',{method:'POST',token:muse,body:{jsonrpc:'2.0',id:1,method:'initialize'},headers:{Origin:'https://untrusted.invalid'}})).status,403);
 const preview=await fetch(base+'/api/dispensations/preview',{method:'POST',headers:{Authorization:`Bearer ${muse}`,'Content-Type':'application/json'},body:JSON.stringify({requestDate:'2026-10-31',eventDate:'2026-11-14',requestDetails:'Synthetic meeting request',eventTime:'19:00',locationName:'Synthetic Hall',streetAddress:'1 Example Street',cityState:'Example, DE 19709',worshipfulMasterAddress:'2 Example Street',signerRoles:['secretary']})});
 assert.equal(preview.status,200,await preview.clone().text());assert.equal(preview.headers.get('X-Stone-Square-Preview'),'unsigned');assert.match(Buffer.from(await preview.arrayBuffer()).toString('ascii',0,5),/%PDF-/);
 const invitationBody={email:'synthetic-secretary@example.invalid',name:'Synthetic Secretary',role:'secretary',sendEmail:false};
 const inviteProposal=await call('/api/assistant/requests',{method:'POST',token:muse,body:{actionId:'owner.access',method:'POST',path:'/api/officers/invite',body:invitationBody,requestKey:'invitation-test-001'}});
 assert.equal(inviteProposal.status,201,JSON.stringify(inviteProposal.data));const inviteRequest=inviteProposal.data.request;
 assert.equal((await call(`/api/assistant/requests/${inviteRequest.id}/decision`,{method:'POST',token:owner,body:{decision:'approve',fingerprint:inviteRequest.fingerprint}})).status,200);
 const invite=await call('/api/officers/invite',{method:'POST',token:muse,body:invitationBody,headers:{'X-Assistant-Request-Id':inviteRequest.id,'Idempotency-Key':inviteRequest.id}});
 assert.equal(invite.status,201,JSON.stringify(invite.data));assert.equal(invite.data.inviteUrl,undefined);assert(!JSON.stringify(invite.data).includes('?invite='));
 const body={title:'Synthetic planning meeting',startDate:'2027-01-09',endDate:'2027-01-09',startTime:'19:00',endTime:'20:00',category:'lodge',status:'scheduled',location:'Synthetic room',description:'Isolated test only',allDay:false};
 assert.equal((await call('/api/lodge-calendar',{method:'POST',token:muse,body})).status,428);
 const proposal=await call('/api/assistant/requests',{method:'POST',token:muse,body:{actionId:'calendar.manage',method:'POST',path:'/api/lodge-calendar',body,requestKey:'calendar-test-001'}});
 assert.equal(proposal.status,201,JSON.stringify(proposal.data));const request=proposal.data.request;
 assert.equal((await call(`/api/assistant/requests/${request.id}/decision`,{method:'POST',token:muse,body:{decision:'approve',fingerprint:request.fingerprint}})).status,403);
 assert.equal((await call(`/api/assistant/requests/${request.id}/decision`,{method:'POST',token:owner,body:{decision:'approve',fingerprint:'wrong'}})).status,409);
 assert.equal((await call(`/api/assistant/requests/${request.id}/decision`,{method:'POST',token:owner,body:{decision:'approve',fingerprint:request.fingerprint}})).status,200);
 const headers={'X-Assistant-Request-Id':request.id,'Idempotency-Key':request.id};
 assert.equal((await call('/api/lodge-calendar',{method:'POST',token:muse,body:{...body,title:'Changed after approval'},headers})).status,409);
 const results=await Promise.all([call('/api/lodge-calendar',{method:'POST',token:muse,body,headers}),call('/api/lodge-calendar',{method:'POST',token:muse,body,headers})]);
 assert.deepEqual(results.map(item=>item.status).sort(),[201,409],JSON.stringify(results));
 let receipt;
 for(let i=0;i<20;i++){receipt=await call(`/api/assistant/requests/${request.id}`,{token:muse});if(receipt.data.request.status!=='executing')break;await new Promise(resolve=>setTimeout(resolve,30));}
 assert.equal(receipt.data.request.status,'completed',JSON.stringify(receipt.data));assert.equal(receipt.data.request.receipt.automaticRetryAllowed,false);
 const activity=await call('/api/admin/activity',{token:owner});assert.equal(activity.status,200,JSON.stringify(activity.data));
 const event=activity.data.events.find(item=>item.action==='lodge_calendar_event_created');assert.equal(event.actor,'Muse Test');assert.equal(event.actorType,'assistant');assert.equal(event.assistantRequestId,request.id);
 const mcp=await call('/api/assistant/mcp',{method:'POST',token:muse,body:{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'execute',arguments:{requestId:request.id}}}});assert.equal(mcp.data.result.isError,true);
 const rotation=await call('/api/assistant/access/token',{method:'POST',token:owner,body:{}});assert.equal(rotation.status,200);assert.equal((await call('/api/assistant/me',{token:muse})).status,401);
 assert.equal((await call('/api/assistant/access',{method:'DELETE',token:owner})).status,200);assert.equal((await call('/api/assistant/me',{token:rotation.data.token})).status,401);
 console.log('PASS: isolated server assistant auth, human-only signatures, exact approvals, concurrent single use, actor audit, MCP, credential rotation and revocation.');
}finally{server.kill();}
