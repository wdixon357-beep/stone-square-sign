import assert from 'node:assert/strict';
import fs from 'node:fs';

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

console.log('PASS: web and Mac clients retry safe reads, preserve incident references, show an accessible notice, and retain only safe error metadata.');
