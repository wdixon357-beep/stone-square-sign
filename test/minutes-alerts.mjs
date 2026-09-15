import assert from 'node:assert/strict';
import { minutesReviewAlert, minutesCompletionAlert } from '../minutes-alerts.js';
assert.equal(minutesReviewAlert({ id: 'one', meeting_date: '2026-09-03' }).title,
  'Meeting minutes awaiting your review: Thursday, September 3, 2026');
for (const date of [null, '', '2026-02-31', '<script>']) {
  assert(minutesReviewAlert({ meeting_date: date }).title.endsWith('meeting date not yet confirmed'));
}
assert.equal(minutesCompletionAlert({ id: 'one', meeting_date: '2026-09-03' }).title,
  'Meeting minutes are available to view');
assert.match(minutesCompletionAlert({ meeting_date: '2026-09-03' }).message, /Thursday, September 3, 2026/);
assert.equal(minutesCompletionAlert({}, { mayDistribute: true }).title,
  'WM review complete, ready to send to the Craft');
assert.match(minutesCompletionAlert({}, { mayDistribute: true }).message, /Historical meeting minutes/);
console.log('Minutes alert dates and missing-date handling passed.');
