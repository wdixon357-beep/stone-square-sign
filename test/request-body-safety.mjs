// Isolated regression for GHSA-27r3-jxmh-p828 / CVE-2026-111181.
// The vendor's split-frame test waits for JSON parsing before sending the tail:
// https://github.com/expressjs/body-parser/commit/1260c3845f54502a05a87594f09a334786bb34d7
// This file never imports the application, opens a database or reads .env.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync } from 'node:zlib';

const filename = fileURLToPath(import.meta.url);
const fixture = { fixture: 'request-body-safety', value: 7 };
const json = Buffer.from(JSON.stringify(fixture));

if (process.argv.includes('--fixture-child')) {
  const expressRequire = createRequire(import.meta.resolve('express'));
  const express = expressRequire('express');
  const parserVersion = expressRequire('body-parser/package.json').version;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/healthy', (_req, res) => res.json({ ok: true }));
  app.post('/echo', async (req, res, next) => {
    try {
      if (req.headers['x-fixture-split'] === 'yes') {
        // The parent sends the remaining bytes only after this parser callback.
        process.send?.({ type: 'parsed' });
        if (!req.complete) await once(req, 'end');
      }
      res.json(req.body);
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, _next) => {
    res.status(Number(error.status) || 400).json({ error: error.type || 'invalid_body' });
  });
  const server = app.listen(0, '127.0.0.1', () => {
    process.send?.({ type: 'ready', port: server.address().port, parserVersion });
  });
  process.once('message', message => {
    if (message?.type === 'stop') server.close(() => process.disconnect());
  });
} else {
  let stderr = '';
  const child = fork(filename, ['--fixture-child'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8_192); });
  const childExit = once(child, 'exit');
  const message = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${type}.`)), 5_000);
    const received = value => { if (value?.type === type) done(null, value); };
    const exited = (code, signal) => done(new Error(`Fixture exited before ${type}: ${signal || code}. ${stderr}`));
    const done = (error, value) => {
      clearTimeout(timer); child.off('message', received); child.off('exit', exited);
      if (error) reject(error); else resolve(value);
    };
    child.on('message', received); child.once('exit', exited);
  });
  let parserVersion;
  try {
    const ready = await message('ready');
    parserVersion = ready.parserVersion;
    // Reject vulnerable 2.x versions too; a higher major alone is not evidence.
    const [major, minor, patch] = ready.parserVersion.split('.').map(Number);
    assert((major === 1 && (minor > 20 || (minor === 20 && patch >= 9))) ||
      (major === 2 && minor >= 4), `Express loaded vulnerable or unreviewed body-parser ${ready.parserVersion}.`);
    const request = ({ path = '/echo', body, encoding, split = false } = {}) => new Promise((resolve, reject) => {
      const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {};
      if (encoding) headers['Content-Encoding'] = encoding;
      if (split) headers['X-Fixture-Split'] = 'yes';
      const req = http.request({ host: '127.0.0.1', port: ready.port, path,
        method: body ? 'POST' : 'GET', headers, agent: false }, response => {
        const chunks = []; let length = 0;
        response.on('data', bytes => {
          length += bytes.length;
          if (length > 8_192) req.destroy(new Error('Fixture response exceeded its bound.'));
          else chunks.push(bytes);
        });
        response.once('end', () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(5_000, () => req.destroy(new Error('Fixture request timed out.')));
      req.once('error', reject);
      if (split) {
        const tail = body.subarray(body.length - 1_024);
        message('parsed').then(() => req.end(tail), error => req.destroy(error));
        req.write(body.subarray(0, body.length - tail.length));
      } else req.end(body);
    });
    for (const [name, body, encoding] of [
      ['plain JSON', json, undefined],
      ['gzip JSON', gzipSync(json), 'gzip'],
      ['deflate JSON', deflateSync(json), 'deflate'],
    ]) {
      const response = await request({ body, encoding });
      assert.equal(response.status, 200, name);
      assert.deepEqual(response.body, fixture, name);
    }
    const splitDeflate = Buffer.concat([deflateSync(json), Buffer.from([0]), Buffer.alloc(1_024)]);
    const splitResponse = await request({ body: splitDeflate, encoding: 'deflate', split: true });
    assert.equal(splitResponse.status, 200);
    assert.deepEqual(splitResponse.body, fixture, 'Parser completion must not strand the remainder of the request.');
    const trailingGzip = Buffer.concat([gzipSync(json), Buffer.from([0]), Buffer.alloc(100 * 1_024, 0x58)]);
    const gzipResponse = await request({ body: trailingGzip, encoding: 'gzip' });
    assert([200, 400].includes(gzipResponse.status), 'Trailing compressed data must have a controlled response.');
    if (gzipResponse.status === 200) assert.deepEqual(gzipResponse.body, fixture);
    const malformed = await request({ path: '/no-matching-route', body: Buffer.from('invalid gzip fixture'), encoding: 'gzip' });
    assert.equal(malformed.status, 400, 'Malformed compressed bodies must fail safely before routing.');
    // The vendor regression waits for late decoder events before checking survival.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, `Decoder terminated the process: ${stderr}`);
    assert.deepEqual(await request({ path: '/healthy' }), { status: 200, body: { ok: true } });
  } finally {
    if (child.connected) child.send({ type: 'stop' });
    const stopped = await Promise.race([childExit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1_000))]);
    if (!stopped) { child.kill(); await childExit; }
  }
  const [exitCode, signal] = await childExit;
  assert.equal(exitCode, 0, `Fixture did not close cleanly: ${signal || exitCode}. ${stderr}`);
  console.log(`PASS: Express body-parser ${parserVersion}; plain/compressed JSON, split trailing bytes, malformed-body rejection, process survival and clean shutdown.`);
}
