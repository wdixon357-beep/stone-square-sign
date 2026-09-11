import assert from 'node:assert/strict';

import { generateMinutesDraft } from '../minutes.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Local minutes generation must not call an external service.'); };

try {
  const transcript = `Stone Square Lodge No. 22
Meeting date: Thursday, September 17, 2026
Present: W. Aaron Dixon-Saunders; William M. McDuffie; Adrian Reese; Brother Marcus Green
Excused: Jamal R. Sadler
Visitors: Brother Lionel Stone, Harmony Lodge No. 5
Opening
The Lodge opened in due form on the Master Mason Degree at 7:30 PM. A quorum was present.
Treasurer's Report
Receipt 1042 was received from Community Partner in the amount of $250.00. Check 312 was paid to Delmarva Utilities in the amount of $184.32.
Communications
A letter concerning the district meeting was read.
New Business and Motions
A motion was made and seconded to refer the request to committee. The motion carried. Adrian Reese will prepare the revised list by Thursday, October 1, 2026.
Closing
The Lodge closed in due form at 9:18 PM. Next stated communication: Thursday, October 1, 2026 at 7:30 PM.`;

  const draft = await generateMinutesDraft(transcript, { testResponse: '' });
  assert.equal(draft.meetingDate, '2026-09-17');
  assert.equal(draft.openingTime, '7:30 PM');
  assert.equal(draft.closingTime, '9:18 PM');
  assert.equal(draft.degree, 'Master Mason');
  assert.equal(draft.quorum, 'Quorum present');
  assert.equal(draft.officerAttendance.find((row) => row.name === 'Adrian Reese')?.status, 'present');
  assert.equal(draft.officerAttendance.find((row) => row.name === 'Jamal R. Sadler')?.status, 'excused');
  assert.equal(draft.income[0]?.amount, '$250.00');
  assert.equal(draft.income[0]?.party, 'Community Partner');
  assert.equal(draft.expenses[0]?.amount, '$184.32');
  assert.match(draft.sections.find((section) => section.heading === 'New Business and Motions')?.body || '', /MOTION:/);
  assert.match(draft.sections.find((section) => section.heading === 'New Business and Motions')?.body || '', /DISPOSITION:/);
  assert.equal(draft.sections.at(-1)?.heading, 'Prayer and Closing');
  assert.ok(draft.actionItems.some((item) => item.includes('Adrian Reese will prepare')));
  assert.ok(draft.warnings.some((item) => item.includes('organized this draft locally')));

  const narrative = await generateMinutesDraft(
    'On 09/17/2026 the Lodge opened at 7:30 PM. A quorum was established. '
      + 'Correspondence from the district was read. The committee reported on the building. '
      + 'A motion was made and seconded. The motion carried. The Lodge closed at 9:05 PM.',
    { testResponse: '' },
  );
  assert.ok(narrative.sections.some((section) => section.heading === 'Communications'));
  assert.ok(narrative.sections.some((section) => section.heading === 'Committee Reports'));
  assert.ok(narrative.sections.some((section) => section.heading === 'New Business and Motions'));
  assert.equal(narrative.closingTime, '9:05 PM');

  console.log('Local minutes generation passed without an API key or network call.');
} finally {
  globalThis.fetch = originalFetch;
}
