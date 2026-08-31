import { createSessionPolicy } from '../session-policy.js';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

console.log('\nSession renewal policy');

const now = Date.parse('2026-08-31T12:00:00.000Z');
const policy = createSessionPolicy({ lifetimeDays: '90', refreshWindowDays: '30' });
check('new sessions last 90 days',
  policy.expiresAt(now) === '2026-11-29T12:00:00.000Z', policy.expiresAt(now));
check('a session with more than 30 days left is not rewritten',
  !policy.shouldRefresh('2026-10-01T12:00:00.001Z', now));
check('a session entering its last 30 days is renewed',
  policy.shouldRefresh('2026-09-30T12:00:00.000Z', now));
check('an expired session is never renewed',
  !policy.shouldRefresh('2026-08-31T11:59:59.999Z', now));
check('an invalid expiration is never renewed', !policy.shouldRefresh('not-a-date', now));

const fallback = createSessionPolicy({ lifetimeDays: 'invalid', refreshWindowDays: 'invalid' });
check('invalid settings fail safely to 90 days with a 30 day refresh window',
  fallback.lifetimeDays === 90 && fallback.refreshWindowDays === 30,
  JSON.stringify(fallback));

console.log(failures === 0
  ? '\nSession renewal policy passed.\n'
  : `\n${failures} session policy failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
