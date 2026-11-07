import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';

assert(!process.env.DATABASE_URL && !process.env.PGLITE_DIR,'Run only without a configured database.');
const work=await mkdtemp(join(tmpdir(),'ss22-muse-instructed-'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const base=`http://127.0.0.1:${port}`,loader=join(work,'isolation.mjs');
await writeFile(loader,`import dotenv from ${JSON.stringify(import.meta.resolve('dotenv'))};
import nodemailer from ${JSON.stringify(import.meta.resolve('nodemailer'))};
dotenv.config=()=>({parsed:{}});
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{if(new URL(url).origin!==${JSON.stringify(base)})throw new Error('External network disabled in isolated test.');return originalFetch(url,options)};
nodemailer.createTransport=()=>{throw new Error('External email disabled in isolated test.')};`);
const server=spawn(process.execPath,['--import',loader,'server.js'],{cwd:new URL('..',import.meta.url),
 env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),DATABASE_URL:'',PGLITE_DIR:'',OWNER_EMAIL:'muse-files@example.invalid',APP_BASE_URL:base,
 SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',OPENAI_API_KEY:'',MISSIVE_API_TOKEN:'',ZEFFY_API_KEY:'',TRACKER_SSO_SHARED_SECRET:'',LODGE_ACCESS_CODE:''},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',value=>logs+=value);server.stderr.on('data',value=>logs+=value);
async function api(path,{method='GET',token,body}={}){
 const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 return {status:response.status,data:await response.json()};
}
let muse;
async function mcp(name,args){
 const response=await api('/api/assistant/mcp',{method:'POST',token:muse,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
 assert.equal(response.status,200,JSON.stringify(response.data));
 return response.data.result;
}
const value=result=>{assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)};
try{
 let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,logs);
 const registration=await api('/api/auth/register',{method:'POST',body:{email:'muse-files@example.invalid',name:'Synthetic Owner',password:'Isolated example passphrase'}});
 assert.equal(registration.status,201,JSON.stringify(registration.data));const owner=registration.data.token;
 const workspace=await api('/api/assistant/workspace',{token:owner});
 const permissions=workspace.data.capabilities.filter(item=>['standing','approval'].includes(item.mode)).map(item=>item.id);
 assert.equal((await api('/api/assistant/access',{token:owner,method:'PUT',body:{name:'Synthetic Muse',permissions,expiresInDays:365,enabled:true}})).status,200);
 muse=(await api('/api/assistant/access/token',{token:owner,method:'POST',body:{}})).data.token;
 const initial=value(await mcp('workspace',{}));assert.equal(initial.assistant.commandExecution,false);assert.equal(initial.assistant.signatureExecution,false);
 // More than the generic 4 MiB JSON limit proves the authenticated file envelope.
 const document=await PDFDocument.create();document.addPage().drawText('Synthetic dispensation. Worshipful Master and Secretary.');
 const fileBytes=Buffer.concat([Buffer.from(await document.save()),Buffer.alloc(3_300_000,32)]);
 const file={fieldname:'document',originalname:'Résumé dispensation.pdf',mimetype:'APPLICATION/PDF',data:fileBytes.toString('base64')};
 const input={actionId:'owner.documents',method:'POST',path:'/api/documents',body:{title:'Synthetic dispensation\nSecond line'},requestKey:'file-instruction-001',files:[file]};
 const pending=value(await mcp('request_upload',input)).request;
 const instruction={requestId:pending.id,fingerprint:pending.fingerprint,instruction:'Upload this exact synthetic PDF for this isolated test.',instructionReference:'synthetic-message-001'};
 assert.equal((await mcp('authorize_instruction',instruction)).isError,true,'Owner delegation defaults off.');
 assert.equal((await api('/api/assistant/access',{token:muse,method:'PUT',body:{commandExecution:true}})).status,403,'Muse cannot grant itself access.');
 assert.equal((await api('/api/documents/example/missive-draft/retry',{token:muse,method:'POST',body:{}})).status,403,'Muse cannot use the alternate email provider.');
 const saved=await api('/api/assistant/access',{token:owner,method:'PUT',body:{name:'Synthetic Muse',permissions,expiresInDays:365,enabled:true,commandExecution:true,signatureExecution:true}});
 assert.equal(saved.status,200,JSON.stringify(saved));
 const effective=value(await mcp('workspace',{}));assert.equal(effective.assistant.commandExecution,true);assert.equal(effective.assistant.signatureExecution,true);
 assert.equal((await mcp('authorize_instruction',instruction)).isError,true,'Policy change invalidates old requests.');
 const current=value(await mcp('request_upload',{...input,requestKey:'file-instruction-002'})).request;
 const authorized=value(await mcp('authorize_instruction',{...instruction,requestId:current.id,fingerprint:current.fingerprint})).request;
 assert.equal(authorized.status,'authorized');assert.equal(authorized.authorization.source,'owner_delegation');
 const malformed={...file,data:Buffer.from('different bytes').toString('base64')};
 assert.equal((await mcp('execute',{requestId:current.id,files:[malformed]})).isError,true,'Wrong file never reaches upload.');
 const uploaded=value(await mcp('execute',{requestId:current.id,files:[file]}));
 assert(uploaded.document?.id,JSON.stringify(uploaded));
 assert.equal(uploaded.document.original_name,file.originalname);assert.equal(uploaded.document.title,input.body.title);
 const record=await api(`/api/documents/${uploaded.document.id}`,{token:owner});assert.equal(record.status,200);
 const download=await mcp('read_file',{path:`/api/documents/${uploaded.document.id}/file`});
 assert(!download.isError,JSON.stringify(download));assert.equal(download.content[0].type,'resource');
 const returned=Buffer.from(download.content[0].resource.blob,'base64');
 assert.equal(crypto.createHash('sha256').update(returned).digest('hex'),crypto.createHash('sha256').update(fileBytes).digest('hex'));
 let receipt;for(let i=0;i<30;i++){receipt=value(await mcp('requests',{requestId:current.id})).request;if(receipt.status!=='executing')break;await new Promise(resolve=>setTimeout(resolve,30));}
 assert.equal(receipt.status,'completed',JSON.stringify(receipt));assert.equal(receipt.receipt.automaticRetryAllowed,false);
 assert.equal(receipt.authorization.source,'owner_delegation');
 assert.equal((await mcp('execute',{requestId:current.id,files:[file]})).isError,true,'Repeat upload never duplicates the document.');
 const activity=await api('/api/admin/activity',{token:owner});
 const event=activity.data.events.find(item=>item.action==='document_uploaded');assert.equal(event.actorType,'assistant');assert.equal(event.assistantRequestId,current.id);
 console.log('PASS: real isolated MCP upload above 4 MiB, owner-only opt-in, stale-policy denial, exact bytes, protected download, truthful actor receipt and duplicate prevention.');
}finally{
 const exited=once(server,'exit');server.kill();await exited;await rm(work,{recursive:true,force:true});
}
