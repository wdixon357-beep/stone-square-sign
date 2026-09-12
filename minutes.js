import { CURRENT_OFFICERS } from './minutes-layout.js';

const nullableText = { type: ['string', 'null'] };

export const MINUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'presiding',
    'quorum', 'nextMeeting', 'present', 'excused', 'visitors', 'officerAttendance',
    'income', 'expenses', 'sections', 'warnings', 'sensitiveReview', 'actionItems'],
  properties: {
    meetingDate: nullableText,
    meetingType: { type: 'string' },
    degree: nullableText,
    openingTime: nullableText,
    closingTime: nullableText,
    presiding: nullableText,
    quorum: nullableText,
    nextMeeting: nullableText,
    present: { type: 'array', items: { type: 'string' } },
    excused: { type: 'array', items: { type: 'string' } },
    visitors: { type: 'array', items: { type: 'string' } },
    officerAttendance: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'title', 'status'],
        properties: {
          name: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string', enum: ['present', 'absent', 'excused', 'not_recorded'] },
        },
      },
    },
    income: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'reference', 'party', 'description', 'amount'],
        properties: {
          date: nullableText, reference: nullableText, party: nullableText,
          description: nullableText, amount: nullableText,
        },
      },
    },
    expenses: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'reference', 'party', 'description', 'amount'],
        properties: {
          date: nullableText, reference: nullableText, party: nullableText,
          description: nullableText, amount: nullableText,
        },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    sensitiveReview: { type: 'array', items: { type: 'string' } },
    actionItems: { type: 'array', items: { type: 'string' } },
  },
};

