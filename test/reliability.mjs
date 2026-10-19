import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const web = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const activity = fs.readFileSync(new URL('../activity.js', import.meta.url), 'utf8');
const mac = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/APIClient.swift', import.meta.url), 'utf8');

assert.match(html, /id="reliabilityNotice"[^>]+aria-live="assertive"/);
assert.match(css, /\.reliability-notice/);
assert.match(web, /mayRetry = method === 'GET' \|\| method === 'HEAD'/);
assert.match(web, /ss22-pending-incidents-v1/);
assert.match(web, /The hosted monitor checks the service again within 30 minutes/);
assert.match(activity, /CREATE TABLE IF NOT EXISTS app_incidents/);
assert.doesNotMatch(activity, /req\.body\?\.sourceText/, 'incident endpoint must never retain private source content');
assert.match(server, /incidentReference: reference/);
assert.match(mac, /final class ReliabilityCenter/);
assert.match(mac, /ss22-pending-incidents-v1/);
assert.match(mac, /mayRetry = method == "GET" \|\| method == "HEAD"/);

const categorySource = server.slice(server.indexOf('const serverIncidentCategory ='), server.indexOf('app.use(async (error, req, res, _next) =>'));
assert.ok(categorySource.includes('const serverIncidentArea ='), 'Exercise the actual safe server incident classifiers');
const classifiers = vm.runInNewContext(`${categorySource}\n({category:serverIncidentCategory,area:serverIncidentArea})`);
assert.equal(classifiers.category({statusCode:502,code:'MINUTES_UNSUPPORTED_SECOND'},'/api/minutes/generate'),'MINUTES_UNSUPPORTED_SECOND');
assert.equal(classifiers.category({statusCode:502,code:'MINUTES_SECTION_EVIDENCE_INVALID'},'/api/minutes/generate'),'MINUTES_SECTION_EVIDENCE_INVALID');
assert.equal(classifiers.category({statusCode:502,code:'GENERATION_REQUEST_REJECTED'},'/api/reports/organize'),'GENERATION_REQUEST_REJECTED');
for (const code of ['private@example.org source text','PRIVATE_PERSON_NAME','MINUTES_PRIVATE_PERSON_NAME',null]) {
  assert.equal(classifiers.category({statusCode:502,code},'/api/minutes/generate'),'minutes_verification','An arbitrary code cannot leak a name or source into the incident log');
}
assert.equal(classifiers.category(new Error('Private unhandled request'),'/api/minutes/generate'),'server_error');
assert.equal(classifiers.area('/api/minutes/example/reorganize'),'minutes');
assert.equal(classifiers.area('/api/treasury/generate'),'treasury');
assert.equal(classifiers.area('/api/building/alerts'),'building');
assert.equal(classifiers.area('/api/unrecognized'),'Dashboard');
assert.match(server,/await recordAppIncident\(\{reference/,'Known 5xx causes are recorded before the client receives a reference');

console.log('PASS: web and Mac clients retry safe reads, preserve incident references, show an accessible notice, and retain only safe error metadata.');
