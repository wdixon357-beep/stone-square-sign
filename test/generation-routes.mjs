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
const inputsFile = join(work, 'provider-inputs.jsonl');
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
const minutesForm = (source = minutesSource) => {const form = new FormData(); form.set('transcriptText', source); return form;};

await writeFile(loaderFile, `
import {appendFile, readFile, access} from 'node:fs/promises';
import {createGenerator, setGenerationForTests} from ${JSON.stringify(new URL('../ai-generation.js', import.meta.url).href)};
import {generateMinutesDraft, MINUTES_SCHEMA} from ${JSON.stringify(new URL('../minutes.js', import.meta.url).href)};
const callsFile = ${JSON.stringify(callsFile)}, controlFile = ${JSON.stringify(controlFile)}, releaseFile = ${JSON.stringify(releaseFile)}, inputsFile = ${JSON.stringify(inputsFile)};
globalThis.fetch = async url => {
  if(String(url)!=='https://request.stonesquare22pha.org/api/report?schema=1')throw Error('Unexpected schema destination');
  return Response.json({types:{officer:{name:'Officer Report',fields:[{id:'title',label:'Title',kind:'text',req:true}]}},masterTypes:{officer:{name:'WM Report',fields:[{id:'title',label:'Title',kind:'text',req:true}]}}});
};
const fetchImpl = async (url, options) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected network destination in the provider mock.');
  await appendFile(callsFile, 'called\\n');
  const configuration = JSON.parse(await readFile(controlFile, 'utf8'));
  const mode = configuration.mode;
  if (mode === 'error') return new Response(JSON.stringify({error:{message:'Synthetic request rejection'}}), {status:400, headers:{'Content-Type':'application/json'}});
  if (mode === 'unknown') return new Response(JSON.stringify({error:{message:'Synthetic service failure'}}), {status:503, headers:{'Content-Type':'application/json'}});
  if (mode === 'wait') {
    for (let count=0; count<300; count++) {try {await access(releaseFile); break;} catch {} await new Promise(resolve=>setTimeout(resolve,25));}
  }
  const body = JSON.parse(options.body);
  const rawInput = typeof body.input === 'string' ? body.input : body.input.at(-1)?.content;
  const inputText = typeof rawInput === 'string' ? rawInput : rawInput?.find(item=>item.type==='input_text')?.text;
  const input = JSON.parse(inputText);
  await appendFile(inputsFile, JSON.stringify({schemaName:body.text.format.name,input})+'\\n');
  let result;
  if (body.text.format.name === 'stone_square_officer_report') {
    const title=input.source.includes('Source note mentions OpenAI')?'Source note mentions OpenAI':'Synthetic report notes';
    result={suggestions:[{field:'title',value:title,quote:title}],warnings:['GPT-5.6 Luna organized the report. Review each suggestion.', 'Historical GPT-5.6 Terra notice.']};
  } else if (body.text.format.name === 'stone_square_meeting_minutes') {
    const local = await generateMinutesDraft(input.source, {sourceType:input.sourceType});
    const draft = Object.fromEntries(Object.keys(MINUTES_SCHEMA.properties).map(key=>[key,local[key]]));
    if (!body.text.format.schema.properties.draft.properties.sections.items.required.includes('sourceQuotes')) throw Error('Minutes provider schema omitted section-local evidence');
    draft.sections = configuration.sections || draft.sections.map(section=>({...section,sourceQuotes:section.body.trim()?[input.source]:[]}));
    const evidence=[];
    const add=field=>evidence.push({field,quote:input.source});
    for(const field of ['meetingDate','degree','openingTime','closingTime','prayerRequested','closingPrayerGiven','presiding','quorum','nextMeeting']) if(draft[field]!==null && draft[field]!=='')add(field);
    if(draft.meetingType!=='Stated Communication')add('meetingType');
    for(const field of ['present','excused','visitors','sensitiveReview'])draft[field].forEach((_,index)=>add(field+'['+index+']'));
    draft.officerAttendance.forEach((entry,index)=>{
      if(entry.status!=='not_recorded')add('officerAttendance['+index+'].status');
      for(const field of ['stationCoverage','actingName','actingWholeMeeting'])if(entry[field]!==null&&entry[field]!=='')add('officerAttendance['+index+'].'+field);
    });
    result={draft,evidence:[...evidence,...(configuration.extraEvidence||[])]};
    if (mode === 'procedural_omission' || mode === 'unsupported_second') {
      const body = '- The minutes of the previous meeting were reviewed. The source states that the minutes were approved as submitted, but it does not identify a mover, seconder, vote method or tally.';
      draft.sections = [{heading:'Reading of the Minutes',body:body + (mode === 'unsupported_second' ? ' Brother Example seconded the motion.' : ''),sourceQuotes:[input.source]}];
    }
  } else {
    const empty=()=>({value:null,evidence:''});
    result={periodStart:empty(),periodEnd:empty(),presentedOn:empty(),bankName:empty(),accounts:[],transactions:[],funds:[],obligations:[],remarks:empty()};
  }
  return new Response(JSON.stringify({id:'resp_route_test',model:'gpt-5.6-luna',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:1000,output_tokens:100}}), {status:200,headers:{'Content-Type':'application/json'}});
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
  let localSaved=(await api('/api/treasury/generate',owner.token,'POST',bankingForm('save'))).data.report;
  check('Local upload stores a provider-neutral prefilled marker',localSaved.status==='awaiting_preparer'&&localSaved.draft.extractionNotes.includes('Application: uploaded banking information organized into this prefilled report.'));
  localSaved=(await api(`/api/treasury/${localSaved.id}/assign`,owner.token,'POST',{revision:localSaved.revision,preparerUserId:owner.user.id})).data.report;
  check('Local claim reuses the upload-time prefill without a provider or second organization',localSaved.status==='draft'&&localSaved.draft.extractionNotes.filter(note=>note==='Application: uploaded banking information organized into this prefilled report.').length===1);
  check('Local generation makes no provider call', await providerCalls() === 0);
  await stop();

  await start(true);
  owner = await registerOwner();
  const preparer = await officer(owner, 'treasury_preparer');
  // This fixture explicitly receives upload access; ordinary preparers do not.
  assert.equal((await api('/api/admin/access',owner.token,'PUT',{key:`user:${preparer.user.id}`,permissions:[...preparer.user.permissions,'treasury.upload']})).status,200);
  const uploadOnly = await officer(owner, 'officer');
  const warden = await officer(owner, 'warden');
  const secretary = await officer(owner, 'secretary');
  check('Generation status requires sign-in', (await api('/api/generation/status')).status === 401);
  const status = await api('/api/generation/status', owner.token);
  check('Owner can inspect generation status without a key leak', status.status === 200 && !JSON.stringify(status.data).includes('test-only-secret'));
  check('Only the owner receives administrator generation details, model and shared monthly allowance', status.data.administratorDetails === true && status.data.model === 'gpt-5.6-luna' && status.data.monthlyLimitDollars === 5 && ['committedDollars','reservedDollars','remainingDollars'].every(key => typeof status.data[key] === 'number'));
  check('Generation status is never cached', /no-store/.test(status.headers.get('cache-control')));
  for (const [role, account] of [['preparer', preparer], ['upload-only officer', uploadOnly], ['warden', warden], ['secretary', secretary]]) {
    const publicStatus = await api('/api/generation/status', account.token);
    check(`${role} generation status exposes only configuration availability`, publicStatus.status === 200 && JSON.stringify(publicStatus.data) === '{"configured":true}');
  }
  assert.equal((await api(`/api/treasury/access/${uploadOnly.user.id}`, owner.token, 'PUT', {enabled: true})).status, 200);
  let result = await api('/api/treasury/generate', uploadOnly.token, 'POST', bankingForm('save'));
  assert.equal(result.status, 201); let report = result.data.report;
  check('Upload-only banking information is organized into a prefilled report immediately', report.status === 'awaiting_preparer' && await providerCalls() === 1 && Object.keys(report.draft.fieldReviews).length > 0);
  check('Upload-only cannot choose report completion', (await api('/api/treasury/generate', uploadOnly.token, 'POST', bankingForm('complete'))).status === 403);
  result = await api(`/api/treasury/${report.id}/assign`, preparer.token, 'POST', {revision: report.revision, preparerUserId: preparer.user.id});
  assert.equal(result.status, 200); report = result.data.report;
  check('Treasury preparer claim reuses the prefilled report without a duplicate model call', report.preparerUserId === preparer.user.id && await providerCalls() === 1 && Object.keys(report.draft.fieldReviews).length > 0);
  check('Upload-only cannot organize an assigned report', (await api(`/api/treasury/${report.id}/organize`, uploadOnly.token, 'POST', {revision: report.revision})).status === 403);
  check('Stale treasury revision is rejected before another paid call', (await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: 1})).status === 409 && await providerCalls() === 1);
  check('Invalid treasury revision is rejected before another paid call', (await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: String(report.revision)})).status === 409 && await providerCalls() === 1);
  result = await api(`/api/treasury/${report.id}/organize`, preparer.token, 'POST', {revision: report.revision});
  check('Assigned preparer can deliberately request a fresh reorganization of the shared source', result.status === 200 && await providerCalls() === 2);
  check('Preparer generation notices do not disclose provider details', !/GPT|Terra|Luna|OpenAI|monthly|allowance|\$5/i.test(JSON.stringify(result.data.draft.extractionNotes)));
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
  check('The prior preparer loses write access after WM takeover', (await api(`/api/treasury/${report.id}`, preparer.token, 'PUT', {revision: report.revision, draft: completeTreasuryFixture})).status === 404);
  result = await api(`/api/treasury/${report.id}/organize`, owner.token, 'POST', {revision: report.revision});
  check('WM sees the provider failure after taking over the draft', result.status >= 500 && await providerCalls() > beforeEditing);
  check('Provider failure retains the original source and saved draft', (await api(`/api/treasury/${report.id}/source`, owner.token)).data.text === sourceBefore && (await api('/api/treasury', owner.token)).data.reports.find(item => item.id === report.id).revision === report.revision);
  result = await api(`/api/treasury/${report.id}/assign`, owner.token, 'POST', {revision: report.revision, preparerUserId: preparer.user.id});
  assert.equal(result.status, 200); report = result.data.report;
  result = await api(`/api/treasury/${report.id}`, preparer.token, 'PUT', {revision: report.revision, draft: fixtureForCycle(report)});
  assert.equal(result.status, 200); report = result.data.report;
  const beforeSigning = await providerCalls();
  const signature = 'data:image/png;base64,' + (await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim();
  assert.equal((await api('/api/profile/signature', preparer.token, 'PUT', {signatureData: signature, signatureType: 'drawn'})).status, 200);
  const unresolvedFixture=fixtureForCycle(report);unresolvedFixture.fieldReviews['accounts.0.openingBalance']='unresolved';
  result=await api(`/api/treasury/${report.id}`,preparer.token,'PUT',{revision:report.revision,draft:unresolvedFixture});assert.equal(result.status,200);report=result.data.report;
  check('An unresolved prefilled financial value blocks signing',(await api(`/api/treasury/${report.id}/preparer-attest`,preparer.token,'POST',{revision:report.revision})).status===409);
  result=await api(`/api/treasury/${report.id}`,preparer.token,'PUT',{revision:report.revision,draft:fixtureForCycle(report)});assert.equal(result.status,200);report=result.data.report;
  result = await api(`/api/treasury/${report.id}/preparer-attest`, preparer.token, 'POST', {revision: report.revision});
  assert.equal(result.status, 200); report = result.data.report;
  check('Treasury attestation makes no provider call', await providerCalls() === beforeSigning);
  check('Signed treasury reports cannot be organized', (await api(`/api/treasury/${report.id}/organize`, owner.token, 'POST', {revision: report.revision})).status === 403 && await providerCalls() === beforeSigning);

  const minutesBeforeFailure = (await api('/api/minutes', owner.token)).data.minutes.length;
  const callsBeforeMinutesFailure = await providerCalls();
  await control({mode: 'error'});
  result = await api('/api/minutes/generate', owner.token, 'POST', minutesForm());
  check('Paid minutes generation reports a provider failure instead of saving a local substitute',
    result.status >= 500 && (await api('/api/minutes', owner.token)).data.minutes.length === minutesBeforeFailure
      && await providerCalls() === callsBeforeMinutesFailure + 1);
  await control({mode: 'success'});
  result = await api('/api/minutes/generate', owner.token, 'POST', minutesForm());
  assert.equal(result.status, 201); let minutes = result.data.minutes;
  let count = await providerCalls();
  check('WM can generate minutes through the model adapter', minutes.draft.warnings.some(warning => warning.includes('GPT-5.6 Luna')));
  check('Treasury-only preparer cannot invoke minutes generation', (await api('/api/minutes/generate', preparer.token, 'POST', minutesForm())).status === 403 && await providerCalls() === count);
  check('Missing minutes revision blocks reorganization before a provider call', (await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {})).status === 409 && await providerCalls() === count);
  check('Stale minutes revision blocks reorganization before a provider call', (await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: 'stale'})).status === 409 && await providerCalls() === count);
  check('Minutes PDF preview makes no provider call', (await api(`/api/minutes/${minutes.id}/preview`, owner.token, 'POST', {draft: minutes.draft})).status === 200 && await providerCalls() === count);
  await control({mode: 'error'});
  result = await api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: minutes.updatedAt, sourceType: 'compiled_notes'});
  check('Paid reorganization failure preserves the existing saved minutes draft',
    result.status >= 500 && (await api('/api/minutes', owner.token)).data.minutes.find(item => item.id === minutes.id).updatedAt === minutes.updatedAt
      && await providerCalls() === count + 1);
  count = await providerCalls();
  await control({mode: 'wait'});
  const pending = api(`/api/minutes/${minutes.id}/reorganize`, owner.token, 'POST', {expectedUpdatedAt: minutes.updatedAt, sourceType: 'compiled_notes'});
  for (let attempt = 0; attempt < 150 && await providerCalls() === count; attempt++) await pause(25);
  assert.ok(await providerCalls() > count, 'a fresh reorganization reached the held provider mock');
  result = await api(`/api/minutes/${minutes.id}`, owner.token, 'PUT', {expectedUpdatedAt: minutes.updatedAt, draft: {
    ...minutes.draft,
    prayerRequested: false,
    closingPrayerGiven: false,
    officerAttendance: minutes.draft.officerAttendance.map(officer => ({...officer,status:'present'})),
    attendanceReview: {officerRoll:true,otherPresent:true,otherExcused:true},
  }});
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
  let countBeforeReport=await providerCalls();
  check('Report assistance requires sign-in', (await api('/api/reports/organize',null,'POST',reportInput)).status===401);
  const memberReport = await api('/api/reports/organize',uploadOnly.token,'POST',reportInput);
  check('Every Brother can organize a Lodge report through his assigned Report Generator', memberReport.status===200);
  check('Member report assistance does not disclose provider or allowance details', !/GPT|Terra|Luna|OpenAI|monthly|allowance|\$5/i.test(JSON.stringify(memberReport.data.warnings)));
  countBeforeReport=await providerCalls();
  check('WM report organization requires owner role', (await api('/api/reports/organize',preparer.token,'POST',{...reportInput,master:true})).status===403);
  check('Invalid report fields are rejected before paid generation', (await api('/api/reports/organize',owner.token,'POST',{...reportInput,fields:{signatureName:'x'}})).status===400 && await providerCalls()===countBeforeReport);
  const organized=await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Owner receives supported report suggestions', organized.status===200 && organized.data.fields.title==='Synthetic report notes');
  check('The owner retains detailed generation notices', organized.data.warnings.some(warning => warning.includes('GPT-5.6 Luna')));
  check('Report suggestions do not include identity or signature approval', !Object.hasOwn(organized.data.fields,'signatureName') && !Object.hasOwn(organized.data.fields,'reviewed'));
  const afterReport=await providerCalls();
  await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Repeated identical organization uses the shared cache', await providerCalls()===afterReport);
  const wardenReport = await api('/api/reports/organize',warden.token,'POST',{...reportInput,source:'Source note mentions OpenAI'});
  check('Wardens can organize their own report fields', wardenReport.status === 200 && wardenReport.data.fields.title === 'Source note mentions OpenAI');
  check('Warden suggestions preserve source content but omit provider notices', wardenReport.data.fields.title.includes('OpenAI') && !/GPT|Terra|Luna|OpenAI|monthly|allowance|\$5/i.test(JSON.stringify(wardenReport.data.warnings)));
  const wardenCalls = await providerCalls();
  check('Wardens cannot organize a Worshipful Master report', (await api('/api/reports/organize',warden.token,'POST',{...reportInput,master:true})).status===403 && await providerCalls()===wardenCalls);
  await control({mode:'budget'});
  const wardenBudget = await api('/api/reports/organize',warden.token,'POST',reportInput);
  const ownerBudget = await api('/api/reports/organize',owner.token,'POST',reportInput);
  check('Warden limit errors omit spending and provider details', wardenBudget.status === 429 && /Worshipful Master/.test(wardenBudget.data.error) && !/GPT|Terra|Luna|OpenAI|monthly|allowance|\$5/i.test(wardenBudget.data.error));
  check('The owner can inspect the actual monthly-limit error', ownerBudget.status === 429 && ownerBudget.data.error.includes('$5 monthly'));
  await control({mode:'unknown'});
  const unknownInput = {...reportInput,source:'Synthetic report notes for an uncertain request'};
  const unknownResult = await api('/api/reports/organize',warden.token,'POST',unknownInput);
  const duplicateResult = await api('/api/reports/organize',warden.token,'POST',unknownInput);
  check('Unconfirmed and duplicate Warden requests hide charge and allowance details', unknownResult.status >= 500 && duplicateResult.status === 409 && [unknownResult, duplicateResult].every(item => !/GPT|Terra|Luna|OpenAI|charge|monthly|allowance|\$5/i.test(item.data.error)));

  // A separate isolated server exercises the Assistant Secretary's actual
  // creation/reopen path without inheriting the previous suite's rate bucket.
  await stop();
  await start(true);
  owner = await registerOwner();
  const assistant = await officer(owner, 'assistant_secretary');
  const omissionSource = 'Meeting date: September 17, 2026\nPresent: Brother Example Officer\nThe Lodge opened on the Third Degree at 7:30 PM.\nMinutes of the previous meeting were reviewed.\nConclusion: Both were approved as submitted.\nThe Lodge closed at 9:00 PM.';
  await control({mode:'procedural_omission'});
  const beforeOmission = await providerCalls();
  const omission = await api('/api/minutes/generate', assistant.token, 'POST', minutesForm(omissionSource));
  assert.equal(omission.status,201,JSON.stringify(omission.data));
  const savedOmission = omission.data.minutes;
  check('Assistant Secretary can create a sourced draft that explicitly leaves mover and seconder unknown',
    savedOmission.status==='draft' && savedOmission.draft.sections.some(section=>section.body.includes('does not identify a mover, seconder')) && await providerCalls()===beforeOmission+1);
  const reopenedOmission = (await api('/api/minutes', assistant.token)).data.minutes.find(item=>item.id===savedOmission.id);
  check('Assistant Secretary can reopen the saved minutes with unknown procedural details intact',
    reopenedOmission?.draft.sections.some(section=>section.body.includes('does not identify a mover, seconder')) && reopenedOmission.preparerAttestedAt==null && reopenedOmission.masterAttestedAt==null);
  const beforeOmissionReview = await providerCalls();
  check('Generation leaves attendance confirmation and attestation with the officer',
    (await api(`/api/minutes/${savedOmission.id}/preparer-attest`,assistant.token,'POST',{expectedUpdatedAt:savedOmission.updatedAt})).status===409 && await providerCalls()===beforeOmissionReview);
  const cachedOmission = await api(`/api/minutes/${savedOmission.id}/reorganize`,assistant.token,'POST',{expectedUpdatedAt:savedOmission.updatedAt});
  check('Identical sourced organization reuses the verified cached result without a second paid call',
    cachedOmission.status===200 && await providerCalls()===beforeOmissionReview);
  const recordsBeforeUnsupported = (await api('/api/minutes',assistant.token)).data.minutes.length;
  await control({mode:'unsupported_second'});
  const unsupportedSource = omissionSource+'\nA separate proposal was discussed.';
  const unsupported = await api('/api/minutes/generate',assistant.token,'POST',minutesForm(unsupportedSource));
  check('A nearby unknown-seconder statement cannot hide a fabricated affirmative second',
    unsupported.status===502 && /^SS22-[A-Z0-9]+$/.test(unsupported.data.incidentReference||'') && /unsupported second/.test(unsupported.data.error));
  const currentActivity = (await api('/api/admin/activity',owner.token)).data;
  const captured = currentActivity.incidents.find(incident=>incident.reference===unsupported.data.incidentReference);
  check('The exact generation failure is recorded server-side with its actor, status and safe category',
    captured?.userId===assistant.user.id && captured.status===502 && captured.path==='/api/minutes/generate' && captured.category==='MINUTES_UNSUPPORTED_SECOND');
  check('The failure log contains no pasted source or provider payload',
    !JSON.stringify(captured).includes(unsupportedSource) && !JSON.stringify(captured).includes('Brother Example'));
  check('Rejected generation preserves the earlier saved draft without saving a substitute',
    (await api('/api/minutes',assistant.token)).data.minutes.length===recordsBeforeUnsupported && (await api('/api/minutes',assistant.token)).data.minutes.find(item=>item.id===savedOmission.id).updatedAt===savedOmission.updatedAt);
  const beforeUnsupportedRetry = await providerCalls();
  const unsupportedRetry = await api('/api/minutes/generate',assistant.token,'POST',minutesForm(unsupportedSource));
  check('Retrying a rejected cached interpretation does not make a silent paid retry',
    unsupportedRetry.status===502 && await providerCalls()===beforeUnsupportedRetry);

  // Keep this multipart regression isolated from the earlier rate bucket. Its
  // intentionally empty agenda sections must never shift a later body's quote.
  await stop();
  await start(true);
  owner = await registerOwner();
  const sectionAssistant = await officer(owner, 'assistant_secretary');
  const sourceLines = [
    'Meeting date: September 17, 2026',
    'Present: Brother Example Officer',
    'The Lodge opened on the Third Degree at 7:30 PM.',
    'Minutes of the previous meeting were approved as submitted.',
    'The Scholarship Committee will contact the school about the application deadline.',
    "The Treasurer's report was read aloud.",
    'The room reservation motion was tabled.',
    'Community Supper: Fish and two sides were proposed. No vote was taken.',
    'Prayers were requested for the families.',
    'The Lodge closed at 9:00 PM.',
  ];
  const sectionSource = sourceLines.join('\n');
  const sourcedSection = (heading, line) => ({heading,body:'- '+sourceLines[line-1],sourceQuotes:[sourceLines[line-1]]});
  const sectionFixture = [
    sourcedSection('Opening',3),
    {heading:'Balloting',body:'',sourceQuotes:[]},
    sourcedSection('Reading of the Minutes',4),
    {heading:'Elections',body:'',sourceQuotes:[]},
    sourcedSection('Committee Reports',5),
    sourcedSection("Treasurer's Report",6),
    {heading:'Petitions',body:'',sourceQuotes:[]},
    sourcedSection('Old Business',7),
    sourcedSection('New Business and Motions',8),
    sourcedSection('Sickness and Distress',9),
    sourcedSection('Prayer and Closing',10),
  ];
  await control({mode:'section_fixture',sections:sectionFixture});
  const beforeSectionFixture = await providerCalls();
  const sectionResult = await api('/api/minutes/generate',sectionAssistant.token,'POST',minutesForm(sectionSource));
  assert.equal(sectionResult.status,201,JSON.stringify(sectionResult.data));
  const sectionMinutes = sectionResult.data.minutes;
  const originalSectionInput=JSON.parse((await readFile(inputsFile,'utf8')).trim().split('\n').at(-1)).input.source;
  // Multipart text fields use CRLF on the wire. Retain that exact accepted
  // source when comparing the later reorganization request.
  assert.equal(originalSectionInput.replace(/\r\n/g,'\n'),sectionSource);
  check('Assistant Secretary multipart generation accepts interleaved empty agenda sections with section-local quotes',
    sectionMinutes.status==='draft' && await providerCalls()===beforeSectionFixture+1
      && sectionMinutes.draft.sections.some(section=>section.heading==='Old Business' && section.body.includes('reservation motion was tabled'))
      && sectionMinutes.draft.sections.some(section=>section.heading==='New Business and Motions' && section.body.includes('Fish and two sides')));
  check('Every populated section retains its own source-line comment after empty sections are removed',
    [['Opening',3],['Reading of the Minutes',4],['Committee Reports',5],["Treasurer's Report",6],['Old Business',7],['New Business and Motions',8],['Sickness and Distress',9],['Prayer and Closing',10]]
      .every(([heading,line])=>sectionMinutes.draft.warnings.includes(`Source reference: ${heading}, line ${line}.`)));
  check('Internal section quotes do not change the saved public draft shape',
    sectionMinutes.draft.sections.every(section=>Object.keys(section).sort().join(',')==='body,heading')
      && !JSON.stringify(sectionMinutes).includes('sourceQuotes'));
  let reopenedSectionMinutes = (await api('/api/minutes',sectionAssistant.token)).data.minutes.find(item=>item.id===sectionMinutes.id);
  check('The sourced Assistant Secretary draft reopens unchanged with no automatic review or signatures',
    JSON.stringify(reopenedSectionMinutes.draft)===JSON.stringify(sectionMinutes.draft)
      && reopenedSectionMinutes.preparerAttestedAt==null && reopenedSectionMinutes.masterAttestedAt==null
      && reopenedSectionMinutes.submittedForReviewAt==null && reopenedSectionMinutes.submittedDraft==null
      && ['officerRoll','otherPresent','otherExcused'].every(field=>reopenedSectionMinutes.draft.attendanceReview[field]===false));
  const beforeSectionCache = await providerCalls();
  const sectionCached = await api(`/api/minutes/${sectionMinutes.id}/reorganize`,sectionAssistant.token,'POST',{expectedUpdatedAt:sectionMinutes.updatedAt});
  check('Reorganizing the same verified section-local result uses cache without another provider call',
    sectionCached.status===200 && await providerCalls()===beforeSectionCache
      && JSON.stringify(sectionCached.data.draft)===JSON.stringify(sectionMinutes.draft));
  const sectionAttestation = await api(`/api/minutes/${sectionMinutes.id}/preparer-attest`,sectionAssistant.token,'POST',{expectedUpdatedAt:sectionMinutes.updatedAt});
  check('Accepted section quotes never confirm attendance or bypass the preparer attestation checks',
    sectionAttestation.status===409 && await providerCalls()===beforeSectionCache);

  const invalidSectionCases = [
    // The adapter's strict wire-schema check catches a missing required field
    // before the minutes-specific quote verifier receives the response.
    {name:'missing embedded quotes',mutate:sections=>{delete sections[4].sourceQuotes;},category:'GENERATION_INVALID_RESPONSE'},
    {name:'empty quotes on populated text',mutate:sections=>{sections[4].sourceQuotes=[];}},
    {name:'a quotation absent from the source',mutate:sections=>{sections[4].sourceQuotes=['The Scholarship Committee approved an unsupported budget.'];}},
    {name:'evidence attached to an empty section',mutate:sections=>{sections[1].sourceQuotes=[sourceLines[4]];}},
    {name:'obsolete parallel section indexes',extraEvidence:[{field:'sections[4].body',quote:sourceLines[4]}]},
    {name:'an unsupported affirmative second',mutate:sections=>{sections[8].body+=' Brother Example seconded the motion.';},category:'MINUTES_UNSUPPORTED_SECOND'},
  ];
  const sectionRecordsBefore = (await api('/api/minutes',sectionAssistant.token)).data.minutes.length;
  for (const [index,testCase] of invalidSectionCases.entries()) {
    const sections=structuredClone(sectionFixture);testCase.mutate?.(sections);
    await control({mode:'section_fixture',sections,extraEvidence:testCase.extraEvidence});
    const callsBefore=await providerCalls();
    const badSource=sectionSource+`\nSynthetic source case ${index+1}.`;
    const rejection=await api('/api/minutes/generate',sectionAssistant.token,'POST',minutesForm(badSource));
    const incident=(await api('/api/admin/activity',owner.token)).data.incidents.find(item=>item.reference===rejection.data.incidentReference);
    assert.equal(rejection.status,502,JSON.stringify(rejection.data));
    assert.equal(incident?.category,testCase.category||'MINUTES_SECTION_EVIDENCE_INVALID',testCase.name);
    check(`HTTP verification rejects ${testCase.name} before saving and records its safe category`,
      rejection.status===502 && /^SS22-[A-Z0-9]+$/.test(rejection.data.incidentReference||'')
        && incident?.category===(testCase.category||'MINUTES_SECTION_EVIDENCE_INVALID')
        && incident.userId===sectionAssistant.user.id && await providerCalls()===callsBefore+1
        && (await api('/api/minutes',sectionAssistant.token)).data.minutes.length===sectionRecordsBefore);
  }
  const invalidReorganization=structuredClone(sectionFixture);invalidReorganization[4].sourceQuotes=[];
  await control({mode:'section_fixture',sections:invalidReorganization});
  const beforeRejectedReorganization=await providerCalls();
  const rejectedReorganization=await api(`/api/minutes/${sectionMinutes.id}/reorganize`,sectionAssistant.token,'POST',{
    expectedUpdatedAt:sectionMinutes.updatedAt,sourceType:sectionMinutes.draft.sourceType==='transcript'?'compiled_notes':'transcript',
  });
  const inputs=(await readFile(inputsFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  reopenedSectionMinutes=(await api('/api/minutes',sectionAssistant.token)).data.minutes.find(item=>item.id===sectionMinutes.id);
  assert.equal(rejectedReorganization.status,502,JSON.stringify(rejectedReorganization.data));
  assert.equal(await providerCalls(),beforeRejectedReorganization+1,'reorganization explicitly requests one new interpretation');
  assert.equal(inputs.at(-1).input.source,originalSectionInput,'reorganization receives the original stored source');
  assert.deepEqual(reopenedSectionMinutes,sectionMinutes,'rejection does not rewrite any saved draft or workflow field');
  check('Rejected section reorganization retains the original source and the previously saved unsigned draft',
    rejectedReorganization.status===502 && await providerCalls()===beforeRejectedReorganization+1
      && inputs.at(-1).input.source===originalSectionInput
      && reopenedSectionMinutes.updatedAt===sectionMinutes.updatedAt
      && JSON.stringify(reopenedSectionMinutes.draft)===JSON.stringify(sectionMinutes.draft)
      && reopenedSectionMinutes.preparerAttestedAt==null && reopenedSectionMinutes.masterAttestedAt==null);
  console.log(`${passed} generation route checks passed with an isolated mocked provider.`);
} finally {
  await stop();
  await rm(work, {recursive: true, force: true});
}
