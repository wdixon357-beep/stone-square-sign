import crypto from 'node:crypto';
import express from 'express';
import { BUILDING_STORE_MAX_BODY_BYTES, buildingStoreHash, executeBuildingStoreOperation } from './building-store.js';

export const BUILDING_STORE_PATH = '/api/internal/building-store';
export const buildingStoreSignature = (secret, timestamp, requestId, rawBody) => crypto.createHmac('sha256', secret)
  .update(`${timestamp}\n${requestId}\n`).update(rawBody).digest('hex');

// Mount before the application's JSON parser so the signature authenticates the
// exact bytes received. This service credential does not grant dashboard access.
export function mountBuildingStore(app, { secret = process.env.BUILDING_STORE_BRIDGE_SECRET || '', now = Date.now,
  execute = executeBuildingStoreOperation } = {}) {
  app.all(BUILDING_STORE_PATH, (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  app.post(BUILDING_STORE_PATH, (req, res, next) => {
    if (Buffer.byteLength(secret) < 32) return res.status(503).json({ error: 'Building storage bridge is not configured.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json for building storage.' });
    next();
  }, express.raw({ type: 'application/json', limit: BUILDING_STORE_MAX_BODY_BYTES, inflate: false }), async (req, res) => {
    try {
      const timestamp = req.get('x-building-store-timestamp') || '';
      const requestId = req.get('x-building-store-request-id') || '';
      const signature = req.get('x-building-store-signature') || '';
      const time = now();
      if (!/^\d{13}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(time - Number(timestamp)) > 300_000
          || !/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(requestId)
          || !/^[a-f0-9]{64}$/.test(signature) || !Buffer.isBuffer(req.body)) {
        return res.status(401).json({ error: 'Building storage authentication failed.' });
      }
      const expected = buildingStoreSignature(secret, timestamp, requestId, req.body);
      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        return res.status(401).json({ error: 'Building storage authentication failed.' });
      }
      const decoded = req.body.toString('utf8');
      if (!Buffer.from(decoded).equals(req.body)) return res.status(400).json({ error: 'Invalid building storage UTF-8.' });
      let body;
      try { body = JSON.parse(decoded); }
      catch { return res.status(400).json({ error: 'Invalid building storage JSON.' }); }
      const result = await execute(body, { requestId, payloadSha256: buildingStoreHash(req.body), now: time });
      res.json({ result });
    } catch (error) {
      const status = [400, 409, 503].includes(error.statusCode) ? error.statusCode : 503;
      res.status(status).json({ error: status === 503 ? 'Building storage is temporarily unavailable.' : error.message });
    }
  });
  app.all(BUILDING_STORE_PATH, (_req, res) => res.status(405).json({ error: 'Use POST for building storage.' }));
  // Keep parser errors private and cache-proof without passing raw data to logs.
  app.use(BUILDING_STORE_PATH, (error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400)
    .json({ error: 'Building storage request could not be read.' }));
}