const SECTION_RULES = [
  ['Opening', /\b(opened|opening|called to order)\b/i],
  ['Roll Call and Quorum', /\b(roll call|quorum)\b/i],
  ['Sickness and Distress', /\b(sickness|distress|ill|hospital|bereave|funeral)\b/i],
  ['Praise Report', /\b(praise report|good news|recognition)\b/i],
  ['Good of the Order', /\bgood of the order\b/i],
  ['Reading of the Minutes', /\b(previous minutes|prior minutes|minutes (?:were )?read|reading of the minutes)\b/i],
  ["Treasurer's Report", /\b(treasurer|financial report|bank balance|account balance)\b/i],
  ['Demits', /\b(demit|transfer of membership)\b/i],
  ['Petitions', /\b(petition|petitioner)\b/i],
  ['Balloting', /\b(ballot|balloting)\b/i],
  ['Degree Work', /\b(degree work|entered apprentice|fellowcraft|master mason degree)\b/i],
  ['Communications', /\b(correspondence|communication|letter|email)\b/i],
  ['Unfinished Business', /\b(unfinished business|old business|previously tabled)\b/i],
  ['New Business and Motions', /\b(new business|motion|moved|seconded|vote|carried|failed|adopted)\b/i],
  ['Committee Reports', /\b(committee report|committee reported|committee chair)\b/i],
  ['Elections', /\b(election|elected|nomination)\b/i],
  ['Visitors', /\b(visitor|visiting brother)\b/i],
  ["Brothers' Remarks", /\b(remarks of the brothers|brothers? remarks)\b/i],
  ["Wardens' Remarks", /\b(wardens?'? remarks|remarks (?:by|from) (?:the )?(?:senior|junior) warden)\b/i],
  ["Past Masters' Remarks", /\b(past masters? remarks|past master spoke)\b/i],
  ["Grand Lodge Officers' Remarks", /\b(grand lodge officers?' remarks|remarks (?:by|from) (?:the )?(?:district deputy|grand master)|grand lodge visitation|official visitation)\b/i],
  ['Prayer and Closing', /\b(closed|closing prayer|closing)\b/i],
];

const comparableName = (value) => String(value || '').toLowerCase()
  .replace(/\b(brother|bro|worshipful|past master|pm|honorary|hpm)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

const namesMatch = (left, right) => {
  const a = comparableName(left);
  const b = comparableName(right);
  return a && b && (a === b || a.includes(b) || b.includes(a));
};

const cleanLine = (value) => String(value || '')
  .replace(/^\s*(?:speaker\s*\d+|unknown speaker)(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*[:\-]?\s*/i, '')
  .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/, '')
  .replace(/^\s*(?:[•*]|\d{1,2}[.)])\s+/, '')
  .replace(/[\u2013\u2014]/g, ',')
  .replace(/\s+/g, ' ')
  .trim();

const splitNames = (value) => {
  const protectedValue = String(value || '')
    .replace(/,\s*(PM|HPM|Jr\.?|Sr\.?|II|III|IV)\b/gi, ' $1')
    .replace(/,\s*([^,;]+\s+Lodge\s+No\.?\s*\d+)/gi, ' $1')
    .replace(/\s+(?:and|&)\s+/gi, ';');
  return [...new Set(protectedValue.split(/\s*[;,|]\s*/).map((name) => name
    .replace(/^brothers?\s+/i, 'Brother ').trim()).filter((name) => name && name.length > 2))];
};

const linesForLabel = (source, label) => {
  const matches = [];
  const expression = new RegExp(`^(?:officers?\\s+)?${label}\\s*[:\\-]\\s*(.+)$`, 'i');
  source.split(/\n+/).forEach((line) => {
    const match = expression.exec(cleanLine(line));
    if (match) matches.push(...splitNames(match[1]));
  });
  return [...new Set(matches)];
};

const dateFromText = (source) => {
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(source);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const numeric = /\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/.exec(source);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(source);
  if (!named) return null;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  return `${named[3]}-${String(months.indexOf(named[1].toLowerCase()) + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
};

const timeFromText = (source, words) => {
  const match = new RegExp(`(?:${words})[^.\\n]{0,45}?(\\d{1,2}:\\d{2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?))`, 'i').exec(source);
  return match ? match[1].replace(/\./g, '').toUpperCase() : null;
};

const headingForLine = (line) => {
  const cleaned = cleanLine(line);
  const candidate = cleaned.replace(/[:.]$/, '').trim();
  if (!candidate || candidate.length > 90 || /[.!?]$/.test(cleaned) || candidate.split(/\s+/).length > 10) return null;
  const known = SECTION_RULES.find(([heading, rule]) => (
    comparableName(candidate) === comparableName(heading) || rule.test(candidate)
  ))?.[0];
  if (known) return known;
  const headingShape = /^[A-Z][A-Za-z0-9\s'&/(),-]+$/.test(candidate)
    && !/\b(?:was|were|will|has|have|had|is|are|asked|stated|reported|discussed|approved|received|paid|made)\b/i.test(candidate);
  return headingShape ? candidate.replace(/\s+/g, ' ') : null;
};

const transcriptSegments = (source) => source.split(/\n+/).flatMap((rawLine) => {
  const line = cleanLine(rawLine);
  if (!line) return [];
  return line.split(/(?<=[.!?])\s+(?=[A-Z])/).map(cleanLine).filter(Boolean);
});

const isMetadataLine = (line) => /^stone square lodge\b/i.test(line)
  || /^(?:meeting date|date|meeting type|degree|opening time|closing time|presiding|quorum|next (?:meeting|stated communication)|(?:officers?\s+)?present|excused|absent|visitors?)\s*[:\-]/i.test(line);

const locallyOrganizedDraft = (source) => {
  const present = linesForLabel(source, 'present');
  const excused = linesForLabel(source, 'excused');
  const absent = linesForLabel(source, 'absent');
  const visitors = linesForLabel(source, 'visitors?');
  const sectionBodies = new Map();
  let activeHeading = null;
  const sensitiveReview = [];
  const actionItems = [];
  const explicitlyIncludeGrandLodgePresence = /\b(include|record) (?:the )?grand lodge (?:officer|visitor|presence)\b/i.test(source);

  for (const rawLine of source.split(/\n+/)) {
    let line = cleanLine(rawLine);
    if (!line || isMetadataLine(line)) continue;
    const inlineHeading = /^([^:]{2,70}):\s+(.+)$/.exec(line);
    if (inlineHeading) {
      const recognized = headingForLine(inlineHeading[1]);
      if (recognized) {
        activeHeading = recognized;
        if (!sectionBodies.has(activeHeading)) sectionBodies.set(activeHeading, []);
        line = inlineHeading[2];
      }
    }
    const explicitHeading = headingForLine(line);
    if (explicitHeading) {
      activeHeading = explicitHeading;
      if (!sectionBodies.has(activeHeading)) sectionBodies.set(activeHeading, []);
      continue;
    }
    for (const sentence of transcriptSegments(line)) {
      if (isMetadataLine(sentence)) continue;
      if (!explicitlyIncludeGrandLodgePresence
        && !/\b(?:grand lodge visitation|official visitation)\b/i.test(sentence)
        && /\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(sentence)) continue;
      if (/\b(diagnos|medical condition|medication|dues status|disciplin|allegation|family dispute)\b/i.test(sentence)) {
        sensitiveReview.push(sentence);
        const heading = /\b(diagnos|medical|medication)\b/i.test(sentence) ? 'Sickness and Distress' : 'Other Meeting Business';
        const safeText = heading === 'Sickness and Distress'
          ? 'A matter of sickness and distress was reported for private officer follow up.'
          : 'A private matter was referred for officer follow up.';
        const values = sectionBodies.get(heading) || [];
        if (!values.includes(safeText)) values.push(safeText);
        sectionBodies.set(heading, values);
        continue;
      }
      const heading = activeHeading || SECTION_RULES.find(([, rule]) => rule.test(sentence))?.[0] || 'Other Meeting Business';
      let body = sentence;
      if (/\b(motion was made|moved that|it was moved)\b/i.test(sentence) && !/^MOTION:/i.test(sentence)) body = `MOTION: ${sentence}`;
      if (/\b(motion|vote)\b/i.test(sentence) && /\b(carried|failed|adopted|defeated|tabled)\b/i.test(sentence) && !/^DISPOSITION:/i.test(sentence)) {
        body = /^MOTION:/i.test(body) ? body : `DISPOSITION: ${body}`;
      }
      const values = sectionBodies.get(heading) || [];
      values.push(body);
      sectionBodies.set(heading, values);
      if (/\b(will|assigned to|responsible for|no later than|deadline)\b/i.test(sentence)) actionItems.push(sentence);
    }
  }

  const orderedHeadings = [
    ...SECTION_RULES.map(([heading]) => heading),
    ...[...sectionBodies.keys()].filter((heading) => !SECTION_RULES.some(([known]) => known === heading)),
  ];
  const sections = orderedHeadings.filter((heading) => sectionBodies.get(heading)?.length).map((heading) => ({
    heading,
    body: [...new Set(sectionBodies.get(heading))].join('\n'),
  }));
  if (!sections.length) sections.push({ heading: 'Meeting Notes', body: cleanLine(source) });

  const transactions = transcriptSegments(source).filter((line) => /\$\s?\d|\b\d+\.\d{2}\b/.test(line)).map((line) => ({
    date: dateFromText(line),
    reference: /\b((?:check|receipt|invoice)\s*(?:number|no\.?|#)?\s*[a-z0-9-]+)\b/i.exec(line)?.[1] || null,
    party: /\b(?:received from|paid to|payment to|from|to)\s+(.+?)(?:\s+in the amount|\s+for\s+\$|,|\.|$)/i.exec(line)?.[1]?.trim() || null,
    description: line,
    amount: /\$\s?[\d,]+(?:\.\d{2})?|\b\d+\.\d{2}\b/.exec(line)?.[0] || null,
    kind: /\b(paid|payment to|expense|bill|invoice|check issued|reimburse)\b/i.test(line) ? 'expense'
      : /\b(received|income|collection|deposit|dues payment|receipt)\b/i.test(line) ? 'income' : null,
  })).filter((item) => item.kind);

  const meetingDate = dateFromText(source);
  const openingTime = timeFromText(source, 'opened|opening|called to order');
  const closingTime = timeFromText(source, 'closed|closing|adjourned');
  const presidingMatch = /\b(?:presiding|presided by)\s*[:\-]?\s*([^\n.]+)/i.exec(source);
  const nextMeetingMatch = /\b(next (?:stated communication|meeting)[^\n.]*)/i.exec(source);
  const meetingTypeMatch = /\bmeeting type\s*[:\-]\s*(.+?)(?=[.\n]|$)/i.exec(source);
  const degree = /\b(round[ -]?table)\b/i.test(source) ? 'Round Table'
    : /\b(first|entered apprentice) degree\b/i.test(source) ? 'First Degree'
      : /\b(second|fellow ?craft) degree\b/i.test(source) ? 'Second Degree'
        : /\b(third|master mason) degree(?: of masonry)?\b/i.test(source) ? 'Third Degree' : null;
  const warnings = ['The Sign app organized this draft locally. Compare it with the corrected Plaud transcript before attesting.'];
  if (!meetingDate) warnings.push('Confirm the meeting date.');
  if (!openingTime) warnings.push('Confirm the opening time.');
  if (!closingTime) warnings.push('Confirm the closing time.');
  if (!present.length) warnings.push('Confirm the attendance list.');

  return normalizeMinutesDraft({
    meetingDate,
    meetingType: meetingTypeMatch?.[1]?.trim()
      || (/\b(emergent|special) communication\b/i.exec(source)?.[0])
      || 'Stated Communication',
    degree,
    openingTime,
    closingTime,
    presiding: presidingMatch?.[1]?.trim() || null,
    quorum: /\b(?:no quorum|quorum (?:was |is )?not (?:present|established))\b/i.test(source) ? 'No'
      : /\bquorum (?:was |is )?(?:present|declared|established)\b/i.test(source) ? 'Yes' : null,
    nextMeeting: nextMeetingMatch?.[1]?.trim() || null,
    present,
    excused,
    visitors,
    officerAttendance: CURRENT_OFFICERS.map((officer) => ({
      ...officer,
      status: present.some((name) => namesMatch(name, officer.name)) ? 'present'
        : excused.some((name) => namesMatch(name, officer.name)) ? 'excused'
          : absent.some((name) => namesMatch(name, officer.name)) ? 'absent' : 'not_recorded',
    })),
    income: transactions.filter((item) => item.kind === 'income'),
    expenses: transactions.filter((item) => item.kind === 'expense'),
    sections,
    warnings,
    sensitiveReview,
    actionItems: [...new Set(actionItems)],
  });
};

const canonicalDegree = (value) => {
  const degree = String(value || '').trim();
  if (/^(?:first degree|entered apprentice(?: degree)?)$/i.test(degree)) return 'First Degree';
  if (/^(?:second degree|fellow ?craft(?: degree)?)$/i.test(degree)) return 'Second Degree';
  if (/^(?:third degree(?: of masonry)?|master mason(?: degree)?)$/i.test(degree)) return 'Third Degree';
  if (/^round[ -]?table$/i.test(degree)) return 'Round Table';
  return null;
};

const canonicalQuorum = (value) => {
  const quorum = String(value || '').trim();
  if (/^(?:yes|present|established|quorum present|quorum established)$/i.test(quorum)) return 'Yes';
  if (/^(?:no|no quorum|not present|not established)$/i.test(quorum)) return 'No';
  return null;
};

const cleanSavedSectionBody = (value) => String(value || '').split(/\n+/).filter((line) => (
  /\b(?:grand lodge visitation|official visitation)\b/i.test(line)
  || !/\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(line)
)).join('\n').trim();

export const normalizeMinutesDraft = (value = {}) => ({
  meetingDate: value.meetingDate || null,
  meetingType: /^(?:regular )?stated communication$/i.test(String(value.meetingType || ''))
    ? 'Stated Communication' : String(value.meetingType || 'Stated Communication').trim(),
  degree: canonicalDegree(value.degree),
  openingTime: value.openingTime ? String(value.openingTime).trim() : null,
  closingTime: value.closingTime ? String(value.closingTime).trim() : null,
  presiding: value.presiding ? String(value.presiding).trim() : null,
  quorum: canonicalQuorum(value.quorum),
  nextMeeting: value.nextMeeting ? String(value.nextMeeting).trim() : null,
  present: Array.isArray(value.present) ? value.present.map(String).filter(Boolean) : [],
  excused: Array.isArray(value.excused) ? value.excused.map(String).filter(Boolean) : [],
  visitors: Array.isArray(value.visitors) ? value.visitors.map(String).filter(Boolean) : [],
  officerAttendance: Array.isArray(value.officerAttendance) && value.officerAttendance.length
    ? value.officerAttendance.map((entry) => ({
    name: String(entry?.name || '').trim(),
    title: String(entry?.title || '').trim(),
    status: ['present', 'absent', 'excused', 'not_recorded'].includes(entry?.status)
      ? entry.status : 'not_recorded',
    })).filter((entry) => entry.name)
    : CURRENT_OFFICERS.map((officer) => ({ ...officer, status: 'not_recorded' })),
  income: Array.isArray(value.income) ? value.income.map((entry) => ({
    date: entry?.date ? String(entry.date).trim() : null,
    reference: entry?.reference ? String(entry.reference).trim() : null,
    party: entry?.party ? String(entry.party).trim() : null,
    description: entry?.description ? String(entry.description).trim() : null,
    amount: entry?.amount ? String(entry.amount).trim() : null,
  })) : [],
  expenses: Array.isArray(value.expenses) ? value.expenses.map((entry) => ({
    date: entry?.date ? String(entry.date).trim() : null,
    reference: entry?.reference ? String(entry.reference).trim() : null,
    party: entry?.party ? String(entry.party).trim() : null,
    description: entry?.description ? String(entry.description).trim() : null,
    amount: entry?.amount ? String(entry.amount).trim() : null,
  })) : [],
  sections: Array.isArray(value.sections)
    ? value.sections.map((section) => ({
      heading: String(section?.heading || '').trim(),
      body: cleanSavedSectionBody(section?.body),
    })).filter((section) => section.heading || section.body)
    : [],
  warnings: Array.isArray(value.warnings) ? value.warnings.map(String).filter(Boolean) : [],
  sensitiveReview: Array.isArray(value.sensitiveReview)
    ? value.sensitiveReview.map(String).filter(Boolean) : [],
  actionItems: Array.isArray(value.actionItems) ? value.actionItems.map(String).filter(Boolean) : [],
});

export const generateMinutesDraft = async (transcript, {
  testResponse = process.env.NODE_ENV === 'test' ? process.env.MINUTES_TEST_RESPONSE : '',
} = {}) => {
  const source = String(transcript || '').trim();
  if (source.length < 100) throw Object.assign(new Error('The transcript is too short to create reliable minutes.'), { statusCode: 400 });
  if (source.length > 500_000) throw Object.assign(new Error('The transcript is too long. Upload the Plaud text export for one meeting.'), { statusCode: 400 });

  if (testResponse) return normalizeMinutesDraft(JSON.parse(testResponse));
  return locallyOrganizedDraft(source);
};
