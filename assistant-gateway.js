import { authenticateAssistantToken, authorizeAssistantRequest, completeAssistantRequest, captureHumanAssistantReview, observeHumanAssistantCompletion } from './assistant-access.js';
import { canonicalAssistantPath, isAssistantControlRoute, resolveAssistantAction, assistantError } from './assistant-actions.js';
import { withAuditActor } from './db.js';

const prefix = 'ss22_muse_';
const methodNames = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
export function assistantResponse(value, depth = 0) {
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map(item => assistantResponse(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key,item]) =>
    !/(?:token|password|secret|credential|assertion|inviteUrl|activationLink)/i.test(key)
    && (!/signature/i.test(key) || typeof item === 'boolean'))
    .map(([key,item]) => [key,assistantResponse(item,depth + 1)]));
}
const tokenFor = req => {
  const authorization = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] || '';
  const other = String(req.headers['x-lodge-token'] || '');
  const cookie = String(req.headers.cookie || '').split(';').some(part => part.trim().startsWith(`ss22_session=${prefix}`));
  if (other.startsWith(prefix) || cookie || (authorization.includes(prefix) && !bearer.startsWith(prefix))) {
    throw assistantError(401, 'Use the separate Muse Assistant bearer credential.');
  }
  return bearer.startsWith(prefix) ? bearer : null;
};

// Never retain credentials, reusable signature bytes or a full business response
// as an execution receipt. The business record remains the authority.
function receiptSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['ok','id','status','error','message','reference']) {
    if (['boolean','number'].includes(typeof value[key])) result[key] = value[key];
    else if (typeof value[key] === 'string') result[key] = value[key].slice(0, 500);
  }
  const documentId = value.documentId || value.document?.id;
  if (typeof documentId === 'string') result.documentId = documentId.slice(0,100);
  if (Array.isArray(value.refs)) result.refs = value.refs.filter(id=>typeof id==='string').slice(0,12).map(id=>id.slice(0,100));
  return result;
}

export function installAssistantGateway(app, { expectedOrigin }) {
  // This precedes every bridge, parser and static route, including routes which
  // use their own authentication. An unknown route is never a delegate escape.
  app.use(async (req, res, next) => {
    try {
      const token = tokenFor(req);
      if (!token) return next();
      if (req.headers.origin && req.headers.origin !== expectedOrigin(req)) throw assistantError(403, 'This assistant request has an untrusted origin.');
      const authenticated = await authenticateAssistantToken(token);
      if (!authenticated) throw assistantError(401, 'Muse Assistant access is unavailable.');
      req.assistant = authenticated.assistant;
      req.user = authenticated.user;
      req.assistantRawToken = token;
      req.authViaCookie = false;
      req.authTokenHash = null;
      req.authSessionId = null;
      req.authRawToken = null;
      const exactPath = canonicalAssistantPath(req.originalUrl);
      if (!isAssistantControlRoute(req.method, exactPath)) {
        const action = resolveAssistantAction(req.method, exactPath);
        if (['personal','unavailable'].includes(action.mode)) throw assistantError(403, 'This action requires your own review and tap.');
        if (!req.assistant.permissions.includes(action.id)) throw assistantError(403, 'This action has not been granted to Muse Assistant.');
      }
      next();
    } catch (error) { next(error); }
  });

  // Wrap only the final handler. Authentication, upload parsing and existing
  // rate limits run first; the last gate sees the actual body and file bytes.
  for (const verb of methodNames) {
    const register = app[verb].bind(app);
    app[verb] = (path, ...handlers) => {
      if (!handlers.length) return register(path);
      const flat = handlers.flat(Infinity);
      const last = flat.pop();
      if (typeof last !== 'function' || last.length === 4) return register(path, ...handlers);
      return register(path, ...flat, async (req, res, next) => {
        let execution = null;
        let summary = null;
        let settled = false;
        const finish = uncertain => {
          if (settled) return;
          settled = true;
          const work = req.assistant
            ? (execution && completeAssistantRequest(execution, { statusCode: res.statusCode, response: summary, uncertain: uncertain || res.statusCode >= 500 }))
            : observeHumanAssistantCompletion(req, { statusCode: res.statusCode, response: summary });
          Promise.resolve(work).catch(() => console.warn('An assistant execution receipt needs verification. No action was retried.'));
        };
        try {
          if (!req.assistant) {
            req.assistantPersonalReview = await captureHumanAssistantReview(req);
            const originalJson = res.json.bind(res);
            res.json = body => { summary = receiptSummary(body); return originalJson(body); };
            res.once('finish', () => finish(false));
            return await last(req, res, next);
          }
          // Revocation or rotation during upload must take effect before work.
          const fresh = await authenticateAssistantToken(req.assistantRawToken);
          if (!fresh) throw assistantError(401, 'Muse Assistant access is unavailable.');
          req.assistant = fresh.assistant;
          req.user = fresh.user;
          execution = await authorizeAssistantRequest(req);
          req.assistantExecution = execution;
          const originalJson = res.json.bind(res);
          res.json = body => { const safe = assistantResponse(body); summary = receiptSummary(safe); return originalJson(safe); };
          res.once('finish', () => finish(false));
          res.once('close', () => { if (!res.writableFinished) finish(true); });
          return await withAuditActor({ assistantId: req.assistant.id, assistantName: req.assistant.name,
            ownerUserId: req.user.id, requestId: execution?.request_id || execution?.requestId || null }, () => last(req, res, next));
        } catch (error) {
          if (execution && !res.headersSent) res.statusCode = error.statusCode || 500;
          if (execution) finish(true);
          next(error);
        }
      });
    };
  }
}
