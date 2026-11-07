process.env.DATABASE_URL='';process.env.PGLITE_DIR='';process.env.NODE_ENV='test';
import assert from 'node:assert/strict';
import express from 'express';
const db=await import('../db.js');
const access=await import('../assistant-access.js');
const {installAssistantGateway}=await import('../assistant-gateway.js');
await db.connect();
let server;
try {
  await db.initSchema();await access.initAssistantSchema();
  const createdAt=new Date().toISOString();
  const ownerId=(await db.dbRun('INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    ['instruction-routes@example.invalid','synthetic','Synthetic Owner','owner',createdAt])).lastID;
  const owner=await db.dbGet('SELECT * FROM users WHERE id=?',[ownerId]);
  const app=express();
  installAssistantGateway(app,{expectedOrigin:()=>origin});
  app.use(express.json());
  const requireAuth=(req,res,next)=>{
    if(req.assistant)return next();
    if(req.headers.authorization==='Bearer synthetic-owner-session'){req.user=owner;return next();}
    res.status(401).json({error:'Authentication required.'});
  };
  const requireOwner=(req,res,next)=>req.user?.role==='owner'?next():res.status(403).json({error:'Owner required.'});
  access.mountAssistantRoutes(app,{requireAuth,requireOwner});
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,{token='synthetic-owner-session',method='GET',body}={})=>{
    const response=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  let saved=await call('/api/assistant/access',{method:'PUT',body:{name:'Synthetic Muse',permissions:['calendar.manage'],enabled:true,expiresInDays:7}});
  assert.equal(saved.status,200);assert.equal(saved.data.assistant.commandExecution,false);assert.equal(saved.data.assistant.signatureExecution,false);
  const issued=await call('/api/assistant/access/token',{method:'POST',body:{}});assert.equal(issued.status,200);
  const token=issued.data.token;
  assert.equal((await call('/api/assistant/access',{token,method:'PUT',body:{commandExecution:true,signatureExecution:true}})).status,403);
  assert.equal((await call('/api/assistant/requests/unknown/instruction',{method:'POST',body:{fingerprint:'fake',instruction:'Synthetic instruction'}})).status,403);
  saved=await call('/api/assistant/access',{method:'PUT',body:{name:'Synthetic Muse',permissions:['calendar.manage'],commandExecution:true,signatureExecution:true}});
  assert.equal(saved.status,200);assert.equal(saved.data.assistant.commandExecution,true);assert.equal(saved.data.assistant.signatureExecution,true);
  const me=await call('/api/assistant/me',{token});
  assert.equal(me.status,200);assert.equal(me.data.assistant.commandExecution,true);assert.equal(me.data.assistant.signatureExecution,true);
  assert.match(me.data.instructions.commandInstructions,/owner delegation/);
  assert.equal(me.data.instructions.commandTools.includes('authorize_instruction'),true);
  const proposal=await call('/api/assistant/requests',{token,method:'POST',body:{actionId:'calendar.manage',method:'POST',path:'/api/lodge-calendar',
    body:{title:'Synthetic event only'},requestKey:'route-instruction-001'}});
  assert.equal(proposal.status,201,JSON.stringify(proposal.data));
  const request=proposal.data.request;
  assert.equal((await call(`/api/assistant/requests/${request.id}/instruction`,{token,method:'POST',body:{fingerprint:request.fingerprint,instruction:'Create the synthetic event.',consent:true}})).status,400);
  const instructed=await call(`/api/assistant/requests/${request.id}/instruction`,{token,method:'POST',body:{fingerprint:request.fingerprint,instruction:'Create the synthetic event.'}});
  assert.equal(instructed.status,200,JSON.stringify(instructed.data));assert.equal(instructed.data.request.status,'authorized');
  assert.equal(instructed.data.request.authorization.source,'owner_delegation');assert.equal(instructed.data.request.authorization.actorType,'assistant');
  assert.equal(instructed.data.request.authorization.independentlyVerifiedHumanInstruction,false);
  assert.equal((await call(`/api/assistant/requests/${request.id}/decision`,{token,method:'POST',body:{decision:'approve',fingerprint:request.fingerprint}})).status,403);
  console.log('PASS: owner-only delegation settings, assistant-only instruction relay, exact endpoint fields, unchanged personal decision boundary and truthful workspace metadata.');
} finally {if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
