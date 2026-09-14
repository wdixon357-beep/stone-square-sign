import assert from 'node:assert/strict';
import { statedMeetingDates, treasuryMeetingCycle, treasuryCycleEnding, applyTreasuryMeetingCycle } from '../treasury-period.js';

assert.deepEqual(statedMeetingDates(2026).filter(date => date.startsWith('2026-09')), ['2026-09-03', '2026-09-17']);
assert.deepEqual(statedMeetingDates(2026).filter(date => date.startsWith('2026-07') || date.startsWith('2026-08')), []);
assert.deepEqual(treasuryMeetingCycle('2026-09-14'), { previousMeeting:'2026-09-03', periodStart:'2026-09-04', periodEnd:'2026-09-17' });
assert.deepEqual(treasuryMeetingCycle('2026-09-17'), { previousMeeting:'2026-09-03', periodStart:'2026-09-04', periodEnd:'2026-09-17' });
assert.deepEqual(treasuryMeetingCycle('2026-09-18'), { previousMeeting:'2026-09-17', periodStart:'2026-09-18', periodEnd:'2026-10-01' });
assert.deepEqual(treasuryMeetingCycle('2026-08-15'), { previousMeeting:'2026-06-18', periodStart:'2026-06-19', periodEnd:'2026-09-03' });
assert.deepEqual(treasuryCycleEnding('2027-01-07'), { previousMeeting:'2026-12-17', periodStart:'2026-12-18', periodEnd:'2027-01-07' });

const filtered=applyTreasuryMeetingCycle({transactions:[
  {date:'2026-09-03',description:'previous cutoff'},
  {date:'2026-09-04',description:'first included'},
  {date:'2026-09-17',description:'meeting date included'},
  {date:'2026-09-18',description:'next cycle'},
  {date:'',description:'unknown posted date'},
],extractionNotes:[]},treasuryMeetingCycle('2026-09-14'));
assert.deepEqual(filtered.transactions.map(row=>row.description),['first included','meeting date included']);
assert.equal(filtered.extractionNotes.some(note=>note.includes('3 source entries were')),true);
console.log('Treasurer meeting-cycle schedule and source filtering tests passed.');
