import assert from 'node:assert/strict';
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
assert.deepEqual(names,['workspace','read','request_action','requests','execute']);
assert(!names.some(name=>/sign|attest/.test(name)));
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
console.log('PASS: MCP fixed-loopback transport, exact saved execution, standing read allowlist, no personal tools, argument and credential isolation.');
