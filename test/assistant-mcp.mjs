import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAssistantMcp } from '../assistant-mcp.js';

const calls=[];
let proposal={id:'proposal-123',status:'approved',method:'PATCH',path:'/api/admin/suggestions/1',body:{status:'Reviewed'}};
const handler=createAssistantMcp({port:3719,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify(url.includes('/requests/')?{request:proposal}:{ok:true}),{headers:{'Content-Type':'application/json'}});
}});
const invoke=async(method,params={},extra={})=>{
  let value,status=200;
  const res={status(code){status=code;return this},json(body){value=body;return this},end(){return this}};
  await handler({assistant:{id:'separate-assistant'},assistantRawToken:'synthetic-secret',body:{jsonrpc:'2.0',id:1,method,params},...extra},res);
  return {value,status};
};
assert.equal((await invoke('initialize',{protocolVersion:'2025-03-26'})).value.result.protocolVersion,'2025-03-26');
const names=(await invoke('tools/list')).value.result.tools.map(tool=>tool.name);
assert.deepEqual(names,['workspace','read','read_file','request_action','request_upload','authorize_instruction','requests','execute','request_signature','signature_status','sign_instruction']);
assert(!names.some(name=>/^(?:sign|attest|apply_signature|execute_signature)$/.test(name)));
for(const path of ['https://untrusted.invalid/api/minutes','//untrusted.invalid/api/minutes','/api/../admin','/api/%6dinutes','/api/profile/signature','/api/reports/handoff','/api/unknown']){
 const result=await invoke('tools/call',{name:'read',arguments:{path}});
 assert.equal(result.value.result.isError,true,path);
}
assert.equal(calls.length,0);
assert(!(await invoke('tools/call',{name:'read',arguments:{path:'/api/minutes'}})).value.result.isError);
assert.equal(calls[0].url,'http://127.0.0.1:3719/api/minutes');
assert.equal(calls[0].options.redirect,'error');
assert(!(await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123'}})).value.result.isError);
const executed=calls.at(-1);
assert.equal(executed.options.method,'PATCH');
assert.equal(executed.options.body,JSON.stringify(proposal.body));
assert.equal(executed.options.headers['Idempotency-Key'],'proposal-123');
assert.equal(executed.options.headers['X-Assistant-Request-Id'],'proposal-123');
const before=calls.length;
assert.equal((await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123',path:'/api/documents/1/sign'}})).value.result.isError,true);
assert.equal(calls.length,before);
proposal={...proposal,path:'/api/documents/1/sign',method:'POST'};
assert.equal((await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123'}})).value.result.isError,true);
assert.equal(calls.length,before+1,'personal execution stops after reading proposal');
assert.equal((await invoke('tools/list',{}, {assistant:null})).status,403);
const signatureBody={actionId:'owner.minutes-master',method:'POST',path:'/api/minutes/synthetic-record/master-attest',body:{},requestKey:'signature-test-001'};
assert(!(await invoke('tools/call',{name:'request_signature',arguments:signatureBody})).value.result.isError);
assert.equal(calls.at(-1).url,'http://127.0.0.1:3719/api/assistant/signature-requests');
assert.equal(calls.at(-1).options.method,'POST');
assert.deepEqual(JSON.parse(calls.at(-1).options.body),signatureBody);
assert(!(await invoke('tools/call',{name:'signature_status',arguments:{requestId:'signature-123'}})).value.result.isError);
assert.equal(calls.at(-1).url,'http://127.0.0.1:3719/api/assistant/signature-requests/signature-123');
assert.equal(calls.at(-1).options.method,'GET');
const signatureCalls=calls.length;
for(const args of [{requestId:'../confirm'},{requestId:'signature-123',consent:true},{requestId:'signature-123',ownerReviewed:true}]){
 assert.equal((await invoke('tools/call',{name:'signature_status',arguments:args})).value.result.isError,true);
}
assert.equal(calls.length,signatureCalls,'Status tool cannot carry an owner confirmation');
for(const [name,route] of [['authorize_instruction','requests'],['sign_instruction','signature-requests']]){
 const instruction={requestId:'request-123',fingerprint:'exact-fingerprint',instruction:'Please carry out this exact action.',instructionReference:'synthetic-message-123'};
 assert(!(await invoke('tools/call',{name,arguments:instruction})).value.result.isError);
 assert.equal(calls.at(-1).url,`http://127.0.0.1:3719/api/assistant/${route}/request-123/instruction`);
 assert.deepEqual(JSON.parse(calls.at(-1).options.body),{fingerprint:instruction.fingerprint,instruction:instruction.instruction,instructionReference:instruction.instructionReference});
 assert.equal((await invoke('tools/call',{name,arguments:{...instruction,ownerUserId:1}})).value.result.isError,true);
}
const fileBytes=Buffer.from('%PDF-1.7\nSynthetic file bytes only.');
const file={fieldname:'document',originalname:'example.pdf',mimetype:'application/pdf',data:fileBytes.toString('base64')};
const metadata={fieldname:file.fieldname,originalname:file.originalname,mimetype:file.mimetype,size:fileBytes.length,sha256:crypto.createHash('sha256').update(fileBytes).digest('hex')};
const upload={actionId:'owner.documents',method:'POST',path:'/api/documents',body:{title:'Synthetic PDF'},requestKey:'upload-test-123',files:[file]};
assert(!(await invoke('tools/call',{name:'request_upload',arguments:upload})).value.result.isError);
assert.deepEqual(JSON.parse(calls.at(-1).options.body).files,[metadata]);
proposal={id:'proposal-123',status:'authorized',method:'POST',path:'/api/documents',body:upload.body,files:[metadata]};
assert(!(await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123',files:[file]}})).value.result.isError);
assert(Buffer.isBuffer(calls.at(-1).options.body));
assert.match(calls.at(-1).options.headers['Content-Type'],/^multipart\/form-data; boundary=ss22-/);
assert(calls.at(-1).options.body.includes(Buffer.from(upload.body.title)));
assert(calls.at(-1).options.body.includes(fileBytes));
for(const changed of [{...file,originalname:'changed.pdf'},{...file,data:Buffer.from('changed').toString('base64')},{...file,mimetype:'text/plain'}]){
 const before=calls.length;
 assert.equal((await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123',files:[changed]}})).value.result.isError,true);
 assert.equal(calls.length,before+1,'Mismatched files must stop before business upload.');
}
for(const bad of [{...file,data:'%%%='},{...file,originalname:'../private.pdf'},{...file,data:'Zg='},{...file,url:'https://untrusted.invalid/file'},{...file,fieldname:'__proto__'}]){
 const before=calls.length;
 assert.equal((await invoke('tools/call',{name:'request_upload',arguments:{...upload,files:[bad]}})).value.result.isError,true);
 assert.equal(calls.length,before,'Malformed file input must not be forwarded.');
}
assert.equal((await invoke('tools/call',{name:'request_upload',arguments:{...upload,body:{title:42}}})).value.result.isError,true);
proposal={...proposal,status:'pending'};
assert.equal((await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123',files:[file]}})).value.result.isError,true);
// Complete signed documents are readable; isolated signature and private routes stay blocked.
let fileResult;
const fileHandler=createAssistantMcp({port:3719,fetchImpl:async()=>new Response(fileBytes,{headers:{'Content-Type':'application/pdf'}})});
await fileHandler({assistant:{id:'synthetic'},assistantRawToken:'synthetic',body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{path:'/api/documents/example/file'}}}},{json(value){fileResult=value;return this},status(){return this}});
assert.equal(fileResult.result.content[0].type,'resource',JSON.stringify(fileResult));
assert.equal(fileResult.result.content[0].resource.blob,fileBytes.toString('base64'));
assert.equal((await invoke('tools/call',{name:'read_file',arguments:{path:'/api/profile/signature'}})).value.result.isError,true);
proposal={id:'proposal-123',status:'authorized',method:'POST',path:'/api/documents/example/missive-draft/retry',body:{}};
assert.equal((await invoke('tools/call',{name:'execute',arguments:{requestId:'proposal-123'}})).value.result.isError,true,'Alternate email provider draft action is not delegated.');
console.log('PASS: fixed-loopback MCP, exact file bytes and hashes, delegated instruction forwarding, protected document resources, credential isolation and replay checks.');
