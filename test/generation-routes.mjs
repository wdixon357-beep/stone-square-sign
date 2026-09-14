import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { notes, completeTreasuryFixture } from './treasury.mjs';

const work = await mkdtemp(join(tmpdir(), 'stone-square-generation-routes-'));
const callsFile = join(work, 'provider-calls.txt');
const controlFile = join(work, 'provider-control.json');
const releaseFile = join(work, 'provider-release');
const loaderFile = join(work, 'provider-loader.mjs');
const minutesSource = 'Meeting date: September 17, 2026\nPresent: Brother Example Officer\nThe Lodge opened on the Third Degree at 7:30 PM. A quorum was present.\nThe meeting schedule was discussed, with no vote recorded.\nThe Lodge closed at 9:00 PM.';
let server;
let base;
let passed = 0;
const check = (label, condition) => {assert.ok(condition, label); passed++; console.log(`PASS ${label}`);};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const providerCalls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
const control = value => writeFile(controlFile, JSON.stringify(value));
async function api(path, token, method = 'GET', body) {
  const form = body instanceof FormData;
  const response = await fetch(base + path, {method, headers: {
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
    ...(body && !form ? {'Content-Type': 'application/json'} : {}),
  }, body: body ? form ? body : JSON.stringify(body) : undefined});
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return {status: response.status, data, headers: response.headers};
}
async function stop() {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null) {server = null; return;}
  const ended = once(server, 'exit');
  server.kill('SIGTERM');
  await ended;
  server = null;
}
async function start(mocked) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  let output = '';
  server = spawn(process.execPath, [...(mocked ? ['--import', loaderFile] : []), 'server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '',
      OWNER_EMAIL: 'generation-owner@example.org', APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
      WARDEN_EMAILS: 'generation-warden@example.org',
      LODGE_ACCESS_CODE: '', DDGM_EMAIL: 'unused@example.org', OPENAI_API_KEY: '',
      MINUTES_TEST_RESPONSE: '', TREASURY_TEST_RESPONSE: ''},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => {output += data;}); server.stderr.on('data', data => {output += data;});
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output.slice(-3000)}`);
    try {if ((await fetch(base + '/api/health')).ok) return;} catch {}
    await pause(100);
  }
  throw new Error(`Test server did not start: ${output.slice(-3000)}`);
}
async function registerOwner() {
  const response = await api('/api/auth/register', null, 'POST', {email: 'generation-owner@example.org', name: 'Test WM', password: 'Private integration test password'});
  assert.equal(response.status, 201); return response.data;
}
async function officer(owner, role) {
  const email = `generation-${role}@example.org`;
  const invite = await api('/api/officers/invite', owner.token, 'POST', {email, name: `Test ${role}`, role, sendEmail: false});
  assert.equal(invite.status, 201);
  const response = await api('/api/auth/register', null, 'POST', {email, name: `Test ${role}`, password: 'Private integration test password', invitationToken: new URL(invite.data.inviteUrl).searchParams.get('invite')});
  assert.equal(response.status, 201); return response.data;
}
const bankingForm = (intent = 'save') => {const form = new FormData(); form.set('sourceText', notes); form.set('intent', intent); return form;};
const fixtureForCycle = report => {const draft=structuredClone(completeTreasuryFixture);Object.assign(draft,{previousMeetingDate:report.draft.previousMeetingDate,periodStart:report.draft.periodStart,periodEnd:report.draft.periodEnd});draft.transactions.forEach(row=>row.date=report.draft.periodStart);return draft;};
const minutesForm = () => {const form = new FormData(); form.set('transcriptText', minutesSource); return form;};

await writeFile(loaderFile, `
import {appendFile, readFile, access} from 'node:fs/promises';
import {createGenerator, setGenerationForTests} from ${JSON.stringify(new URL('../ai-generation.js', import.meta.url).href)};
import {generateMinutesDraft, MINUTES_SCHEMA} from ${JSON.stringify(new URL('../minutes.js', import.meta.url).href)};
const callsFile = ${JSON.stringify(callsFile)}, controlFile = ${JSON.stringify(controlFile)}, releaseFile = ${JSON.stringify(releaseFile)};
globalThis.fetch = async url => {
  if(String(url)!=='https://request.stonesquare22pha.org/api/report?schema=1')throw Error('Unexpected schema destination');
  return Response.json({types:{officer:{name:'Officer Report',fields:[{id:'title',label:'Title',kind:'text',req:true}]}},masterTypes:{officer:{name:'WM Report',fields:[{id:'title',label:'Title',kind:'text',req:true}]}}});
};
const fetchImpl = async (url, options) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected network destination in the provider mock.');
  await appendFile(callsFile, 'called\\n');
  const mode = JSON.parse(await readFile(controlFile, 'utf8')).mode;
  if (mode === 'error') return new Response(JSON.stringify({error:{message:'Synthetic request rejection'}}), {status:400, headers:{'Content-Type':'application/json'}});
  if (mode === 'unknown') return new Response(JSON.stringify({error:{message:'Synthetic service failure'}}), {status:503, headers:{'Content-Type':'application/json'}});
  if (mode === 'wait') {
    for (let count=0; count<300; count++) {try {await access(releaseFile); break;} catch {} await new Promise(resolve=>setTimeout(resolve,25));}
  }
  const body = JSON.parse(options.body);
  const rawInput = typeof body.input === 'string' ? body.input : body.input.at(-1)?.content;
  const inputText = typeof rawInput === 'string' ? rawInput : rawInput?.find(item=>item.type==='input_text')?.text;
  const input = JSON.parse(inputText);
  let result;
  if (body.text.format.name === 'stone_square_officer_report') {
    const title=input.source.includes('Source note mentions OpenAI')?'Source note mentions OpenAI':'Synthetic report notes';
    result={suggestions:[{field:'title',value:title,quote:title}],warnings:['GPT-5.6 Terra organized the report. Review each suggestion.']};
  } else if (body.text.format.name === 'stone_square_meeting_minutes') {
    const local = await generateMinutesDraft(input.source, {sourceType:input.sourceType});
    const draft = Object.fromEntries(Object.keys(MINUTES_SCHEMA.properties).map(key=>[key,local[key]]));
    const evidence=[];
    const add=field=>evidence.push({field,quote:input.source});
    for(const field of ['meetingDate','degree','openingTime','closingTime','prayerRequested','closingPrayerGiven','presiding','quorum','nextMeeting']) if(draft[field]!==null && draft[field]!=='')add(field);
    if(draft.meetingType!=='Stated Communication')add('meetingType');
    for(const field of ['present','excused','visitors','sensitiveReview'])draft[field].forEach((_,index)=>add(field+'['+index+']'));
    draft.sections.forEach((section,index)=>{if(section.body.trim())add('sections['+index+'].body');});
    draft.officerAttendance.forEach((entry,index)=>{if(entry.status!=='not_recorded')add('officerAttendance['+index+'].status');});
    result={draft,evidence};
  } else {
    const empty=()=>({value:null,evidence:''});
    result={periodStart:empty(),periodEnd:empty(),presentedOn:empty(),bankName:empty(),accounts:[],transactions:[],funds:[],obligations:[],remarks:empty()};
  }
  return new Response(JSON.stringify({id:'resp_route_test',model:'gpt-5.6-terra',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:1000,output_tokens:100}}), {status:200,headers:{'Content-Type':'application/json'}});
};
const generator=createGenerator({apiKey:'test-only-secret-that-must-not-leak',fetchImpl});
setGenerationForTests({...generator,forUser:userId=>async request=>{
  const mode=JSON.parse(await readFile(controlFile,'utf8')).mode;
  if(mode==='budget')throw Object.assign(new Error('The $5 monthly report allowance is fully used or reserved. You can continue editing reports manually.'),{statusCode:429,code:'GENERATION_MONTHLY_LIMIT'});
  return generator.forUser(userId)(request);
}});
`);

try {
  await control({mode: 'success'});
  await start(false);
  let owner = await registerOwner();
  check('Missing key keeps minutes generation local', (await api('/api/minutes/generate', owner.token, 'POST', minutesForm())).status === 201);
  check('Missing key keeps treasury generation local', (await api('/api/treasury/generate', owner.token, 'POST', bankingForm('complete'))).status === 201);
  check('Local generation makes no provider call', await providerCalls() === 0);
  await stop();

  await start(true);
  owner = await registerOwner();
  const preparer = await officer(owner, 'treasury_preparer');
  // This fixture explicitly receives upload access; ordinary preparers do not.
  assert.equal((await api('/api/admin/access',owner.token,'PUT',{key:`user:${preparer.user.id}`,permissions:[...preparer.user.permissions,'treasury.upload']})).status,200);
  const uploadOnly = await officer(owner, 'member');
  const warden = await officer(owner, 'warden');
  const secretary = await officer(owner, 'secretary');
  check('Generation status requires sign-in', (await api('/api/generation/status')).status === 401);
  const status = await api('/api/generation/status', owner.token);
  check('Owner can inspect generation status without a key leak', status.status === 200 && !JSON.stringify(status.data).includes('test-only-secret'));
  check('Only the owner receives the model and shared monthly allowance', status.data.model === 'gpt-5.6-terra' && status.data.monthlyLimitDollars === 5 && ['committedDollars','reservedDollars','remainingDollars'].every(key => typeof status.data[key] === 'number'));
  check('Generation status is never cached', /no-store/.test(status.headers.get('cache-control')));
  for (const [role, account] of [['preparer', preparer], ['member', uploadOnly], ['warden', warden], ['secretary', secretary]]) {
    const publicStatus = await api('/api/generation/status', account.token);
    check(`${role} generation status exposes only configuration availability`, publicStatus.status === 200 && JSON.stringify(publicStatus.data) === '{"configured":true}');
  }
  assert.equal((await api(`/api/treasury/access/${uploadOnly.user.id}`, owner.token, 'PUT', {enabled: true})).status, 200);
  let result = await api('/api/treasury/generate', uploadOnly.token, 'POST', bankingForm('save'));
  assert.equal(result.status, 201); let report = result.data.report;
  check('Upload-only saves original banking information without a model call', report.status === 'awaiting_preparer' && await providerCalls() === 0);
  check('Upload-only cannot choose report completion', (await api('/api/treasury/generate', uploadOnly.token, 'POST', bankingForm('complete'))).status === 403);
  result = await api(`/api/treasury/${report.id}/assign`, preparer.token, 'POST', {revision: report.revision, preparerUserId: preparer.user.id});
  assert.equal(result.status, 200); report = result.data.report;
  check('Treasury preparer can claim saved information without bank access', report.preparerUserId === preparer.user.id && await providerCalls() === 0);
  check('Upload-only cannot organize an assigned report', (await api(`/api/treasury/${report.id}/organize`, uploadOnly.token, 'POST', {revision: report.revision})).status === 403);
  check('Stale treasury revision is rejected before a paid call', (await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: 1})).status === 409 && await providerCalls() === 0);
  check('Invalid treasury revision is rejected before a paid call', (await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: String(report.revision)})).status === 409 && await providerCalls() === 0);
  result = await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: report.revision});
  check('Assigned preparer can organize the shared source', result.status === 200 && await providerCalls() === 1);
  check('Preparer generation notices do not disclose provider details', !/GPT|Terra|OpenAI|monthly|allowance|\$5/i.test(JSON.stringify(result.data.draft.extractionNotes)));
  check('Organization returns an unsaved replacement', (await api('/api/treasury', preparer.token)).data.reports.find(item => item.id === report.id).revision === report.revision);
  const beforeEditing = await providerCalls();
  check('Treasury PDF preview makes no provider call', (await api(`/api/treasury/${report.id}/preview`, preparer.token, 'POST', {draft: completeTreasuryFixture})).status === 200 && await providerCalls() === beforeEditing);
  result = await api(`/api/treasury/${report.id}`, preparer.token, 'PUT', {revision: report.revision, draft: {...completeTreasuryFixture, extractionNotes: ['Unique error-path context']}});
  assert.equal(result.status, 200); report = result.data.report;
  check('Saving treasury edits makes no provider call', await providerCalls() === beforeEditing);
  await control({mode: 'error'});
  const sourceBefore = (await api(`/api/treasury/${report.id}/source`, preparer.token)).data.text;
  result = await api(`/api/treasury/${report.id}/assign`, owner.token, 'POST', {revision: report.revision, preparerUserId: owner.user.id});
  check('WM explicitly takes over before editing another preparer report', result.status === 200 && result.data.report.preparerUserId === owner.user.id);
  report = result.data.report;
  check('The prior preparer loses write access after WM takeover', (await api(`/api/treasury/${report.id}`, preparer.token, 'PUT', {revision: report.revision, draft: completeTreasuryFixture})).status === 403);
  result = await api(`/api/treasury/${report.id}/organize`, owner.token, 'POST', {revision: report.revision});
  check('WM sees the provider failure after taking over the draft', result.status >= 500 && await providerCalls() > beforeEditing);
  check('Provider failure retains the original source and saved draft', (await api(`/api/treasury/${report.id}/source`, preparer.token)).data.text === sourceBefore && (await api('/api/treasury', preparer.token)).data.reports.find(item => item.id === report.id).revision === report.revision);
  result = await api(`/api/treasury/${report.id}/assign`, owner.token, 'POST', {revision: report.revision, preparerUserId: preparer.user.id});
  assert.equal(result.status, 200); report = result.data.report;
  result = await api(`/api/treasury/${report.id}`, preparer.token, 'PUT', {revision: report.revision, draft: fixtureForCycle(report)});
  assert.equal(result.status, 200); report = result.data.report;
  const beforeSigning = await providerCalls();
  const signature = 'data:image/png;base64,' + (await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim();
  assert.equal((await api('/api/profile/signature', preparer.token, 'PUT', {signatureData: signature, signatureType: 'drawn'})).status, 200);
  result = await api(`/api/treasury/${report.id}/preparer-attest`, preparer.token, 'POST', {revision: report.revision});
  assert.equal(result.status, 200); report = result.data.report;
  check('Treasury attestation makes no provider call', await providerCalls() === beforeSigning);
  check('Signed treasury reports cannot be organized', (await api(`/api/treasury/${report.id}/organize`, owner.token, 'POST', {revision: report.revision})).status === 403 && await providerCalls() === beforeSigning);

  await control({mode: 'success'});
  result = await api('/api/minutes/generate', owner.token, 'POST', minutesForm());
  assert.equal(result.status, 201); let minutes = result.data.minutes;
  let count = await providerCalls();
  check('WM can generate minutes through the model adapter', minutes.draft.warnings.some(warning => warning.includes('GPT-5.6 Terra')));
  check('Treasury-only preparer cannot invoke minutes generation', (await api('/api/minutes/generate', preparer.token, 'POST', minutesForm())).status === 403 && await providerCalls() === count);
  check('Missing minutes revision blocks reorganization before a provider call', (await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {})).status === 409 && await providerCalls() === count);
  check('Stale minutes revision blocks reorganization before a provider call', (await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: 'stale'})).status === 409 && await providerCalls() === count);
  check('Minutes PDF preview makes no provider call', (await api(`/api/minutes/${minutes.id}/preview`, owner.token, 'POST', {draft: minutes.draft})).status === 200 && await providerCalls() === count);
  await control({mode: 'wait'});
  const pending = api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: minutes.updatedAt, sourceType: 'compiled_notes'});
  for (let attempt = 0; attempt < 150 && await providerCalls() === count; attempt++) await pause(25);
  assert.ok(await providerCalls() > count, 'a fresh reorganization reached the held provider mock');
  result = await api(`/api/minutes/${minutes.id}`, owner.token, 'PUT', {expectedUpdatedAt: minutes.updatedAt, draft: {...minutes.draft, prayerRequested: false, closingPrayerGiven: false}});
  assert.equal(result.status, 200); minutes = result.data.minutes;
  await writeFile(releaseFile, 'continue');
  check('Minutes changed during generation reject the stale replacement', (await pending).status === 409);
  count = await providerCalls();
  assert.equal((await api('/api/profile/signature', owner.token, 'PUT', {signatureData: signature, signatureType: 'drawn'})).status, 200);
  result = await api(`/api/minutes/${minutes.id}/preparer-attest`, owner.token, 'POST', {expectedUpdatedAt: minutes.updatedAt});
  check('Minutes attestation makes no provider call', result.status === 200 && await providerCalls() === count);
  check('Attested minutes reject reorganization before a provider call', (await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: result.data.minutes.updatedAt})).status === 409 && await providerCalls() === count);
  const secretaryMinutes = (await api('/api/minutes', secretary.token)).data.minutes.find(item => item.id === minutes.id);
  check('Another preparer cannot read unfinished minutes or their provider notices', !secretaryMinutes);
  await control({mode:'success'});
  const reportInput={source:'Synthetic report notes',type:'officer',master:false,fields:{}};
  const countBeforeReport=await providerCalls();
  check('Report assistance requires sign-in', (await api('/api/reports/organize',null,'POST',reportInput)).status===401);
  check('Unassigned members cannot spend the report allowance', (await api('/api/reports/organize',uploadOnly.token,'POST',reportInput)).status===403);
  check('WM report organization requires owner role', (await api('/api/reports/organize',preparer.token,'POST',{...reportInput,master:true})).status===403);
  check('Invalid report fields are rejected before paid generation', (await api('/api/reports/organize',owner.token,'POST',{...reportInput,fields:{signatureName:'x'}})).status===400 && await providerCalls()===countBeforeReport);
  const organized=await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Owner receives supported report suggestions', organized.status===200 && organized.data.fields.title==='Synthetic report notes');
  check('The owner retains detailed generation notices', organized.data.warnings.some(warning => warning.includes('GPT-5.6 Terra')));
  check('Report suggestions do not include identity or signature approval', !Object.hasOwn(organized.data.fields,'signatureName') && !Object.hasOwn(organized.data.fields,'reviewed'));
  const afterReport=await providerCalls();
  await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Repeated identical organization uses the shared cache', await providerCalls()===afterReport);
  const wardenReport = await api('/api/reports/organize',warden.token,'POST',{...reportInput,source:'Source note mentions OpenAI'});
  check('Wardens can organize their own report fields', wardenReport.status === 200 && wardenReport.data.fields.title === 'Source note mentions OpenAI');
  check('Warden suggestions preserve source content but omit provider notices', wardenReport.data.fields.title.includes('OpenAI') && !/GPT|Terra|OpenAI|monthly|allowance|\$5/i.test(JSON.stringify(wardenReport.data.warnings)));
  const wardenCalls = await providerCalls();
  check('Wardens cannot organize a Worshipful Master report', (await api('/api/reports/organize',warden.token,'POST',{...reportInput,master:true})).status===403 && await providerCalls()===wardenCalls);
  await control({mode:'budget'});
  const wardenBudget = await api('/api/reports/organize',warden.token,'POST',reportInput);
  const ownerBudget = await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Warden limit errors omit spending and provider details', wardenBudget.status === 429 && /Worshipful Master/.test(wardenBudget.data.error) && !/GPT|Terra|OpenAI|monthly|allowance|\$5/i.test(wardenBudget.data.error));
  check('The owner can inspect the actual monthly-limit error', ownerBudget.status === 429 && ownerBudget.data.error.includes('$5 monthly'));
  await control({mode:'unknown'});
  const unknownInput = {...reportInput,source:'Synthetic report notes for an uncertain request'};
  const unknownResult = await api('/api/reports/organize',warden.token,'POST',unknownInput);
  const duplicateResult = await api('/api/reports/organize',warden.token,'POST',unknownInput);
  check('Unconfirmed and duplicate Warden requests hide charge and allowance details', unknownResult.status >= 500 && duplicateResult.status === 409 && [unknownResult, duplicateResult].every(item => !/GPT|Terra|OpenAI|charge|monthly|allowance|\$5/i.test(item.data.error)));
  console.log(`${passed} generation route checks passed with an isolated mocked provider.`);
} finally {
  await stop();
  await rm(work, {recursive: true, force: true});
}
