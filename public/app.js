const CLIENT_BUILD_VERSION = (() => {
  try {
    return new URL(document.currentScript.src).searchParams.get('v') || 'development';
  } catch {
    return 'development';
  }
})();

let minutesDates;
const minutesDatesReady = import(`/minutes-dates.js?v=${encodeURIComponent(CLIENT_BUILD_VERSION)}`).then(module => { minutesDates = module; });

const state = {
  legacyToken: localStorage.getItem('stone-square-sign-token') || '',
  authEpoch: 0,
  user: null,
  signingDocumentId: null,
  signingPdfObjectUrl: null,
  invitationToken: new URLSearchParams(window.location.search).get('invite') || '',
  invitationUrl: '',
  signatureRequired: false,
  signatureMode: 'drawn',
  selectedTypedStyle: 0,
  profileHasInk: false,
  realtimeAbort: null,
  refreshTimer: null,
  signatureObjectUrl: '',
  pdfObjectUrl: '',
  submissionProfiles: {},
  parsedDispensation: null,
  locationMatch: null,
  dispensationPreviewUrl: '',
  pendingReviewDocument: null,
  minutes: [],
  editingMinutesId: null,
  editingMinutesUpdatedAt: null,
  minutesPreviewUrl: '',
  minutesEditorDirty: false,
  reportHandoffExpiresAt: 0,
  reportHandoff: null,
  proposalDirty: false,
  dispensationDirty: false,
  minutesSourceDirty: false,
};
let treasuryWorkspace;
let buildingCalendarWorkspace;
let activityWorkspace,activityTracker;
const requestedWorkspaceSection = new URLSearchParams(window.location.search).get('section');

const $ = (id) => document.getElementById(id);
const modalFocusOrigins = new WeakMap();
const modalFocusSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const show = (element) => {
  element.classList.remove('hidden');
  if (element.classList.contains('modal')) {
    modalFocusOrigins.set(element, document.activeElement);
    element.setAttribute('aria-hidden', 'false');
    element.querySelector('.modal-body')?.scrollTo?.({ top: 0 });
    window.requestAnimationFrame(() => element.querySelector(modalFocusSelector)?.focus());
  }
};
const hide = (element) => {
  element.classList.add('hidden');
  if (element.classList.contains('modal')) {
    element.setAttribute('aria-hidden', 'true');
    const origin = modalFocusOrigins.get(element);
    if (origin?.isConnected) origin.focus({ preventScroll: true });
    modalFocusOrigins.delete(element);
  }
};
const authMessage = $('authMessage');
const docMessage = $('docMessage');
const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const setMessage = (element, text, isError = false) => {
  element.textContent = text || '';
  element.classList.toggle('error', isError);
  element.classList.toggle('success', Boolean(text) && !isError);
  element.classList.remove('warning');
};
const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const notificationMessage = (success, payload) => {
  const warnings = Array.isArray(payload?.notificationWarnings) ? payload.notificationWarnings.filter(Boolean) : [];
  return [success, ...warnings].join(' ');
};
const setNotificationMessage = (element, success, payload) => {
  const warnings = Array.isArray(payload?.notificationWarnings) ? payload.notificationWarnings.filter(Boolean) : [];
  setMessage(element, notificationMessage(success, payload));
  element.classList.toggle('warning', warnings.length > 0);
  element.classList.toggle('success', warnings.length === 0);
};
const draftStorageKey = name => state.user ? `ss22-web-draft:${state.user.id}:${name}` : '';
const writeSessionDraft = (name, fields) => {
  const key = draftStorageKey(name);
  if (!key) return;
  try { sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(fields.map(id => [id, $(id).value])))); } catch {}
};
const clearSessionDraft = name => {
  const key = draftStorageKey(name);
  if (key) try { sessionStorage.removeItem(key); } catch {}
};
const restoreSessionDraft = (name, fields) => {
  const key = draftStorageKey(name);
  if (!key) return false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!saved || typeof saved !== 'object') return false;
    let restored = false;
    fields.forEach(id => { if (typeof saved[id] === 'string' && saved[id]) { $(id).value = saved[id]; restored = true; } });
    return restored;
  } catch { return false; }
};

const PROPOSAL_DRAFT_FIELDS = ['propTitle','propDetails','propEventDate','propEventTime','propLocation','propStreet','propCityState','propNote'];
const DISPENSATION_DRAFT_FIELDS = ['dispPasteDetails','dispTitle','dispRequestDate','dispRequestDetails','dispEventDate','dispEventTime','dispLocationName','dispStreet','dispCityState'];
const MINUTES_SOURCE_DRAFT_FIELDS = ['minutesSourceType','minutesTranscriptText'];

const restoreWebDrafts = () => {
  if (restoreSessionDraft('proposal', PROPOSAL_DRAFT_FIELDS)) {
    state.proposalDirty = true;
    setMessage($('proposalMessage'), 'An unfinished proposal from this tab has been restored.');
  }
  if (restoreSessionDraft('dispensation', DISPENSATION_DRAFT_FIELDS)) {
    state.dispensationDirty = true;
    setMessage($('builderMessage'), 'An unfinished dispensation from this tab has been restored.');
  }
  if (restoreSessionDraft('minutes-source', MINUTES_SOURCE_DRAFT_FIELDS)) {
    state.minutesSourceDirty = true;
    setMessage($('minutesMessage'), 'Your unfinished meeting source from this tab has been restored.');
  }
};

const hasUnsavedWorkspace = section => ({
  proposals: state.proposalDirty,
  builder: state.dispensationDirty,
  minutes: state.minutesSourceDirty,
  treasury: Boolean(treasuryWorkspace?.dirty),
  calendar: Boolean(buildingCalendarWorkspace?.calendarDirty),
  building: Boolean(buildingCalendarWorkspace?.hasUnsavedRequest?.()),
  queue: Boolean($('accessControls')?.dirtyAccessKeys?.size),
}[section] || false);

document.addEventListener('keydown', event => {
  const modal = document.querySelector('.modal:not(.hidden)');
  if (!modal) return;
  if (event.key === 'Escape') {
    const close = modal.querySelector('.modal-close');
    if (close) { event.preventDefault(); close.click(); }
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.querySelectorAll(modalFocusSelector)].filter(element => element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

// Website updates must never replace entered report text or interrupt a request.
let webUpdateHasEntries = false;
let webUpdateLastActivity = Date.now();
let webUpdateRequests = 0;
let webUpdateCheckBusy = false;
let webUpdateDeferred = false;
try { webUpdateDeferred = sessionStorage.getItem('stone-square-web-update-deferred') === '1'; } catch {}
$('deferWebUpdate').addEventListener('click', () => {
  webUpdateDeferred = true;
  $('webUpdateBanner').classList.add('hidden');
  try { sessionStorage.setItem('stone-square-web-update-deferred', '1'); } catch {}
});
const noteWebActivity = () => { webUpdateLastActivity = Date.now(); };
const noteWebEntries = () => { webUpdateHasEntries = true; noteWebActivity(); };
document.addEventListener('input', noteWebEntries, true);
document.addEventListener('change', noteWebEntries, true);
document.addEventListener('pointerdown', event => {
  noteWebActivity();
  if (event.target.closest?.('canvas, [contenteditable="true"]')) noteWebEntries();
}, true);
document.addEventListener('keydown', noteWebActivity, true);
const webUpdateIsBusy = () => webUpdateRequests > 0 || Boolean(
  state.editingMinutesId || state.signingDocumentId || treasuryWorkspace?.busy || buildingCalendarWorkspace?.requestBusy ||
  document.querySelector('.modal:not(.hidden)') ||
  [...document.querySelectorAll('button[disabled]')].some(button => button.getClientRects().length)
);
const checkForWebUpdate = async () => {
  if (webUpdateCheckBusy || webUpdateDeferred) return;
  webUpdateCheckBusy = true;
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;
    const { version } = await response.json();
    if (webUpdateDeferred) return;
    const available = Boolean(version && version !== CLIENT_BUILD_VERSION);
    const banner = $('webUpdateBanner');
    banner.classList.toggle('hidden', !available);
    if (!available) return;
    const fieldFocused = document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (!webUpdateHasEntries && !webUpdateIsBusy() && !fieldFocused && Date.now() - webUpdateLastActivity >= 30000) {
      window.location.reload();
      return;
    }
    banner.querySelector('span').textContent = webUpdateHasEntries
      ? 'Your current work stays open. Save it before updating, or get the update on your next visit.'
      : 'The website will update automatically when you are not working.';
  } catch {
    // A temporary connection interruption is handled by the live queue indicator.
  } finally { webUpdateCheckBusy = false; }
};

$('applyWebUpdate').addEventListener('click', () => {
  if (webUpdateIsBusy()) {
    $('webUpdateBanner').querySelector('span').textContent = 'Your current work is still open. Choose Later to keep working, or finish and close the editor before updating.';
    return;
  }
  if (webUpdateHasEntries && !window.confirm('Reload for the website update? Any entries you have not saved will be lost. Select Cancel to return and save your work.')) return;
  window.location.reload();
});
window.setTimeout(checkForWebUpdate, 1500);
window.setInterval(checkForWebUpdate, 30000);

const apiFetch = async (path, init = {}) => {
  webUpdateRequests += 1;
  try {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-Stone-Square-Client': 'web',
      ...(state.legacyToken ? { Authorization: `Bearer ${state.legacyToken}` } : {}),
      ...(init.headers || {}),
    },
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw Object.assign(new Error(payload.error || 'The request could not be completed.'), { status: response.status });
  return payload;
  } finally { webUpdateRequests -= 1; }
};

const setActiveTab = (which) => {
  const mapping = {
    login: ['showLogin', 'loginForm'],
    register: ['showRegister', 'registerForm'],
    reset: ['showReset', 'forgotForm'],
  };
  Object.values(mapping).forEach(([buttonId, formId]) => {
    $(buttonId).classList.remove('active');
    hide($(formId));
  });
  $(mapping[which][0]).classList.add('active');
  show($(mapping[which][1]));
  setMessage(authMessage, '');
};

const roleLabel = (role) => ({
  owner: 'Worshipful Master / Administrator',
  secretary: 'Secretary',
  assistant_secretary: 'Assistant Secretary',
  treasurer: 'Treasurer',
  assistant_treasurer: 'Assistant Treasurer',
  treasury_preparer: 'Treasury Report Preparer',
  officer: 'Lodge Officer',
  member: 'Lodge Member',
  viewer: 'Lodge Viewer',
  warden: 'Warden',
}[role] || 'Signer');

const initials = (name) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const formatDate = (date) => {
  if (!date) return 'Date unavailable';
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(value);
};

/* An event date is a calendar day, not an instant. Parsing "2026-10-10" with new Date()
 * reads it as UTC midnight and shows the day before to anyone east of Greenwich, so build
 * the day from its own parts. */
const eventDayLabel = (value) => {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return value || '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(y, m - 1, d));
};

const formatClockTime = (value) => {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return value || '';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
    .format(new Date(2000, 0, 1, hour, minute));
};

const easternGreeting = () => {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York',
  }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

/* Who is ever asked for a saved signature. An allowlist, so a new role is never trapped
 * behind the forced signature modal that has no dismiss control. */
const can = (permission, user = state.user) => user?.role === 'owner' || Boolean(user?.permissions?.includes(permission));

const applyWorkspacePermissions = user => {
  $('minutesPageDescription').textContent = can('minutes.prepare', user) ? 'Prepare and review meeting minutes. The preparing officer attests, and the Worshipful Master reviews and authorizes distribution.' : 'Read finalized meeting minutes.';
  $('minutesMenuDescription').textContent = can('minutes.prepare', user) ? 'Prepare, review and attest to meeting records' : 'Read finalized meeting minutes';
  $('treasuryMenuDescription').textContent = can('treasury.prepare', user) ? (can('treasury.upload', user) ? 'Upload records, prepare and review reports' : 'Prepare reports and review assigned banking records') : (can('treasury.upload', user) ? 'Provide banking records and read finalized reports' : 'Read finalized treasurer reports');
  document.querySelectorAll('.building-only').forEach(element => element.classList.toggle('hidden', !(can('building.view', user) || can('building.request', user))));
  document.querySelectorAll('.calendar-only').forEach(element => element.classList.toggle('hidden', !can('calendar.view', user)));
  const maySeeTreasury = can('treasury.view', user) || can('treasury.prepare', user) || can('treasury.upload', user);
  document.querySelectorAll('.treasury-only').forEach(el => el.classList.toggle('hidden', !maySeeTreasury));
  ['reportsNav','reportsMenuCard'].forEach(id => $(id).classList.toggle('hidden', !can('reports.create', user)));
  $('settingsNav').classList.toggle('hidden', !can('settings.manage', user));
  $('settingsName').textContent = user.name; $('settingsEmail').textContent = user.email;
  $('settingsSignature').classList.toggle('hidden', !can('signature.manage', user));
  $('candidateMenuDescription').textContent = can('candidates.edit', user) ? 'View and update candidate records' : 'View candidate records';
  $('profileButton').classList.toggle('hidden',!can('signature.manage', user));
  $('whoami').textContent = user.name;
  $('userRole').textContent = roleLabel(user.role);
  $('userInitials').textContent = initials(user.name);
  $('builderMasterName').textContent = user.name;
  $('landingGreeting').textContent = `${easternGreeting()}, ${user.name}`;
  $('landingRole').textContent = roleLabel(user.role);
  document.querySelectorAll('.owner-only').forEach((element) => {
    element.classList.toggle('hidden', user.role !== 'owner');
  });
  /* Wardens can read Lodge status and submit their own proposals. Administrative
   * decisions remain restricted by the server and the owner controls. */
  document.querySelectorAll('.warden-only').forEach((element) => {
    element.classList.toggle('hidden', user.role === 'owner' || !can('proposals.create', user));
  });
  const line = document.querySelector('.landing-head p:not(.eyebrow)');
  if (line) line.textContent = user.role === 'warden' ? 'View Lodge status, prepare reports, and follow your dispensation proposals.' : 'Choose the area you want to open.';
  document.querySelectorAll('.signer-only').forEach((element) => {
    element.classList.toggle('hidden', !can('documents.status', user));
  });
  /* Dues names the men who are behind, so a viewer is not shown the tile at all.
   * The server refuses him regardless; this avoids dangling a locked door. */
  document.querySelectorAll('.candidate-only').forEach(element => element.classList.toggle('hidden', !can('candidates.view', user)));
  $('approvalsNav').classList.toggle('hidden', !can('documents.status', user) || !['owner','secretary','assistant_secretary','signer','viewer'].includes(user.role));
  const maySeeDues = can('dues.view', user);
  const maySeeMinutes = can('minutes.view', user) || can('minutes.prepare', user);
  document.querySelectorAll('.dues-only').forEach((element) => {
    element.classList.toggle('hidden', !maySeeDues);
  });
  document.querySelectorAll('.minutes-only').forEach((element) => {
    element.classList.toggle('hidden', !maySeeMinutes);
  });
  document.querySelectorAll('.preparer-only').forEach((element) => {
    element.classList.toggle('hidden', !can('minutes.prepare', user));
  });
  return { maySeeTreasury, maySeeMinutes };
};

const enterWorkspace = async (user, session) => {
  state.user = user;
  const sessionDays = Number(session?.lifetimeDays);
  const hasSessionPolicy = Number.isFinite(sessionDays) && sessionDays >= 1;
  $('sessionNotice').classList.toggle('hidden', !hasSessionPolicy);
  $('sessionDetails').classList.toggle('hidden', !hasSessionPolicy);
  if (hasSessionPolicy) $('sessionNoticeTitle').textContent = `You will stay signed in for ${sessionDays} days on this device.`;
  if(!activityWorkspace){const {ActivityWorkspace,ActivityTracker}=await import('/activity.js');activityWorkspace=new ActivityWorkspace({api:apiFetch,user:()=>state.user});activityTracker=new ActivityTracker({api:apiFetch,signedIn:()=>Boolean(state.user)});}
  if (!buildingCalendarWorkspace) { const { BuildingCalendarWorkspace } = await import('/building-calendar.js'); buildingCalendarWorkspace = new BuildingCalendarWorkspace({api: apiFetch, user: () => state.user}); }
  if (!treasuryWorkspace) { const { TreasuryWorkspace } = await import('/treasury.js'); treasuryWorkspace = new TreasuryWorkspace({ api: apiFetch, user: () => state.user }); }
  const { maySeeTreasury, maySeeMinutes } = applyWorkspacePermissions(user);
  restoreWebDrafts();
  showWorkspaceSection(requestedWorkspaceSection === 'activity' && user.role==='owner' ? 'activity' : requestedWorkspaceSection === 'treasury' && maySeeTreasury ? 'treasury' : requestedWorkspaceSection === 'minutes' && maySeeMinutes ? 'minutes' : 'home');
  hide($('authCard'));
  show($('appCard'));
  await refreshMinutesReviewAlerts();
  const [documents] = await Promise.all([
    renderDocuments(),
    user.role === 'owner' ? renderOfficers() : Promise.resolve(),
    user.role === 'owner' ? loadSubmissionProfiles() : Promise.resolve(),
  ]);
  if (user.hasSignature || !can('signature.manage', user)) showPendingSignatureNotice(user, documents || []);
  startRealtime();
  /* Only roles that actually sign are asked for a signature. This modal has no close button
   * when forced, so a role that can never sign would be trapped behind it with no way out. */
  if (!user.hasSignature && can('signature.manage', user)) window.setTimeout(() => openSignatureSetup(true), 150);
};

// Refresh access without rebuilding forms, clearing drafts, or restarting the workspace.
let permissionRefreshBusy = false;
const refreshSessionPermissions = async () => {
  if (permissionRefreshBusy || !state.user) return;
  permissionRefreshBusy = true;
  const userId = state.user.id;
  const authEpoch = state.authEpoch;
  try {
    const { user } = await apiFetch('/api/auth/me');
    if (!state.user || !user || state.authEpoch !== authEpoch || user.id !== userId || user.id !== state.user.id) return;
    const before = JSON.stringify([state.user.role, [...(state.user.permissions || [])].sort()]);
    const after = JSON.stringify([user.role, [...(user.permissions || [])].sort()]);
    state.user = user;
    if (before === after) return;
    applyWorkspacePermissions(user);
    showWorkspaceSection(state.activeSection || 'home', { skipLoad: true });
    treasuryWorkspace?.refreshPermissions();
    buildingCalendarWorkspace?.refreshPermissions();
    if (can('documents.status')) void renderDocuments();
    if (!can('documents.sign')) hide($('signModal'));
    if (!can('minutes.prepare')) hide($('minutesEditorModal'));
    if (!can('signature.manage')) hide($('signatureSetupModal'));
    $('permissionRefreshNotice').textContent = 'Your access has been updated. Entries on this page have been kept.';
    show($('permissionRefreshNotice'));
  } catch(error) {
    if (error.status === 401 && state.authEpoch === authEpoch && state.user?.id === userId) {
      state.authEpoch += 1;
      state.user = null;
      hide($('appCard')); document.querySelectorAll('.modal').forEach(hide); show($('authCard'));
      setMessage(authMessage, 'Your session is no longer authorized. Sign in again to continue.', true);
    }
  } finally { permissionRefreshBusy = false; }
};
window.setInterval(refreshSessionPermissions, 30000);
window.addEventListener('focus', refreshSessionPermissions);

const applySubmissionProfiles = () => {
  const owner = state.submissionProfiles.worshipful_master;
  $('dispMasterAddress').value = owner?.address || '';
  $('confirmSubmissionProfiles').checked = false;
  $('submissionProfilePrompt').textContent = owner
    ? `Yes, use ${owner.address} as my Worshipful Master address for this submission.`
    : 'Yes, use this Worshipful Master address for this submission.';
};

const fillFormFromParsedDispensation = () => {
  const fields = state.parsedDispensation?.fields;
  if (!fields) return;
  $('dispTitle').value = fields.title;
  $('dispRequestDate').value = fields.requestDate || builderTodayValue;
  $('dispRequestDetails').value = fields.requestDetails;
  $('dispEventDate').value = fields.eventDate;
  $('dispEventTime').value = fields.eventTime;
  $('dispLocationName').value = fields.locationName;
  $('dispStreet').value = fields.streetAddress;
  $('dispCityState').value = fields.cityState;
  applySubmissionProfiles();
  if (fields.worshipfulMasterAddress) $('dispMasterAddress').value = fields.worshipfulMasterAddress;
  $('confirmSubmissionProfiles').checked = false;
  const parsedFields = [
    'dispTitle', 'dispRequestDate', 'dispRequestDetails', 'dispEventDate',
    'dispEventTime', 'dispLocationName', 'dispStreet', 'dispCityState',
  ];
  parsedFields.forEach((id) => {
    const input = $(id);
    input.closest('.parsed-covered')?.classList.toggle('hidden', Boolean(input.value.trim()));
  });
  $('remainingQuestionsIntro').classList.remove('hidden');
  const missing = [
    ['dispRequestDetails', 'request details'], ['dispEventDate', 'event date'],
    ['dispEventTime', 'event time'], ['dispLocationName', 'location name'],
    ['dispStreet', 'street and number'], ['dispCityState', 'city, state, and ZIP'],
  ].filter(([id]) => !$(id).value.trim()).map(([, label]) => label);
  setMessage(
    $('builderMessage'),
    missing.length
      ? `Complete the missing required fields before review: ${missing.join(', ')}.`
      : 'The pasted details are ready. Complete the remaining Lodge questions.',
    missing.length > 0,
  );
  state.dispensationDirty = true;
  writeSessionDraft('dispensation', DISPENSATION_DRAFT_FIELDS);
  hide($('pasteReviewModal'));
};

const loadSubmissionProfiles = async () => {
  const { profiles } = await apiFetch('/api/submission-profiles');
  state.submissionProfiles = Object.fromEntries(profiles.map((profile) => [profile.role, profile]));
  applySubmissionProfiles();
};

const REPORT_GENERATOR_ORIGIN = 'https://request.stonesquare22pha.org';
const secureReportUrl = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== REPORT_GENERATOR_ORIGIN || url.searchParams.has('assertion')) {
    throw new Error('The secure Report Generator address could not be verified.');
  }
  return url.href;
};

const validateReportHandoff = handoff => {
  const url = secureReportUrl(handoff?.url);
  const expiresAt = Number(handoff?.expiresAt) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The secure Report Generator connection expired before it could open. Try again.');
  if (typeof handoff?.assertion !== 'string' || !handoff.assertion) throw new Error('The secure Report Generator connection could not be verified.');
  return { url, assertion: handoff.assertion, expiresAt };
};

const postReportAssertion = (connection, assertion, expiresAt) => {
  connection.target.postMessage({ kind: 'stone-square-report-assertion', assertion }, REPORT_GENERATOR_ORIGIN);
  connection.expiresAt = expiresAt;
  state.reportHandoffExpiresAt = expiresAt;
  if (connection.embedded) $('reportGeneratorFrame').dataset.connected = 'true';
  setMessage($('reportGeneratorMessage'), 'Report Generator connected.');
};

const renewReportHandoff = connection => {
  if (connection.refreshPromise) return connection.refreshPromise;
  setMessage($('reportGeneratorMessage'), 'Renewing the secure Report Generator connection…');
  connection.refreshPromise = (async () => {
    try {
      const handoff = validateReportHandoff(await apiFetch('/api/reports/handoff', { method: 'POST' }));
      if (state.reportHandoff !== connection) return;
      postReportAssertion(connection, handoff.assertion, handoff.expiresAt);
    } catch (error) {
      if (state.reportHandoff === connection) {
        setMessage($('reportGeneratorMessage'), error.message || 'The Report Generator could not reconnect.', true);
      }
    } finally {
      if (state.reportHandoff === connection) connection.refreshPromise = null;
    }
  })();
  return connection.refreshPromise;
};

window.addEventListener('message', event => {
  const connection = state.reportHandoff;
  if (!connection || event.origin !== REPORT_GENERATOR_ORIGIN || event.source !== connection.target
      || event.data?.kind !== 'stone-square-report-ready') return;
  if (connection.stagedAssertion && connection.expiresAt > Date.now()) {
    const assertion = connection.stagedAssertion;
    connection.stagedAssertion = '';
    postReportAssertion(connection, assertion, connection.expiresAt);
    return;
  }
  connection.stagedAssertion = '';
  void renewReportHandoff(connection);
});

const loadReportGenerator = async ({ separate = false } = {}) => {
  const message = $('reportGeneratorMessage');
  const frame = $('reportGeneratorFrame');
  const stillFresh = frame.dataset.connected === 'true' && state.reportHandoffExpiresAt > Date.now() + 60_000;
  if (!separate && stillFresh) return;
  let popup = null;
  if (separate) {
    popup = window.open('about:blank', 'stone-square-report-generator');
    if (!popup) {
      setMessage(message, 'Your browser blocked the Report Generator window. Allow pop-ups for this website, then try again.', true);
      return;
    }
  }
  setMessage(message, separate ? 'Opening a secure Report Generator…' : 'Connecting securely to the Report Generator…');
  try {
    const handoff = validateReportHandoff(await apiFetch('/api/reports/handoff', { method: 'POST' }));
    state.reportHandoffExpiresAt = handoff.expiresAt;
    if (separate) {
      state.reportHandoff = { target: popup, stagedAssertion: handoff.assertion, expiresAt: handoff.expiresAt, refreshPromise: null, embedded: false };
      popup.location.replace(handoff.url);
    } else {
      delete frame.dataset.connected;
      state.reportHandoff = { target: frame.contentWindow, stagedAssertion: handoff.assertion, expiresAt: handoff.expiresAt, refreshPromise: null, embedded: true };
      frame.src = handoff.url;
    }
    setMessage(message, 'Waiting for the secure Report Generator to finish connecting…');
  } catch (error) {
    state.reportHandoff = null;
    state.reportHandoffExpiresAt = 0;
    popup?.close();
    setMessage(message, error.message || 'The Report Generator could not be opened.', true);
  }
};

const CANDIDATE_TRACKER_ORIGIN = 'https://tracker.stonesquare22pha.org';
const secureCandidateTrackerUrl = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== CANDIDATE_TRACKER_ORIGIN || url.pathname !== '/api/sso'
      || url.username || url.password) {
    throw new Error('The secure Candidate Tracker address could not be verified.');
  }
  return url.href;
};

const openCandidateTracker = async () => {
  const message = $('candidateTrackerMessage');
  const popup = window.open('about:blank', 'stone-square-candidate-tracker');
  if (!popup) {
    setMessage(message, 'Your browser blocked the Candidate Tracker window. Allow pop-ups for this website, then try again.', true);
    return;
  }
  popup.opener = null;
  setMessage(message, 'Opening the Candidate Tracker securely…');
  try {
    const { url } = await apiFetch('/api/tracker/handoff', { method: 'POST' });
    popup.location.replace(secureCandidateTrackerUrl(url));
    setMessage(message, 'Candidate Tracker opened securely.');
  } catch (error) {
    popup.close();
    setMessage(message, error.message || 'The Candidate Tracker could not be opened.', true);
  }
};

const showWorkspaceSection = (section, { skipLoad = false } = {}) => {
  if (state.activeSection && section !== state.activeSection && hasUnsavedWorkspace(state.activeSection)
      && !window.confirm('Leave this unfinished work? It will stay in this browser tab so you can return to it.')) return false;
  const sectionPermissions = { building: ['building.view','building.request'], calendar: ['calendar.view'], reports: ['reports.create'], minutes: ['minutes.view','minutes.prepare'], treasury: ['treasury.view','treasury.prepare','treasury.upload'], dues: ['dues.view'], queue: ['documents.status'], proposals: ['proposals.create'], settings: ['settings.manage'] };
  if (sectionPermissions[section] && !sectionPermissions[section].some(permission => can(permission))) section = 'home';
  $('buildingSection').classList.toggle('hidden', section !== 'building');
  $('calendarSection').classList.toggle('hidden', section !== 'calendar');
  $('buildingNav').classList.toggle('active', section === 'building');
  $('calendarNav').classList.toggle('active', section === 'calendar');
  if (section === 'building' && !skipLoad) buildingCalendarWorkspace?.building();
  if (section === 'calendar' && !skipLoad) buildingCalendarWorkspace?.calendar();
  $('settingsSection').classList.toggle('hidden', section !== 'settings');
  $('settingsNav').classList.toggle('active', section === 'settings');
  if(['activity','builder','proposalReview'].includes(section)&&state.user?.role!=='owner')section='home';
  state.activeSection = section;
  activityTracker?.visit(section);
  $('activitySection').classList.toggle('hidden',section!=='activity');
  $('activityNav').classList.toggle('active',section==='activity');
  if(section==='activity'&&!skipLoad)activityWorkspace?.load();
  $('treasurySection').classList.toggle('hidden', section !== 'treasury');
  $('treasuryNav').classList.toggle('active', section === 'treasury');
  if (section === 'treasury' && !skipLoad) treasuryWorkspace?.list();
  const reports = section === 'reports';
  $('reportsSection').classList.toggle('hidden', !reports);
  $('reportsNav').classList.toggle('active', reports);
  if (reports && !skipLoad) void loadReportGenerator();
  const home = section === 'home';
  const builder = section === 'builder';
  const queue = section === 'queue';
  const dues = section === 'dues';
  const approvals = section === 'approvals' && can('documents.status') && ['owner','secretary','assistant_secretary','signer','viewer'].includes(state.user?.role);
  const minutes = section === 'minutes';
  const proposals = section === 'proposals';
  const proposalReview = section === 'proposalReview';
  $('landingSection').classList.toggle('hidden', !home);
  $('queueSection').classList.toggle('hidden', !queue);
  $('builderSection').classList.toggle('hidden', !builder);
  $('duesSection').classList.toggle('hidden', !dues);
  $('approvalsSection').classList.toggle('hidden', !approvals);
  $('minutesSection').classList.toggle('hidden', !minutes);
  $('proposalsSection').classList.toggle('hidden', !proposals);
  $('proposalReviewSection').classList.toggle('hidden', !proposalReview);
  $('homeNav').classList.toggle('active', home);
  $('queueNav').classList.toggle('active', queue);
  $('builderNav').classList.toggle('active', builder);
  $('duesNav').classList.toggle('active', dues);
  $('approvalsNav').classList.toggle('active', approvals);
  $('minutesNav').classList.toggle('active', minutes);
  $('proposalsNav').classList.toggle('active', proposals);
  $('proposalReviewNav').classList.toggle('active', proposalReview);
  if (dues && !skipLoad) renderDues();
  if (approvals && !skipLoad) renderApprovals();
  if (minutes && !skipLoad) renderMinutes();
  if ((proposals || proposalReview) && !skipLoad) renderProposals();
  /* Zeffy payments arrive from outside the app, so no in-app event can announce
   * them. While the dues page is the one on screen, re-read it on a timer so two
   * officers looking at once see the same figures. */
  window.clearInterval(state.duesTimer);
  if (dues) state.duesTimer = window.setInterval(() => renderDues(true), 60000);
  return true;
};

const MINUTES_STATUS = {
  draft: 'Working draft',
  awaiting_master_attestation: 'Waiting for the Worshipful Master',
  ready_for_distribution: 'Signed and ready for McDuffie',
  distributed: 'Distributed by the Secretary',
  approved_by_lodge: 'Approved by the Lodge',
};

const currentMinutes = () => state.minutes.find((item) => item.id === state.editingMinutesId);

const collectMinutesFinance = (id) => [...$(id).querySelectorAll('.minutes-finance-row')].map((row) => ({
  date: row.querySelector('[data-field="date"]').value.trim() || null,
  reference: row.querySelector('[data-field="reference"]').value.trim() || null,
  party: row.querySelector('[data-field="party"]').value.trim() || null,
  description: row.querySelector('[data-field="description"]').value.trim() || null,
  amount: row.querySelector('[data-field="amount"]').value.trim() || null,
})).filter((row) => Object.values(row).some(Boolean));

const collectMinutesDraft = () => ({
  organizerVersion: currentMinutes()?.draft.organizerVersion || 2,
  sourceType: currentMinutes()?.draft.sourceType || 'transcript',
  meetingDate: minutesDates.minutesDateValue($('minutesMeetingDate').value) || null,
  meetingType: $('minutesMeetingType').value === 'other'
    ? $('minutesMeetingTypeOther').value.trim()
    : $('minutesMeetingType').value,
  degree: $('minutesDegree').value.trim() || null,
  openingTime: $('minutesOpeningTime').value.trim() || null,
  closingTime: $('minutesClosingTime').value.trim() || null,
  prayerRequested: $('minutesPrayerRequested').value === '' ? null : $('minutesPrayerRequested').value === 'true',
  closingPrayerGiven: $('minutesClosingPrayerGiven').value === '' ? null : $('minutesClosingPrayerGiven').value === 'true',
  presiding: $('minutesPresiding').value.trim() || null,
  quorum: $('minutesQuorum').value.trim() || null,
  nextMeeting: $('minutesNextMeeting').value.trim() || null,
  present: $('minutesPresent').value.split('\n').map((name) => name.trim()).filter(Boolean),
  excused: $('minutesExcused').value.split('\n').map((name) => name.trim()).filter(Boolean),
  visitors: $('minutesVisitors').value.split('\n').map((name) => name.trim()).filter(Boolean),
  officerAttendance: [...$('minutesOfficerAttendance').querySelectorAll('.minutes-officer-row')].map((row) => ({
    name: row.querySelector('[data-field="name"]').value.trim(),
    title: row.querySelector('[data-field="title"]').value.trim(),
    status: row.querySelector('select').value,
  })).filter((row) => row.name),
  income: collectMinutesFinance('minutesIncome'),
  expenses: collectMinutesFinance('minutesExpenses'),
  sections: [...$('minutesSections').querySelectorAll('.minutes-section-card')].map((card) => ({
    heading: card.querySelector('input').value.trim(),
    body: card.querySelector('textarea').value.trim(),
  })).filter((section) => section.heading || section.body),
  warnings: currentMinutes()?.draft.warnings || [],
  sensitiveReview: currentMinutes()?.draft.sensitiveReview || [],
  actionItems: currentMinutes()?.draft.actionItems || [],
});

const minutesDateLabel = (item) => item.meetingDate ? eventDayLabel(item.meetingDate) : 'Meeting date needs review';

const setMinutesMeetingType = (value) => {
  const stated = !value || value === 'Stated Communication' || value === 'Regular Stated Communication';
  $('minutesMeetingType').value = stated ? 'Stated Communication' : 'other';
  $('minutesMeetingTypeOther').value = stated ? '' : value;
  $('minutesMeetingTypeOther').classList.toggle('hidden', stated);
};

const refreshMinutesReviewAlerts = async () => {
  const container = $('minutesReviewAlerts');
  if (state.user?.role !== 'owner') { container.replaceChildren(); hide(container); return; }
  const userId = state.user.id;
  try {
    const { alerts } = await apiFetch('/api/minutes/review-alerts');
    if (state.user?.id !== userId || state.user?.role !== 'owner') return;
    container.replaceChildren(...alerts.map((alert) => {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.style.cssText = 'display:block;width:100%;text-align:left;white-space:normal;margin-bottom:12px';
      button.textContent = `${alert.title}. Submitted by ${alert.submittedBy}. Open for review.`;
      button.addEventListener('click', async () => {
        showWorkspaceSection('minutes');
        await renderMinutes();
        const record = state.minutes.find(item => item.id === alert.id);
        if (record) openMinutesEditor(record.id);
      });
      return button;
    }));
    container.classList.toggle('hidden', !alerts.length);
  } catch { /* Keep existing alerts visible until the next successful refresh. */ }
};
setInterval(() => { if (state.user?.role === 'owner') refreshMinutesReviewAlerts(); }, 20000);

const refreshGenerationStatus = element => import('/generation-status.js').then(module => module.showGenerationStatus(element, apiFetch, state.user?.role));
const renderMinutes = async () => {
  if (can('minutes.prepare')) void refreshGenerationStatus($('minutesGenerationStatus'));
  try {
    const payload = await apiFetch('/api/minutes');
    state.minutes = payload.minutes || [];
    const list = $('minutesList');
    list.replaceChildren();
    if (!state.minutes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const title = document.createElement('h3');
      title.textContent = 'No meeting minutes yet';
      const note = document.createElement('p');
      note.textContent = can('minutes.prepare') ? 'Upload meeting notes or a transcript above to create the first draft.' : 'Finalized minutes will appear here when available.';
      empty.append(title, note);
      list.append(empty);
      return;
    }
    state.minutes.forEach((item) => {
      const row = document.createElement('article');
      row.className = 'minutes-row';
      const icon = document.createElement('div');
      icon.className = 'doc-icon';
      icon.textContent = 'MIN';
      const main = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = `Minutes of ${minutesDateLabel(item)}`;
      const detail = document.createElement('p');
      detail.textContent = `Prepared by ${item.createdBy}. Last saved by ${item.updatedBy}, ${formatDate(item.updatedAt)}.`;
      main.append(heading, detail);
      const status = document.createElement('span');
      status.className = `status ${item.status === 'approved_by_lodge' ? 'completed' : ''}`;
      status.textContent = MINUTES_STATUS[item.status] || item.status;
      const actions = document.createElement('div');
      actions.className = 'minutes-row-actions';
      const open = document.createElement('button');
      open.className = 'secondary small';
      open.type = 'button';
      open.textContent = can('minutes.prepare') ? 'Review' : 'View PDF';
      open.addEventListener('click', async () => {
        if (can('minutes.prepare')) return openMinutesEditor(item.id);
        try { showPdfBlob(await apiFetch(`/api/minutes/${item.id}/pdf`), `Minutes of ${minutesDateLabel(item)}`); }
        catch(error) { setMessage($('minutesReadMessage'), error.message, true); }
      });
      actions.append(open);
      if (can('minutes.prepare') && item.status === 'draft' && (state.user.role === 'owner' || item.createdByUserId === state.user.id)) {
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'secondary small danger-text'; remove.textContent = 'Delete';
        remove.addEventListener('click', async () => {
          if (!confirm(`Delete the unsigned draft for ${minutesDateLabel(item)}? It will be removed from this list. Signed records cannot be deleted.`)) return;
          remove.disabled = true;
          try { await apiFetch(`/api/minutes/${item.id}`, { method: 'DELETE' }); await renderMinutes(); }
          catch (error) { setMessage($('minutesMessage'), error.message, true); remove.disabled = false; }
        });
        actions.append(remove);
      }
      row.append(icon, main, status, actions);
      list.append(row);
    });
  } catch (error) {
    setMessage($('minutesMessage'), error.message, true);
  }
};

const renumberMinutesSections = () => {
  $('minutesSections').querySelectorAll('.minutes-section-card').forEach((card, index) => {
    card.querySelector('label').textContent = `Agenda section ${index + 1}`;
    card.querySelector('input').setAttribute('aria-label', `Section ${index + 1} heading`);
    card.querySelector('textarea').setAttribute('aria-label', `Section ${index + 1} content`);
  });
};

const sectionEditor = (section, index) => {
  const card = document.createElement('div');
  card.className = 'minutes-section-card';
  const label = document.createElement('label');
  label.textContent = `Agenda section ${index + 1}`;
  const heading = document.createElement('input');
  heading.type = 'text';
  heading.value = section.heading || '';
  const body = document.createElement('textarea');
  body.rows = 6;
  body.value = section.body || '';
  heading.setAttribute('aria-label', `Section ${index + 1} heading`);
  body.setAttribute('aria-label', `Section ${index + 1} content`);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'text-button danger-text remove-section'; remove.textContent = 'Remove section';
  remove.addEventListener('click', () => { card.remove(); state.minutesEditorDirty = true; renumberMinutesSections(); scheduleMinutesPreview(); });
  card.append(label, heading, body, remove);
  return card;
};

const officerAttendanceEditor = (entry) => {
  const row = document.createElement('div');
  row.className = 'minutes-officer-row';
  const name = document.createElement('input');
  name.type = 'text';
  name.dataset.field = 'name';
  name.placeholder = 'Officer name';
  name.value = entry.name || '';
  const title = document.createElement('input');
  title.type = 'text';
  title.dataset.field = 'title';
  title.placeholder = 'Office or pro tem role';
  title.value = entry.title || '';
  const select = document.createElement('select');
  [['present', 'Present'], ['absent', 'Absent'], ['excused', 'Excused'], ['not_recorded', 'Not recorded']]
    .forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = value === entry.status;
      select.append(option);
    });
  row.append(name, title, select);
  return row;
};

const financeEditor = (entry = {}) => {
  const row = document.createElement('div');
  row.className = 'minutes-finance-row';
  const fields = [
    ['date', 'Date'], ['reference', 'Check or reference'], ['party', 'Brother or payee'],
    ['amount', 'Amount'], ['description', 'Description'],
  ];
  fields.forEach(([field, placeholder]) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = field;
    input.placeholder = placeholder;
    input.value = entry[field] || '';
    row.append(input);
  });
  return row;
};

const fillFinanceEditor = (id, entries = []) => {
  const values = entries.length ? entries : [{}];
  $(id).replaceChildren(...values.map(financeEditor));
};

let minutesPreviewTimer;
let minutesPreviewRevision = 0;
let minutesPdfViewer;
let minutesPdfModule;
const setMinutesView = (preview) => {
  $('minutesEditorModal').classList.toggle('minutes-preview-only', preview);
  $('minutesEditView').setAttribute('aria-pressed', String(!preview));
  $('minutesPreviewView').setAttribute('aria-pressed', String(preview));
  $('minutesEditorModal').scrollTop = 0;
  $('minutesEditorModal').querySelector('.modal-body').scrollTop = 0;
};
const scheduleMinutesPreview = () => {
  clearTimeout(minutesPreviewTimer);
  ++minutesPreviewRevision;
  $('minutesPreviewState').textContent = 'Updating preview…';
  minutesPreviewTimer = setTimeout(refreshMinutesPreview, 700);
};
const refreshMinutesPreview = async () => {
  clearTimeout(minutesPreviewTimer);
  if (!state.editingMinutesId) return;
  const revision = ++minutesPreviewRevision;
  const id = state.editingMinutesId;
  $('minutesPreviewState').textContent = 'Updating preview…';
  try {
    const blob = await apiFetch(`/api/minutes/${id}/preview`, {
      method: 'POST', body: JSON.stringify({ draft: collectMinutesDraft() }),
    });
    if (revision !== minutesPreviewRevision || id !== state.editingMinutesId) return;
    minutesPdfModule ||= import('/minutes-preview.js');
    const { MinutesPreview } = await minutesPdfModule;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (revision !== minutesPreviewRevision || id !== state.editingMinutesId) return;
    minutesPdfViewer ||= new MinutesPreview($('minutesPreviewFrame'));
    const previous = state.minutesPreviewUrl;
    state.minutesPreviewUrl = URL.createObjectURL(blob);
    $('minutesPreviewDownload').href = state.minutesPreviewUrl;
    show($('minutesPreviewDownload'));
    if (previous) URL.revokeObjectURL(previous);
    const pageCount = await minutesPdfViewer.show(bytes);
    if (revision === minutesPreviewRevision && id === state.editingMinutesId) $('minutesPreviewState').textContent = `${pageCount} pages. Preview matches the current fields. Unsaved changes are included.`;
  } catch (error) {
    if (revision === minutesPreviewRevision) $('minutesPreviewState').textContent = `Preview could not update: ${error.message}`;
  }
};

const updateMinutesEditorControls = (item) => {
  void refreshGenerationStatus($('minutesEditorGenerationStatus'));
  const role = state.user?.role;
  const editable = item.status === 'draft' || (item.status === 'awaiting_master_attestation' && role === 'owner');
  $('minutesEditorStatus').textContent = `${MINUTES_STATUS[item.status] || item.status} · ${item.draft.sourceType === 'compiled_notes' ? 'Compiled meeting notes' : 'Transcript'}`;
  $('reorganizeMinutes').classList.toggle('hidden', item.status !== 'draft');
  document.querySelectorAll('.remove-section').forEach(button => { button.disabled = !editable; });
  $('saveMinutes').classList.toggle('hidden', !editable);
  $('submitMinutesReview').classList.toggle('hidden', item.status !== 'draft'
    || !can('minutes.prepare') || item.createdByUserId !== state.user.id);
  $('authorizeMinutes').classList.toggle('hidden', role !== 'owner' || item.status !== 'awaiting_master_attestation');
  $('markMinutesDistributed').classList.toggle('hidden', item.status !== 'ready_for_distribution'
    || !['owner', 'secretary'].includes(role));
  $('reopenMinutes').classList.toggle('hidden', role !== 'owner'
    || ['draft', 'approved_by_lodge'].includes(item.status));
  $('minutesApprovalPanel').classList.toggle('hidden',
    !['owner', 'secretary'].includes(role) || !['ready_for_distribution', 'distributed'].includes(item.status));
  $('downloadMinutes').textContent = item.status === 'approved_by_lodge' ? 'Download official Word record' : 'Download saved Word draft';
  $('minutesEditorForm').querySelectorAll('input, textarea, select').forEach((field) => {
    if (!['minutesApprovalDate', 'minutesApprovalNote'].includes(field.id)) field.disabled = !editable;
  });
  ['addMinutesOfficer', 'addMinutesIncome', 'addMinutesExpense', 'addMinutesSection'].forEach((id) => {
    $(id).classList.toggle('hidden', !editable);
  });
  $('addMinutesSection').disabled = !editable;
};

const openMinutesEditor = (id) => {
  if (!can('minutes.prepare')) return;
  setMinutesView(false);
  const item = state.minutes.find((entry) => entry.id === id);
  if (!item) return;
  state.editingMinutesId = id;
  state.editingMinutesUpdatedAt = item.updatedAt;
  const draft = item.draft;
  $('minutesMeetingDate').value = minutesDates.formatMinutesDate(draft.meetingDate);
  $('minutesMeetingDateCalendar').value = minutesDates.minutesDateParts(draft.meetingDate)?.iso || '';
  setMinutesMeetingType(draft.meetingType || 'Stated Communication');
  const legacyDegrees = {
    'Entered Apprentice': 'First Degree',
    'Entered Apprentice Degree': 'First Degree',
    Fellowcraft: 'Second Degree',
    'Fellow Craft': 'Second Degree',
    'Fellow Craft Degree': 'Second Degree',
    'Master Mason': 'Third Degree',
    'Master Mason Degree': 'Third Degree',
    'Third Degree of Masonry': 'Third Degree',
  };
  $('minutesDegree').value = legacyDegrees[draft.degree] || draft.degree || '';
  $('minutesOpeningTime').value = draft.openingTime || '';
  $('minutesClosingTime').value = draft.closingTime || '';
  $('minutesPrayerRequested').value = typeof draft.prayerRequested === 'boolean' ? String(draft.prayerRequested) : '';
  $('minutesClosingPrayerGiven').value = typeof draft.closingPrayerGiven === 'boolean' ? String(draft.closingPrayerGiven) : '';
  $('minutesPresiding').value = draft.presiding || '';
  $('minutesQuorum').value = /^(yes|quorum present|established)$/i.test(draft.quorum || '') ? 'Yes'
    : /^(no|no quorum)$/i.test(draft.quorum || '') ? 'No' : '';
  $('minutesNextMeeting').value = minutesDates.formatMinutesDate(draft.nextMeeting);
  $('minutesNextMeetingCalendar').value = minutesDates.minutesDateParts(draft.nextMeeting)?.iso || '';
  $('minutesPresent').value = (draft.present || []).join('\n');
  $('minutesExcused').value = (draft.excused || []).join('\n');
  $('minutesVisitors').value = (draft.visitors || []).join('\n');
  $('minutesOfficerAttendance').replaceChildren(...(draft.officerAttendance || []).map(officerAttendanceEditor));
  fillFinanceEditor('minutesIncome', draft.income || []);
  fillFinanceEditor('minutesExpenses', draft.expenses || []);
  $('minutesApprovalDate').value = item.approvedByLodgeOn || '';
  $('minutesApprovalNote').value = item.approvalNote || '';
  $('minutesSections').replaceChildren(...draft.sections.map(sectionEditor));
  const reviewItems = [
    ...(draft.warnings || []).map((text) => `Check: ${text}`),
    ...(draft.sensitiveReview || []).map((text) => `Private review: ${text}`),
  ];
  const warnings = $('minutesReviewWarnings');
  warnings.replaceChildren();
  warnings.classList.toggle('hidden', !reviewItems.length);
  if (reviewItems.length) {
    const label = document.createElement('strong');
    label.textContent = 'Items that need officer review';
    const list = document.createElement('ul');
    reviewItems.forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      list.append(li);
    });
    warnings.append(label, list);
  }
  const changePanel = $('minutesMasterChanges');
  changePanel.replaceChildren();
  const changes = item.masterChanges || [];
  changePanel.classList.toggle('hidden', !changes.length);
  if (changes.length) {
    const title = document.createElement('h3'); title.textContent = "Worshipful Master's corrections"; changePanel.append(title);
    changes.forEach(change => {
      const detail = document.createElement('details');
      const heading = document.createElement('summary'); heading.textContent = change.field;
      const before = document.createElement('pre'); before.textContent = `Submitted:\n${change.before || '(blank)'}`;
      const after = document.createElement('pre'); after.textContent = `Reviewed:\n${change.after || '(removed)'}`;
      detail.append(heading, before, after); changePanel.append(detail);
    });
  }
  setMessage($('minutesEditorMessage'), '');
  updateMinutesEditorControls(item);
  state.minutesEditorDirty = false;
  show($('minutesEditorModal'));
  refreshMinutesPreview();
};

const refreshOpenMinutes = async (message) => {
  const id = state.editingMinutesId;
  await renderMinutes();
  const item = state.minutes.find((entry) => entry.id === id);
  if (item) {
    openMinutesEditor(id);
    setMessage($('minutesEditorMessage'), message);
  }
};

const minutesAction = async (path, body, message) => {
  try {
    const result = await apiFetch(`/api/minutes/${state.editingMinutesId}/${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
    await refreshOpenMinutes([message, ...(result.notificationWarnings || [])].join(' '));
  } catch (error) {
    setMessage($('minutesEditorMessage'), error.message, true);
  }
};

const saveMinutesCorrections = async () => {
  const payload = await apiFetch(`/api/minutes/${state.editingMinutesId}`, {
    method: 'PUT', body: JSON.stringify({ draft: collectMinutesDraft(), expectedUpdatedAt: state.editingMinutesUpdatedAt }),
  });
  state.editingMinutesUpdatedAt = payload.minutes.updatedAt;
  state.minutesEditorDirty = false;
};

/* What the District Deputy decided, and the proof of it.
 *
 * Both dispensations the Lodge holds as approved have nothing written in the approval block on
 * the form itself: no tick, no date, no signature. Both were granted by email. So this shows how
 * the decision arrived rather than pretending the instrument carries it, and says plainly when no
 * endorsed copy exists. */
const APPROVAL_WORDS = {
  approved: 'Approved', disapproved: 'Not approved', withdrawn: 'Withdrawn', pending: 'Awaiting a decision',
};
const APPROVAL_ROUTE = {
  endorsed_pdf: 'endorsed copy returned', email: 'given by email',
  text_message: 'given by text message', verbal: 'given verbally',
};

const renderApprovals = async () => {
  const message = $('approvalsMessage');
  const list = $('approvalsList');
  try {
    const { approvals = [] } = await apiFetch('/api/approvals');
    list.innerHTML = '';
    if (!approvals.length) {
      setMessage(message, 'No dispensation has been recorded as decided yet.');
      return;
    }
    setMessage(message, '');
    approvals.forEach((item) => {
      const row = window.document.createElement('article');
      row.className = 'doc-row';
      const decided = APPROVAL_WORDS[item.approval_status] || item.approval_status;
      const route = APPROVAL_ROUTE[item.approval_source] || item.approval_source || '';
      row.innerHTML = `
        <div class="queue-number">${item.approval_status === 'approved' ? '\u2713' : '\u2022'}</div>
        <div class="doc-icon">PDF</div>
        <div class="doc-main"><h3></h3><p></p></div>
        <span class="status ${item.approval_status === 'approved' ? 'completed' : 'rescinded'}"></span>
        <div class="doc-actions"></div>`;
      row.querySelector('h3').textContent = item.title || item.original_name;
      row.querySelector('.doc-main p').textContent =
        `${item.approved_by || 'Not recorded'} · ${formatDate(item.approved_on)} · ${route}`;
      row.querySelector('.status').textContent = decided;
      if (!item.has_endorsed_copy) {
        const warn = window.document.createElement('p');
        warn.className = 'queue-submission queue-submission-warn';
        warn.textContent = 'No approval document on file. The approval block on the form is blank.';
        row.querySelector('.doc-main').appendChild(warn);
      }
      const actions = row.querySelector('.doc-actions');
      const open = window.document.createElement('button');
      open.className = 'text-button';
      open.textContent = 'View PDF';
      open.addEventListener('click', () => openPdf(item.id, item.original_name));
      actions.appendChild(open);
      if (item.has_endorsed_copy) {
        const endorsed = window.document.createElement('button');
        endorsed.className = 'secondary compact';
        endorsed.textContent = 'View Approval';
        endorsed.addEventListener('click', async () => {
          try {
            const blob = await apiFetch(`/api/documents/${item.id}/endorsed`);
            showPdfBlob(blob, `Approval for ${item.title || item.original_name}`);
          } catch (error) {
            setMessage(message, error.message, true);
          }
        });
        actions.appendChild(endorsed);
      }
      if (['viewer', 'warden'].includes(state.user?.role)) actions.replaceChildren();
      list.appendChild(row);
    });
  } catch (error) {
    setMessage(message, error.message, true);
  }
};

const renderDeviceSessions = async () => {
  const message = $('deviceSessionsMessage');
  const list = $('deviceSessionsList');
  setMessage(message, 'Reading signed-in devices…');
  try {
    const { sessions = [] } = await apiFetch('/api/auth/sessions');
    list.replaceChildren(...sessions.map(session => {
      const card = document.createElement('article');
      card.className = 'device-session';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = session.current ? `${session.label || 'This device'} · Current` : (session.label || 'Signed-in device');
      const detail = document.createElement('p');
      const lastUsed = session.lastSeenAt || session.createdAt;
      detail.textContent = `${lastUsed ? `Last used ${formatDate(lastUsed)}` : 'Last used time unavailable'} · ${session.expiresAt ? `Expires ${formatDate(session.expiresAt)}` : 'Expiration unavailable'}`;
      copy.append(title, detail); card.append(copy);
      if (!session.current) {
        const end = document.createElement('button');
        end.type = 'button'; end.className = 'secondary danger-text'; end.textContent = 'Sign out device';
        end.addEventListener('click', async () => {
          if (!window.confirm(`Sign out ${session.label || 'this device'}? It will need the account password to reconnect.`)) return;
          end.disabled = true;
          try {
            await apiFetch(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
            await renderDeviceSessions();
            setMessage(message, 'That device has been signed out.');
          } catch (error) { setMessage(message, error.message, true); end.disabled = false; }
        });
        card.append(end);
      }
      return card;
    }));
    $('revokeOtherSessions').classList.toggle('hidden', sessions.every(session => session.current));
    setMessage(message, sessions.length ? `${sessions.length} signed-in device${sessions.length === 1 ? '' : 's'}.` : 'No active device sessions were returned.');
  } catch (error) {
    list.replaceChildren();
    $('revokeOtherSessions').classList.add('hidden');
    setMessage(message, error.message || 'Signed-in devices could not load.', true);
  }
};

$('proposalsNav').addEventListener('click', () => showWorkspaceSection('proposals'));
$('proposalReviewNav').addEventListener('click', () => showWorkspaceSection('proposalReview'));

/* Warden proposals. The Wardens put one up, the Master rules on it. */
const proposalFields = () => ({
  title: $('propTitle').value.trim(),
  requestDetails: $('propDetails').value.trim(),
  eventDate: $('propEventDate').value,
  eventTime: $('propEventTime').value.trim(),
  locationName: $('propLocation').value.trim(),
  streetAddress: $('propStreet').value.trim(),
  cityState: $('propCityState').value.trim(),
  requestDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()),
  proposerNote: $('propNote').value.trim(),
});

const renderProposals = async () => {
  const owner = state.user?.role === 'owner';
  const panel = owner ? $('proposalReviewList') : $('proposalList');
  let proposals = [];
  try {
    ({ proposals } = await apiFetch('/api/proposals'));
  } catch (error) {
    if (panel) {
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'err',
        textContent: error.message || 'Could not load proposals. Check your connection and try again.',
      }));
    }
    return;
  }
  const isOwner = owner;
  const target = panel;
  if (!target) return;
  if (!proposals.length) {
    target.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: isOwner ? 'No Warden has proposed a dispensation yet.'
        : 'You have not submitted a proposal yet. Your proposals and their status will appear here.',
    }));
    return;
  }
  target.replaceChildren(...proposals.map((p) => {
    const card = document.createElement('article');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'row';
    head.append(
      Object.assign(document.createElement('strong'), { textContent: p.title || (p.requestDetails || '').slice(0, 70) }),
      Object.assign(document.createElement('span'), { className: 'muted', textContent: statusWords(p.status) }),
    );
    card.append(head);
    card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: `Proposed by ${p.proposerName}` }));
    if (p.eventDate) card.append(Object.assign(document.createElement('p'), { textContent: `${eventDayLabel(p.eventDate)}${p.eventTime ? `, ${p.eventTime}` : ''}` }));
    if (p.requestDetails) card.append(Object.assign(document.createElement('p'), { textContent: p.requestDetails }));
    if (p.proposerNote) card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: `His note: ${p.proposerNote}` }));
    if (p.wmNote) card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: `From the Master: ${p.wmNote}` }));
    if (p.document) {
      card.append(Object.assign(document.createElement('p'), {
        className: 'muted',
        textContent: `Dispensation: ${statusWords(p.document.status)}${p.document.submittedTo ? `, sent to ${p.document.submittedTo}` : ''}${p.document.approvalStatus ? `, ${p.document.approvalStatus}` : ''}`,
      }));
    }
    const problem = Object.assign(document.createElement('p'), { className: 'err' });

    if (isOwner && (p.status === 'pending' || p.status === 'changes_requested' || p.status === 'approving')) {
      /* William was told he could change anything before approving, so the fields are editable
       * here rather than only over the API. What he types is what goes on the instrument. */
      const edit = (label, key, value, type = 'text') => {
        const wrap = document.createElement('div');
        wrap.append(Object.assign(document.createElement('label'), { textContent: label }));
        const input = Object.assign(document.createElement(key === 'requestDetails' ? 'textarea' : 'input'),
          { value: value || '' });
        if (key !== 'requestDetails') input.type = type;
        input.dataset.key = key;
        wrap.append(input);
        return wrap;
      };
      const editor = document.createElement('div');
      editor.className = 'proposal-edit';
      editor.append(
        edit('What it is', 'title', p.title),
        edit('What is being asked', 'requestDetails', p.requestDetails),
        edit('Date of the event', 'eventDate', p.eventDate, 'date'),
        edit('Time', 'eventTime', p.eventTime),
        edit('Where', 'locationName', p.locationName),
        edit('Street', 'streetAddress', p.streetAddress),
        edit('City and state', 'cityState', p.cityState),
      );
      const editedFields = () => Object.fromEntries(
        [...editor.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, el.value.trim()]),
      );
      const look = Object.assign(document.createElement('button'),
        { type: 'button', className: 'secondary', textContent: 'See it as it stands' });
      look.addEventListener('click', async () => {
        try {
          const blob = await apiFetch(`/api/proposals/${p.id}/preview`, {
            method: 'POST', body: JSON.stringify(editedFields()),
          });
          showPdfBlob(blob, 'Dispensation as it stands');
        } catch (error) { problem.textContent = error.message || 'Could not build the preview.'; }
      });
      card.append(editor, look);
      const note = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'A note back to him, optional' });
      const row = document.createElement('div');
      row.className = 'two';
      const decide = async (decision) => {
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const payload = await apiFetch(`/api/proposals/${p.id}/decision`, {
            method: 'POST',
            body: JSON.stringify({ decision, wmNote: note.value.trim(), ...editedFields() }),
          });
          await renderProposals();
          setNotificationMessage($('proposalReviewMessage'), 'Proposal status updated and saved.', payload);
        } catch (error) {
          row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          problem.textContent = error.message || 'That did not go through. Try again.';
        }
      };
      const mk = (label, cls, decision) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
        b.addEventListener('click', () => decide(decision));
        return b;
      };
      row.append(mk('Approve', 'primary', 'approve'), mk('Send back', 'secondary', 'changes'), mk('Decline', 'secondary', 'decline'));
      card.append(note, row, problem);
    }

    /* Sent back means he has to be able to change it and send it up again. */
    if (!isOwner && p.status === 'changes_requested' && p.proposerUserId === state.user?.id) {
      const again = Object.assign(document.createElement('button'),
        { type: 'button', className: 'primary', textContent: 'Change it and send it back up' });
      again.addEventListener('click', () => {
        $('propTitle').value = p.title || '';
        $('propDetails').value = p.requestDetails || '';
        $('propEventDate').value = p.eventDate || '';
        $('propEventTime').value = p.eventTime || '';
        $('propLocation').value = p.locationName || '';
        $('propStreet').value = p.streetAddress || '';
        $('propCityState').value = p.cityState || '';
        $('propNote').value = p.proposerNote || '';
        state.resubmitId = p.id;
        $('proposalMessage').textContent = 'Change what you need to above, then send it back up.';
        $('propDetails').scrollIntoView({ block: 'center' });
      });
      card.append(again, problem);
    }
    return card;
  }));
};

const statusWords = (status) => ({
  pending: 'Waiting on the Master',
  changes_requested: 'Sent back for changes',
  approved: 'Approved',
  declined: 'Not approved',
  partially_signed: 'Waiting on a Secretary',
  completed: 'Signed',
}[status] || status);

$('proposalPreview')?.addEventListener('click', async () => {
  try {
    const blob = await apiFetch('/api/proposals/new/preview', {
      method: 'POST', body: JSON.stringify(proposalFields()),
    });
    showPdfBlob(blob, 'What the dispensation would look like');
  } catch (error) {
    $('proposalMessage').textContent = 'Could not build the preview.';
  }
});

$('proposalForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = state.resubmitId ? 'Sending changes…' : 'Sending proposal…';
  try {
    let payload;
    if (state.resubmitId) {
      payload = await apiFetch(`/api/proposals/${state.resubmitId}`, { method: 'PUT', body: JSON.stringify(proposalFields()) });
      state.resubmitId = null;
    } else {
      payload = await apiFetch('/api/proposals', { method: 'POST', body: JSON.stringify(proposalFields()) });
    }
    setNotificationMessage($('proposalMessage'), 'Proposal saved and sent to the Worshipful Master for review.', payload);
    event.target.reset();
    state.proposalDirty = false;
    clearSessionDraft('proposal');
    await renderProposals();
  } catch (error) {
    setMessage($('proposalMessage'), error.message || 'The proposal could not be saved.', true);
  }
  button.disabled = false;
  button.textContent = originalLabel;
});

$('approvalsNav').addEventListener('click', () => showWorkspaceSection('approvals'));
$('approvalsRefresh').addEventListener('click', () => renderApprovals());
$('buildingNav').addEventListener('click', () => showWorkspaceSection('building'));
$('buildingMenuCard').addEventListener('click', () => showWorkspaceSection('building'));
$('calendarNav').addEventListener('click', () => showWorkspaceSection('calendar'));
$('calendarMenuCard').addEventListener('click', () => showWorkspaceSection('calendar'));
$('accessNav').addEventListener('click', () => {
  if (state.user?.role !== 'owner') return;
  showWorkspaceSection('queue');
  $('officerPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('officerPanel').focus({ preventScroll: true });
});
$('activityNav').addEventListener('click',()=>showWorkspaceSection('activity'));
$('activityMenuCard').addEventListener('click',()=>showWorkspaceSection('activity'));
$('treasuryNav').addEventListener('click', () => showWorkspaceSection('treasury'));
$('treasuryMenuCard').addEventListener('click', () => showWorkspaceSection('treasury'));
$('reportsNav').addEventListener('click', () => showWorkspaceSection('reports'));
$('reportsMenuCard').addEventListener('click', () => showWorkspaceSection('reports'));
$('candidateMenuCard').addEventListener('click', () => { void openCandidateTracker(); });
$('reportSeparateTab').addEventListener('click', () => { void loadReportGenerator({ separate: true }); });
$('minutesNav').addEventListener('click', () => showWorkspaceSection('minutes'));
$('minutesMenuCard').addEventListener('click', () => showWorkspaceSection('minutes'));
$('minutesRefresh').addEventListener('click', () => renderMinutes());
$('settingsNav').addEventListener('click', () => { showWorkspaceSection('settings'); void renderDeviceSessions(); });
$('refreshDeviceSessions').addEventListener('click', () => { void renderDeviceSessions(); });
$('revokeOtherSessions').addEventListener('click', async () => {
  if (!window.confirm('Sign out every other device? This device will stay signed in.')) return;
  const button = $('revokeOtherSessions'); button.disabled = true;
  try {
    await apiFetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    await renderDeviceSessions();
    setMessage($('deviceSessionsMessage'), 'All other devices have been signed out.');
  } catch (error) { setMessage($('deviceSessionsMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('settingsSignature').addEventListener('click', () => openSignatureSetup(false));
$('settingsSignout').addEventListener('click', () => $('logoutBtn').click());
$('homeNav').addEventListener('click', () => showWorkspaceSection('home'));
$('queueNav').addEventListener('click', () => showWorkspaceSection('queue'));
$('builderNav').addEventListener('click', () => showWorkspaceSection('builder'));
$('dispensationsMenuCard').addEventListener('click', () => showWorkspaceSection('queue'));
$('proposeMenuCard')?.addEventListener('click', () => showWorkspaceSection('proposals'));
$('duesNav').addEventListener('click', () => showWorkspaceSection('dues'));
$('duesMenuCard').addEventListener('click', () => showWorkspaceSection('dues'));
$('duesRefresh').addEventListener('click', () => renderDues(true));

$('proposalForm').addEventListener('input', () => {
  state.proposalDirty = true;
  writeSessionDraft('proposal', PROPOSAL_DRAFT_FIELDS);
});
$('dispensationForm').addEventListener('input', () => {
  state.dispensationDirty = true;
  writeSessionDraft('dispensation', DISPENSATION_DRAFT_FIELDS);
});
$('minutesTranscriptText').addEventListener('input', () => {
  state.minutesSourceDirty = true;
  writeSessionDraft('minutes-source', MINUTES_SOURCE_DRAFT_FIELDS);
});
$('minutesSourceType').addEventListener('change', () => {
  if ($('minutesTranscriptText').value.trim()) writeSessionDraft('minutes-source', MINUTES_SOURCE_DRAFT_FIELDS);
});
window.addEventListener('beforeunload', event => {
  if (!state.minutesEditorDirty && !hasUnsavedWorkspace(state.activeSection)) return;
  event.preventDefault();
  event.returnValue = '';
});

$('minutesTranscriptFile').addEventListener('change', () => {
  $('minutesSelectedFile').textContent = $('minutesTranscriptFile').files[0]?.name || 'No file selected';
  state.minutesSourceDirty = Boolean($('minutesTranscriptFile').files[0]) || Boolean($('minutesTranscriptText').value.trim());
});

$('generateMinutes').addEventListener('click', async () => {
  const button = $('generateMinutes');
  const data = new FormData();
  const file = $('minutesTranscriptFile').files[0];
  const pasted = $('minutesTranscriptText').value.trim();
  data.append('sourceType', $('minutesSourceType').value);
  if (file) data.append('transcriptFile', file);
  if (pasted) data.append('transcriptText', pasted);
  if (!file && !pasted) {
    setMessage($('minutesMessage'), 'Choose notes or a transcript, or paste the text.', true);
    return;
  }
  const sourceControls = ['minutesTranscriptFile', 'minutesTranscriptText', 'minutesSourceType'].map(id => $(id));
  sourceControls.forEach(control => { control.disabled = true; });
  button.disabled = true;
  button.textContent = 'Creating draft...';
  setMessage($('minutesMessage'), 'Organizing the meeting source into the Lodge minutes template.');
  try {
    const payload = await apiFetch('/api/minutes/generate', { method: 'POST', body: data });
    $('minutesTranscriptFile').value = '';
    $('minutesSelectedFile').textContent = 'No file selected';
    $('minutesTranscriptText').value = '';
    state.minutesSourceDirty = false;
    clearSessionDraft('minutes-source');
    await renderMinutes();
    setMessage($('minutesMessage'), 'Draft created. Review every section before sending it to the Worshipful Master.');
    openMinutesEditor(payload.minutes.id);
  } catch (error) {
    setMessage($('minutesMessage'), error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Create draft minutes';
    sourceControls.forEach(control => { control.disabled = false; });
  }
});

$('closeMinutesEditor').addEventListener('click', () => {
  if (state.minutesEditorDirty && !window.confirm('Close these minutes without saving your latest corrections?')) return;
  hide($('minutesEditorModal'));
  clearTimeout(minutesPreviewTimer); ++minutesPreviewRevision; state.editingMinutesId = null;
  state.minutesEditorDirty = false;
  if (state.minutesPreviewUrl) URL.revokeObjectURL(state.minutesPreviewUrl);
  state.minutesPreviewUrl = '';
  minutesPdfViewer?.clear();
  $('minutesPreviewDownload').removeAttribute('href');
  hide($('minutesPreviewDownload'));
});
$('minutesEditView').addEventListener('click', () => setMinutesView(false));
$('minutesPreviewView').addEventListener('click', () => setMinutesView(true));
$('minutesPreviewFrame').addEventListener('previewerror', event => { $('minutesPreviewState').textContent = `Preview could not render: ${event.detail}. You can download the PDF above.`; });
$('refreshMinutesPreview').addEventListener('click', refreshMinutesPreview);
$('addMinutesOfficer').addEventListener('click', () => {
  $('minutesOfficerAttendance').append(officerAttendanceEditor({ status: 'not_recorded' }));
  state.minutesEditorDirty = true;
});
$('addMinutesIncome').addEventListener('click', () => { $('minutesIncome').append(financeEditor()); state.minutesEditorDirty = true; });
$('addMinutesExpense').addEventListener('click', () => { $('minutesExpenses').append(financeEditor()); state.minutesEditorDirty = true; });
$('addMinutesSection').addEventListener('click', () => {
  const item = currentMinutes();
  if (!item || !(item.status === 'draft' || (item.status === 'awaiting_master_attestation' && state.user?.role === 'owner'))) return;
  const container = $('minutesSections');
  const card = sectionEditor({ heading: 'Meeting Business', body: '' }, container.querySelectorAll('.minutes-section-card').length);
  container.append(card);
  state.minutesEditorDirty = true;
  card.querySelector('input').focus();
  scheduleMinutesPreview();
});
$('minutesMeetingType').addEventListener('change', () => {
  const other = $('minutesMeetingType').value === 'other';
  $('minutesMeetingTypeOther').classList.toggle('hidden', !other);
  if (other) $('minutesMeetingTypeOther').focus();
});
for (const id of ['minutesMeetingDate', 'minutesNextMeeting']) {
  $(id).addEventListener('change', () => {
    $(id).value = minutesDates.formatMinutesDate($(id).value);
    $(`${id}Calendar`).value = minutesDates.minutesDateParts($(id).value)?.iso || '';
  });
  $(`${id}Calendar`).addEventListener('change', () => {
    if (!$(`${id}Calendar`).value) {
      const parts = minutesDates.minutesDateParts($(id).value);
      $(id).value = id === 'minutesMeetingDate' ? '' : parts ? `${parts.prefix}${parts.suffix}`.trim() : $(id).value;
      return;
    }
    const dateValue = $(`${id}Calendar`).value;
    $(id).value = minutesDates.formatMinutesDate(id === 'minutesMeetingDate' ? dateValue : minutesDates.replaceMinutesDate($(id).value, dateValue));
  });
}
$('minutesEditorForm').addEventListener('input', () => { state.minutesEditorDirty = true; scheduleMinutesPreview(); });
$('minutesEditorForm').addEventListener('change', () => { state.minutesEditorDirty = true; scheduleMinutesPreview(); });
$('reorganizeMinutes').addEventListener('click', async () => {
  if (!confirm('Reorganize the original source into a fresh preview? Current corrections will be replaced in this editor. The saved record changes only when you save.')) return;
  const id = state.editingMinutesId;
  const before = JSON.stringify(collectMinutesDraft());
  const button = $('reorganizeMinutes'); button.disabled = true;
  try {
    const payload = await apiFetch(`/api/minutes/${id}/reorganize`, { method: 'POST', body: JSON.stringify({ expectedUpdatedAt: state.editingMinutesUpdatedAt }) });
    if (state.editingMinutesId !== id) return;
    if (JSON.stringify(collectMinutesDraft()) !== before) throw new Error('You edited the minutes while the source was being organized. Your latest edits have been kept.');
    currentMinutes().draft = payload.draft;
    openMinutesEditor(state.editingMinutesId);
    setMessage($('minutesEditorMessage'), 'Source reorganized. Review the preview, then save your corrections.');
  } catch (error) { setMessage($('minutesEditorMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('minutesEditorForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveMinutesCorrections();
    await refreshOpenMinutes('Corrections saved.');
  } catch (error) {
    setMessage($('minutesEditorMessage'), error.message, true);
  }
});
$('submitMinutesReview').addEventListener('click', async () => {
  try {
    await saveMinutesCorrections();
    await minutesAction('preparer-attest', null,
      'Your corrections and attestation are recorded. The draft is ready for the Worshipful Master.');
  } catch (error) {
    setMessage($('minutesEditorMessage'), error.message, true);
  }
});
$('authorizeMinutes').addEventListener('click', async () => {
  try {
    await saveMinutesCorrections();
    await minutesAction('master-attest', null, 'You attested to the reviewed minutes. The signed record and your corrections are available to the preparer and Secretary.');
  } catch (error) { setMessage($('minutesEditorMessage'), error.message, true); }
});
$('markMinutesDistributed').addEventListener('click', () => minutesAction(
  'mark-distributed', null, 'The record now shows that the Secretary distributed the draft.',
));
$('reopenMinutes').addEventListener('click', () => minutesAction(
  'reopen', null, 'The minutes are open for corrections. Prior distribution authorization has been cleared.',
));
$('recordMinutesApproval').addEventListener('click', () => {
  const approvalDate = $('minutesApprovalDate').value;
  if (!approvalDate) {
    setMessage($('minutesEditorMessage'), 'Enter the date on which the Lodge approved the minutes.', true);
    return;
  }
  minutesAction('lodge-approval', {
    approvalDate,
    approvalNote: $('minutesApprovalNote').value.trim(),
  }, 'The Lodge approval is recorded. The Word download is now the official record.');
});
$('downloadMinutes').addEventListener('click', async () => {
  try {
    const item = currentMinutes();
    const blob = await apiFetch(`/api/minutes/${state.editingMinutesId}/docx`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item?.status === 'approved_by_lodge' ? 'APPROVED' : 'DRAFT'}_Stone_Square_22_Minutes_${item?.meetingDate || 'undated'}.docx`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setMessage($('minutesEditorMessage'), error.message, true);
  }
});

const scheduleQueueRefresh = () => {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(async () => {
    await renderDocuments();
    if (state.user?.role === 'owner') await renderOfficers();
  }, 180);
};

const setLiveState = (connected) => {
  $('liveStatus').classList.toggle('connected', connected);
  $('liveStatus').lastChild.textContent = connected ? ' Live queue connected' : ' Reconnecting live queue';
};

const startRealtime = async () => {
  state.realtimeAbort?.abort();
  const controller = new AbortController();
  state.realtimeAbort = controller;
  while (state.user && !controller.signal.aborted) {
    try {
      const response = await fetch('/api/events', {
        credentials: 'same-origin',
        headers: { 'X-Stone-Square-Client': 'web' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Live connection unavailable.');
      setLiveState(true);
      await refreshMinutesReviewAlerts();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        events.forEach((event) => {
          if (event.includes('event: minutes_review_changed')) refreshMinutesReviewAlerts();
          if (event.includes('event: queue_changed') || event.includes('event: profile_changed')) {
            scheduleQueueRefresh();
          }
          /* The server was already broadcasting this and nobody was listening, so a Warden
           * watching his proposal saw a stale card until he reloaded. */
          if (event.includes('event: proposals_changed')) {
            const section = state.user?.role === 'owner' ? 'proposalReviewSection' : 'proposalsSection';
            if (!$(section)?.classList.contains('hidden')) renderProposals();
          }
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setLiveState(false);
    }
    await delay(2500);
  }
};

const renderDocuments = async () => {
  if (!can('documents.status')) return [];
  try {
    const { documents } = await apiFetch('/api/documents');
    $('metricAll').textContent = documents.length;
    $('metricPending').textContent = documents.filter((item) => item.status === 'pending').length;
    $('metricComplete').textContent = documents.filter((item) => item.status === 'completed').length;
    const awaiting = ['owner', 'viewer', 'warden'].includes(state.user?.role)
      ? documents.filter((item) => !['completed', 'rescinded'].includes(item.status)).length
      : documents.filter((item) => item.needsSignature && !['completed', 'rescinded'].includes(item.status)).length;
    $('dispensationsMenuCard').classList.toggle('awaiting', awaiting > 0);
    $('dispensationsMenuStatus').textContent = awaiting > 0
      ? `${awaiting} document${awaiting === 1 ? '' : 's'} awaiting action`
      : 'Open the dispensation queue';
    const list = $('docList');
    list.innerHTML = '';
    if (!documents.length) {
      list.innerHTML = '<div class="empty-state"><span>◇</span><h3>The queue is clear</h3><p>New dispensation requests will appear here automatically.</p></div>';
      return documents;
    }
    let queueNumber = 0;
    documents.forEach((doc) => {
      if (!['completed', 'rescinded'].includes(doc.status)) queueNumber += 1;
      const article = window.document.createElement('article');
      article.className = 'doc-row';
      const signerHtml = doc.signers.map((signer) =>
        `<span class="signer ${signer.signed_at ? 'signed' : ''}">${signer.signed_at ? '✓' : '○'} ${escapeMarkup(signer.signer_name)}</span>`).join('');
      const status = doc.status === 'rescinded'
        ? 'Rescinded'
        : doc.status === 'completed' ? 'Completed'
        : doc.needsSignature ? 'Your signature is needed' : 'Awaiting signatures';
      const statusClass = ['pending', 'partially_signed', 'completed', 'rescinded'].includes(doc.status) ? doc.status : 'pending';
      article.innerHTML = `
        <div class="queue-number">${doc.status === 'rescinded' ? 'R' : doc.status === 'completed' ? '✓' : queueNumber}</div>
        <div class="doc-icon">PDF</div>
        <div class="doc-main"><h3></h3><p>${formatDate(doc.created_at)} · ${signerHtml}</p></div>
        <span class="status ${statusClass}">${status}</span>
        <div class="doc-actions"></div>`;
      article.querySelector('h3').textContent = doc.title || doc.original_name;
      const actions = article.querySelector('.doc-actions');
      const openButton = window.document.createElement('button');
      openButton.className = 'text-button';
      openButton.textContent = 'View PDF';
      openButton.addEventListener('click', () => openPdf(doc.id, doc.original_name));
      if (state.user?.role === 'owner' || (can('documents.sign') && ['secretary','assistant_secretary','signer'].includes(state.user?.role))) actions.appendChild(openButton);
      if (can('documents.sign') && doc.needsSignature && !['completed', 'rescinded'].includes(doc.status)) {
        const signButton = window.document.createElement('button');
        signButton.className = 'primary compact';
        signButton.textContent = 'Review and sign';
        signButton.addEventListener('click', () => openSignerModal(doc.id, doc.title));
        actions.appendChild(signButton);
      }
      /* A completed dispensation is not done until the District Deputy has it. Say plainly
       * whether it went, because a silent failure is how one misses its date. */
      if (!['viewer', 'warden'].includes(state.user?.role) && doc.status === 'completed' && doc.template_kind === 'dispensation_v1') {
        const note = window.document.createElement('p');
        note.className = 'queue-submission';
        if (doc.submitted_at) {
          note.textContent = `Sent to the District Deputy ${new Date(doc.submitted_at).toLocaleString()}`;
        } else {
          note.textContent = doc.submitted_error
            ? `NOT sent to the District Deputy. ${doc.submitted_error}`
            : 'Not yet sent to the District Deputy.';
          note.classList.add('queue-submission-warn');
        }
        article.querySelector('.doc-main').appendChild(note);
      }
      if (state.user?.role === 'owner' && doc.status === 'completed'
          && doc.template_kind === 'dispensation_v1') {
        /* Opens his own mail client with the note already written, and downloads the executed PDF
         * at the same time so it is sitting in Downloads ready to drag in. mailto has no
         * attachment field, so the download is the closest thing to attaching it for him. */
        const draftButton = window.document.createElement('button');
        draftButton.className = 'secondary compact';
        draftButton.textContent = 'Draft in my mail app';
        draftButton.addEventListener('click', async () => {
          try {
            const { draft } = await apiFetch(`/api/documents/${doc.id}/submission-draft`);
            const blob = await apiFetch(`/api/documents/${doc.id}/file`);
            const url = URL.createObjectURL(blob);
            const link = window.document.createElement('a');
            link.href = url;
            link.download = draft.filename;
            window.document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            setMessage(docMessage,
              `${draft.filename} has been downloaded. Your mail app is opening with the note written. Drag the PDF in and send.`);
            window.location.href = `mailto:${encodeURIComponent(draft.to)}`
              + `?subject=${encodeURIComponent(draft.subject)}`
              + `&body=${encodeURIComponent(draft.body)}`;
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(draftButton);
      }
      if (state.user?.role === 'owner' && doc.status === 'completed'
          && doc.template_kind === 'dispensation_v1') {
        const sendButton = window.document.createElement('button');
        sendButton.className = doc.submitted_at ? 'secondary compact' : 'primary compact';
        sendButton.textContent = doc.submitted_at ? 'Send again' : 'Send to the District Deputy';
        sendButton.addEventListener('click', async () => {
          if (doc.submitted_at
              && !window.confirm('This already went to the District Deputy. Send it to him again?')) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/submit`, {
              method: 'POST', body: JSON.stringify({ resend: Boolean(doc.submitted_at) }),
            });
            setNotificationMessage(docMessage, payload.message || 'Sent to the District Deputy.', payload);
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(sendButton);
      }
      /* Only worth offering while exactly one of the two Secretaries is on it. */
      const secretaryRoles = ['secretary', 'assistant_secretary'];
      const onIt = secretaryRoles.filter((role) => (doc.signers || []).some((s) => s.signer_role === role));
      if (state.user?.role === 'owner' && onIt.length === 1
          && !['completed', 'rescinded'].includes(doc.status)) {
        const bothButton = window.document.createElement('button');
        bothButton.className = 'secondary compact';
        bothButton.textContent = 'Let either Secretary sign';
        bothButton.addEventListener('click', async () => {
          if (!window.confirm(`Send ${doc.title || doc.original_name} to both Secretaries? Whoever signs first completes it.`)) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/offer-to-both`, { method: 'POST' });
            setNotificationMessage(docMessage, payload.message || 'Either Secretary can now sign it.', payload);
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(bothButton);
      }
      if (state.user?.role === 'owner' && !['completed', 'rescinded'].includes(doc.status)) {
        const rescindButton = window.document.createElement('button');
        rescindButton.className = 'secondary compact danger';
        rescindButton.textContent = 'Rescind';
        rescindButton.addEventListener('click', async () => {
          if (!window.confirm(`Rescind ${doc.title || doc.original_name}? It will be removed from the active signing queue.`)) return;
          try {
            const payload = await apiFetch(`/api/documents/${doc.id}/rescind`, { method: 'POST' });
            setMessage(docMessage, payload.message || 'Document rescinded.');
            await renderDocuments();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        actions.appendChild(rescindButton);
      }
      // Status access alone never supplies document or signature actions.
      list.appendChild(article);
    });
    return documents;
  } catch (error) {
    setMessage(docMessage, error.message, true);
    return [];
  }
};

const showPendingSignatureNotice = (user, documents) => {
  const pending = ['owner', 'viewer', 'warden'].includes(user.role)
    ? documents.filter((document) => !['completed', 'rescinded'].includes(document.status))
    : documents.filter((document) => document.needsSignature && !['completed', 'rescinded'].includes(document.status));
  if (!pending.length) return;
  state.pendingReviewDocument = pending[0];
  $('pendingSignatureTitle').textContent = user.role === 'owner'
    ? (pending.length === 1 ? 'Dispensation activity awaiting review' : `${pending.length} dispensations awaiting review`)
    : ['viewer', 'warden'].includes(user.role)
      ? (pending.length === 1 ? 'Dispensation activity ready to view' : `${pending.length} dispensations ready to view`)
    : (pending.length === 1 ? 'Dispensation awaiting review and signature' : `${pending.length} dispensations awaiting review and signature`);
  $('pendingSignatureMessage').textContent = ['owner', 'viewer', 'warden'].includes(user.role)
    ? `${pending.length} active dispensation${pending.length === 1 ? ' is' : 's are'} in the officer signing queue.`
    : (pending.length === 1
      ? `${pending[0].title || pending[0].original_name} is assigned to you and ready for review.`
      : `You have ${pending.length} assigned dispensations ready for review.`);
  show($('pendingSignatureNotice'));
};

$('dismissPendingSignature').addEventListener('click', () => hide($('pendingSignatureNotice')));
$('reviewPendingSignature').addEventListener('click', () => {
  const document = state.pendingReviewDocument;
  hide($('pendingSignatureNotice'));
  if (['owner', 'viewer', 'warden'].includes(state.user?.role)) {
    showWorkspaceSection('queue');
  } else if (document) {
    openSignerModal(document.id, document.title || document.original_name);
  }
});

/* Chrome blocks window.open once the click's user gesture has been spent on an await,
 * which every one of these does while the PDF renders. The tab never appeared and nothing
 * said why. The app already has a viewer modal, so show it there. */
const showPdfBlob = (blob, title) => {
  if (state.pdfObjectUrl) URL.revokeObjectURL(state.pdfObjectUrl);
  const url = URL.createObjectURL(blob);
  state.pdfObjectUrl = url;
  $('pdfViewerTitle').textContent = title;
  $('pdfFrame').src = url;
  show($('pdfModal'));
};

const openPdf = async (id, fileName) => {
  try {
    setMessage(docMessage, 'Loading protected PDF...');
    const blob = await apiFetch(`/api/documents/${id}/file`);
    showPdfBlob(blob, fileName || 'Lodge document');
    setMessage(docMessage, '');
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
};

$('closePdf').addEventListener('click', () => {
  hide($('pdfModal'));
  $('pdfFrame').removeAttribute('src');
  if (state.pdfObjectUrl) URL.revokeObjectURL(state.pdfObjectUrl);
  state.pdfObjectUrl = '';
});

const renderOfficers = async () => {
  try {
    const { renderAccessControls } = await import('/access-controls.js');
    await renderAccessControls($('accessControls'), apiFetch);
    const { officers, pending = [] } = await apiFetch('/api/officers');
    const list = $('officerList');
    list.innerHTML = '';
    const activeByRole = new Map(officers.filter((officer) => officer.role !== 'viewer').map((officer) => [officer.role, officer]));
    /* Three states, not two. A man who has been invited and has not taken it up yet is pending,
     * and calling that "invitation needed" is how he ends up invited twice. */
    const pendingByRole = new Map(pending.map((invite) => [invite.role, invite]));
    const seat = (role, fallbackName) => {
      const active = activeByRole.get(role);
      if (active) return { ...active, state: 'active' };
      const waiting = pendingByRole.get(role);
      if (waiting) return { ...waiting, state: 'pending' };
      return { role, name: fallbackName, email: '', state: 'none' };
    };
    const entries = [
      seat('secretary', 'William McDuffie'),
      seat('assistant_secretary', 'Adrian Reese'),
      seat('treasurer', 'Treasurer'),
      seat('assistant_treasurer', 'Assistant Treasurer'),
      ...officers.filter((officer) => ['viewer','warden','member','treasury_preparer','officer'].includes(officer.role)).map((o) => ({ ...o, state: 'active' })),
      ...pending.filter((invite) => ['viewer','warden','member','treasury_preparer','officer'].includes(invite.role)).map((i) => ({ ...i, state: 'pending' })),
    ];
    entries.forEach((officer) => {
      const row = window.document.createElement('div');
      const badge = window.document.createElement('span');
      badge.className = 'officer-initials';
      badge.textContent = initials(officer.name);
      const details = window.document.createElement('p');
      const strong = window.document.createElement('strong');
      strong.textContent = officer.name;
      const small = window.document.createElement('small');
      const stateLabel = officer.state === 'active'
        ? 'Active'
        : officer.state === 'pending' ? 'Pending, invited and not signed in yet' : 'Invitation needed';
      small.textContent = `${roleLabel(officer.role)} · ${stateLabel}`;
      details.append(strong, small);
      const status = window.document.createElement('i');
      if (officer.state === 'active') status.className = 'active';
      else if (officer.state === 'pending') status.className = 'pending';
      row.append(badge, details, status);
      if (officer.state === 'active') {
        const revoke = window.document.createElement('button');
        revoke.className = 'text-button danger';
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async () => {
          if (!window.confirm(`Revoke access for ${officer.name}? They will be signed out immediately.`)) return;
          try {
            const result = await apiFetch('/api/officers/revoke', {
              method: 'POST',
              body: JSON.stringify({ email: officer.email }),
            });
            setMessage(docMessage, result.message);
            await renderOfficers();
          } catch (error) {
            setMessage(docMessage, error.message, true);
          }
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  } catch (error) {
    const note = document.createElement('p');
    note.className = 'helper';
    note.textContent = error.message || 'Officer accounts could not load.';
    $('officerList').replaceChildren(note);
  }
};

$('showLogin').addEventListener('click', () => setActiveTab('login'));
$('reconnectSession').addEventListener('click', () => window.location.reload());
$('dismissSessionNotice').addEventListener('click', () => hide($('sessionNotice')));
$('sessionDetails').addEventListener('click', () => {
  show($('sessionNotice'));
  $('sessionNotice').scrollIntoView({ block: 'nearest' });
});
$('showRegister').addEventListener('click', () => setActiveTab('register'));
$('showReset').addEventListener('click', () => setActiveTab('reset'));

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value,
        client: 'web',
      }),
    });
    state.legacyToken = '';
    localStorage.removeItem('stone-square-sign-token');
    state.authEpoch += 1;
    await enterWorkspace(payload.user, payload.session);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: $('registerName').value.trim(),
        email: $('registerEmail').value.trim(),
        password: $('registerPassword').value,
        invitationToken: state.invitationToken,
        role: $('registerRole').value,
        accessCode: $('registerAccessCode').value.trim(),
        client: 'web',
      }),
    });
    state.legacyToken = '';
    localStorage.removeItem('stone-square-sign-token');
    state.authEpoch += 1;
    history.replaceState({}, '', '/');
    await enterWorkspace(payload.user, payload.session);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('requestReset').addEventListener('click', async () => {
  try {
    const payload = await apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({
        email: $('resetEmail').value.trim(),
      }),
    });
    setMessage(authMessage, payload.message);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('resetSubmit').addEventListener('click', async () => {
  try {
    const payload = await apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: $('resetEmail').value.trim(),
        code: $('resetCode').value.trim(),
        newPassword: $('resetPassword').value,
      }),
    });
    setActiveTab('login');
    setMessage(authMessage, payload.message);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  state.realtimeAbort?.abort();
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.authEpoch += 1;
  state.legacyToken = '';
  state.user = null;
  state.reportHandoff = null;
  state.reportHandoffExpiresAt = 0;
  localStorage.removeItem('stone-square-sign-token');
  /* Every modal belongs to the session that opened it. Leaving one up over the sign-in
   * screen shows the next person Lodge business he has no account for. */
  document.querySelectorAll('.modal').forEach((modal) => hide(modal));
  hide($('appCard'));
  show($('authCard'));
  setActiveTab('login');
});

$('documentFile').addEventListener('change', () => {
  $('selectedFile').textContent = $('documentFile').files[0]?.name || 'No file selected';
});
$('uploadShortcut').addEventListener('click', () => {
  showWorkspaceSection('queue');
  $('uploadPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

const builderToday = new Date();
const builderTodayValue = [builderToday.getFullYear(), String(builderToday.getMonth() + 1).padStart(2, '0'), String(builderToday.getDate()).padStart(2, '0')].join('-');
$('dispRequestDate').value = builderTodayValue;
['dispMasterAddress'].forEach((id) => {
  $(id).addEventListener('input', () => { $('confirmSubmissionProfiles').checked = false; });
});
$('reviewPastedDetails').addEventListener('click', async () => {
  const text = $('dispPasteDetails').value.trim();
  if (!text) return setMessage($('builderMessage'), 'Paste the dispensation information first.', true);
  try {
    const result = await apiFetch('/api/dispensations/parse', {
      method: 'POST', body: JSON.stringify({ text }),
    });
    state.parsedDispensation = result;
    const labels = {
      title: 'Title', requestDate: 'Request date', signerRole: 'Send to', requestDetails: 'Request',
      eventDate: 'Event date', eventTime: 'Event time', locationName: 'Location',
      streetAddress: 'Street', cityState: 'City, state, ZIP',
      worshipfulMasterAddress: 'Worshipful Master address', secretaryAddress: 'Officer address',
    };
    const container = $('pasteReviewFields');
    container.innerHTML = '';
    Object.entries(labels).forEach(([key, label]) => {
      if (!result.fields[key] && ['worshipfulMasterAddress', 'secretaryAddress'].includes(key)) return;
      const row = window.document.createElement('div');
      const name = window.document.createElement('strong');
      const value = window.document.createElement('span');
      name.textContent = label;
      let displayValue = result.fields[key] || 'Not found';
      if (key === 'signerRole') {
        displayValue = result.fields[key] === 'assistant_secretary'
          ? SIGNER_CHOICES.assistant_secretary.label : SIGNER_CHOICES.both.label;
      } else if (key === 'eventTime' && /^\d{1,2}:\d{2}$/.test(result.fields[key] || '')) {
        const [hourText, minute] = result.fields[key].split(':');
        const hour = Number(hourText);
        displayValue = `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
      } else if ((key === 'requestDate' || key === 'eventDate') && /^\d{4}-\d{2}-\d{2}$/.test(result.fields[key] || '')) {
        displayValue = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })
          .format(new Date(`${result.fields[key]}T12:00:00Z`));
      }
      value.textContent = displayValue;
      row.append(name, value);
      container.appendChild(row);
    });
    $('pasteReviewWarnings').textContent = result.warnings.join(' ');
    show($('pasteReviewModal'));
  } catch (error) {
    setMessage($('builderMessage'), error.message, true);
  }
});
$('findLocationAddress').addEventListener('click', async () => {
  const locationName = $('dispLocationName').value.trim();
  if (!locationName) return setMessage($('builderMessage'), 'Enter the event location name first.', true);
  try {
    setMessage($('builderMessage'), 'Searching for the event address...');
    const { matches } = await apiFetch('/api/locations/search', {
      method: 'POST',
      body: JSON.stringify({ locationName, cityState: $('dispCityState').value.trim() }),
    });
    if (!matches.length) throw new Error('No matching address was found. Add a city or ZIP code and try again.');
    state.locationMatch = matches[0];
    $('locationMatchName').textContent = matches[0].displayName;
    $('locationMatchStreet').textContent = matches[0].streetAddress;
    $('locationMatchCity').textContent = matches[0].cityState;
    setMessage($('builderMessage'), '');
    show($('locationConfirmModal'));
  } catch (error) {
    setMessage($('builderMessage'), error.message, true);
  }
});
$('rejectLocationAddress').addEventListener('click', () => hide($('locationConfirmModal')));
$('useLocationAddress').addEventListener('click', () => {
  if (!state.locationMatch) return;
  $('dispStreet').value = state.locationMatch.streetAddress;
  $('dispCityState').value = state.locationMatch.cityState;
  hide($('locationConfirmModal'));
});
$('rejectPastedDetails').addEventListener('click', () => hide($('pasteReviewModal')));
$('usePastedDetails').addEventListener('click', fillFormFromParsedDispensation);

/* The builder asks one question, "send to", and the server takes a list. Sending to
 * both is the ordinary case: either Secretary may sign and the first one finishes it. */
const SIGNER_CHOICES = {
  both: { roles: ['secretary', 'assistant_secretary'], label: 'Both Secretaries, whoever signs first' },
  secretary: { roles: ['secretary'], label: 'William McDuffie, Secretary' },
  assistant_secretary: { roles: ['assistant_secretary'], label: 'Adrian Reese, Assistant Secretary' },
};
/* The Lodge no longer chooses. Every dispensation goes to both Secretaries. */
const signerChoice = () => SIGNER_CHOICES.both;

const dispensationPayload = () => ({
  title: $('dispTitle').value.trim(),
  requestDate: $('dispRequestDate').value,
  signerRoles: signerChoice().roles,
  requestDetails: $('dispRequestDetails').value.trim(),
  eventDate: $('dispEventDate').value,
  eventTime: $('dispEventTime').value,
  locationName: $('dispLocationName').value.trim(),
  streetAddress: $('dispStreet').value.trim(),
  cityState: $('dispCityState').value.trim(),
  worshipfulMasterAddress: $('dispMasterAddress').value.trim(),
  personalInfoConfirmed: $('confirmSubmissionProfiles').checked,
});

$('dispensationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('builderMessage');
  try {
    setMessage(message, 'Creating your PDF preview...');
    const blob = await apiFetch('/api/dispensations/preview', { method: 'POST', body: JSON.stringify(dispensationPayload()) });
    if (state.dispensationPreviewUrl) URL.revokeObjectURL(state.dispensationPreviewUrl);
    state.dispensationPreviewUrl = URL.createObjectURL(blob);
    $('dispensationPreviewFrame').src = state.dispensationPreviewUrl;
    const payload = dispensationPayload();
    const rows = [
      ['Title', payload.title], ['Request', payload.requestDetails],
      ['Event', `${payload.eventDate} at ${formatClockTime(payload.eventTime)}`],
      ['Location', `${payload.locationName}, ${payload.streetAddress}, ${payload.cityState}`],
      ['Send to', signerChoice().label],
      ['Worshipful Master address', payload.worshipfulMasterAddress],
    ];
    const container = $('finalReviewFields');
    container.innerHTML = '';
    rows.forEach(([label, value]) => {
      const row = window.document.createElement('div');
      const name = window.document.createElement('strong');
      const content = window.document.createElement('span');
      name.textContent = label;
      content.textContent = value;
      row.append(name, content);
      container.appendChild(row);
    });
    setMessage(message, '');
    show($('dispensationFinalReview'));
  } catch (error) {
    setMessage(message, error.message, true);
  }
});

$('backFromFinalReview').addEventListener('click', () => hide($('dispensationFinalReview')));
$('sendDispensation').addEventListener('click', async () => {
  try {
    setMessage($('finalReviewMessage'), 'Sending the dispensation to the officer queue...');
    const payload = await apiFetch('/api/dispensations', { method: 'POST', body: JSON.stringify(dispensationPayload()) });
    hide($('dispensationFinalReview'));
    $('dispensationForm').reset();
    state.dispensationDirty = false;
    clearSessionDraft('dispensation');
    $('dispRequestDate').value = builderTodayValue;
    applySubmissionProfiles();
    document.querySelectorAll('.parsed-covered').forEach((element) => element.classList.remove('hidden'));
    hide($('remainingQuestionsIntro'));
    showWorkspaceSection('queue');
    setNotificationMessage(docMessage, 'Dispensation created from the official template and added to the queue.', payload);
    await renderDocuments();
  } catch (error) {
    setMessage($('finalReviewMessage'), error.message, true);
  }
});

$('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('documentFile').files[0];
  if (!file) return setMessage(docMessage, 'Choose a PDF first.', true);
  try {
    setMessage(docMessage, 'Reading document and adding it to the live queue...');
    const form = new FormData();
    form.append('document', file);
    form.append('title', $('docTitle').value.trim());
    const payload = await apiFetch('/api/documents', { method: 'POST', body: form });
    $('uploadForm').reset();
    $('selectedFile').textContent = 'No file selected';
    setNotificationMessage(docMessage, 'Document added to the live queue.', payload);
    await renderDocuments();
  } catch (error) {
    setMessage(docMessage, error.message, true);
  }
});

$('openInvite').addEventListener('click', () => {
  show($('inviteModal'));
  hide($('inviteResult'));
});
$('closeInvite').addEventListener('click', () => hide($('inviteModal')));
$('inviteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await apiFetch('/api/officers/invite', {
      method: 'POST',
      body: JSON.stringify({
        role: $('inviteRole').value,
        name: $('inviteName').value.trim(),
        email: $('inviteEmail').value.trim(),
      }),
    });
    state.invitationUrl = payload.inviteUrl;
    $('inviteMessage').textContent = payload.emailSent
      ? 'Invitation emailed. The private link expires in seven days.'
      : 'Invitation created. Email delivery is not connected, so copy and send this private link directly.';
    show($('inviteResult'));
    await renderOfficers();
  } catch (error) {
    $('inviteMessage').textContent = error.message;
    show($('inviteResult'));
  }
});
$('copyInvite').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.invitationUrl);
  $('copyInvite').textContent = 'Private link copied';
});

const profileCanvas = $('profileSigCanvas');
const profileContext = profileCanvas.getContext('2d');
let profileDrawing = false;

const configureProfileCanvas = () => {
  const ratio = window.devicePixelRatio || 1;
  profileCanvas.width = Math.floor(profileCanvas.clientWidth * ratio);
  profileCanvas.height = Math.floor(profileCanvas.clientHeight * ratio);
  profileContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  profileContext.strokeStyle = '#071b2f';
  profileContext.lineWidth = 2.6;
  profileContext.lineCap = 'round';
  profileContext.lineJoin = 'round';
};

const profilePoint = (event) => {
  const rect = profileCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

profileCanvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  profileDrawing = true;
  const point = profilePoint(event);
  profileContext.beginPath();
  profileContext.moveTo(point.x, point.y);
});
profileCanvas.addEventListener('pointermove', (event) => {
  if (!profileDrawing) return;
  event.preventDefault();
  const point = profilePoint(event);
  profileContext.lineTo(point.x, point.y);
  profileContext.stroke();
  state.profileHasInk = true;
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((name) => {
  profileCanvas.addEventListener(name, () => { profileDrawing = false; });
});

const clearProfileCanvas = () => {
  profileContext.clearRect(0, 0, profileCanvas.clientWidth, profileCanvas.clientHeight);
  state.profileHasInk = false;
};

const typedSignatureStyles = [
  { label: 'Classic Script', font: '"Snell Roundhand", "Segoe Script", cursive', size: 64, skew: 0, rotation: 0 },
  { label: 'Bold Script', font: '"Snell Roundhand", "Segoe Script", cursive', size: 61, weight: 700, skew: 0, rotation: 0 },
  { label: 'Formal Chancery', font: '"Apple Chancery", "URW Chancery L", cursive', size: 55, skew: -0.08, rotation: 0 },
  { label: 'Elegant Script', font: '"Savoye LET", "Brush Script MT", cursive', size: 61, skew: 0, rotation: 0 },
  { label: 'House Script', font: 'SignPainter, "Brush Script MT", cursive', size: 60, skew: -0.04, rotation: 0 },
  { label: 'Ornate Pen', font: 'Zapfino, "Snell Roundhand", cursive', size: 43, skew: 0, rotation: 0 },
  { label: 'Personal Note', font: 'Noteworthy, "Segoe Print", cursive', size: 56, skew: 0, rotation: -0.02 },
  { label: 'Natural Hand', font: '"Bradley Hand", "Segoe Print", cursive', size: 58, skew: 0, rotation: -0.035 },
];

const drawTypedSignature = (canvas, name, styleIndex) => {
  const ratio = window.devicePixelRatio || 1;
  const width = 620;
  const height = 145;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#071b2f';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const style = typedSignatureStyles[styleIndex] || typedSignatureStyles[0];
  context.font = `${style.weight || 400} ${style.size}px ${style.font}`;
  const safeName = name || 'Your Name';
  const measured = context.measureText(safeName).width;
  const scale = Math.min(1, 535 / Math.max(measured, 1));
  context.save();
  context.translate(width / 2, height / 2 - 3);
  if (style.skew) context.transform(1, 0, style.skew, 1, 0, 0);
  if (style.rotation) context.rotate(style.rotation);
  context.scale(scale, 1);
  context.fillText(safeName, 0, 0);
  context.restore();
};

const renderTypedChoices = () => {
  const name = $('typedSignatureName').value.trim() || state.user?.name || 'Your Name';
  const container = $('typedSignatureChoices');
  container.innerHTML = '';
  for (let index = 0; index < typedSignatureStyles.length; index += 1) {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = `signature-choice ${state.selectedTypedStyle === index ? 'selected' : ''}`;
    button.setAttribute('aria-label', typedSignatureStyles[index].label);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, index);
    button.appendChild(canvas);
    const label = window.document.createElement('span');
    label.textContent = typedSignatureStyles[index].label;
    button.appendChild(label);
    button.addEventListener('click', () => {
      state.selectedTypedStyle = index;
      renderTypedChoices();
    });
    container.appendChild(button);
  }
};

const signatureInitialsFromName = (name) => name
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((part) => part[0])
  .join('')
  .slice(0, 4)
  .toUpperCase();

const renderInitialsChoices = () => {
  const value = $('signatureInitials').value.trim().toUpperCase()
    || signatureInitialsFromName(state.user?.name || '')
    || 'WDS';
  const container = $('initialsSignatureChoices');
  container.innerHTML = '';
  for (let index = 0; index < typedSignatureStyles.length; index += 1) {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = `signature-choice ${state.selectedTypedStyle === index ? 'selected' : ''}`;
    button.setAttribute('aria-label', `${typedSignatureStyles[index].label} initials`);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, value, index);
    button.appendChild(canvas);
    const label = window.document.createElement('span');
    label.textContent = typedSignatureStyles[index].label;
    button.appendChild(label);
    button.addEventListener('click', () => {
      state.selectedTypedStyle = index;
      renderInitialsChoices();
    });
    container.appendChild(button);
  }
};

const selectSignatureMode = (mode) => {
  state.signatureMode = mode;
  $('chooseDraw').classList.toggle('active', mode === 'drawn');
  $('chooseType').classList.toggle('active', mode === 'typed');
  $('chooseInitials').classList.toggle('active', mode === 'initials');
  $('drawSignaturePanel').classList.toggle('hidden', mode !== 'drawn');
  $('typeSignaturePanel').classList.toggle('hidden', mode !== 'typed');
  $('initialsSignaturePanel').classList.toggle('hidden', mode !== 'initials');
  if (mode === 'typed') renderTypedChoices();
  if (mode === 'initials') renderInitialsChoices();
};

const openSignatureSetup = (required = false) => {
  state.signatureRequired = required;
  $('closeSignatureSetup').classList.toggle('hidden', required);
  $('signatureSetupTitle').textContent = required ? 'Create your signature to continue' : 'Change your saved signature';
  $('signatureSetupHelp').textContent = required
    ? 'Choose how your signature should appear when you sign a report or an assigned document.'
    : 'The new signature will be used on documents you sign after it is saved.';
  $('typedSignatureName').value = state.user?.name || '';
  $('signatureInitials').value = signatureInitialsFromName(state.user?.name || '');
  state.selectedTypedStyle = 0;
  show($('signatureSetupModal'));
  selectSignatureMode('typed');
  configureProfileCanvas();
  clearProfileCanvas();
  setMessage($('profileSignatureMessage'), '');
};

$('profileButton').addEventListener('click', () => openSignatureSetup(false));
$('chooseDraw').addEventListener('click', () => selectSignatureMode('drawn'));
$('chooseType').addEventListener('click', () => selectSignatureMode('typed'));
$('chooseInitials').addEventListener('click', () => selectSignatureMode('initials'));
$('typedSignatureName').addEventListener('input', renderTypedChoices);
$('signatureInitials').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase();
  renderInitialsChoices();
});
$('clearProfileSig').addEventListener('click', clearProfileCanvas);
$('closeSignatureSetup').addEventListener('click', () => {
  if (!state.signatureRequired) hide($('signatureSetupModal'));
});

$('saveProfileSignature').addEventListener('click', async () => {
  let signatureData;
  let styleName = 'drawn';
  if (state.signatureMode === 'drawn') {
    if (!state.profileHasInk) {
      return setMessage($('profileSignatureMessage'), 'Draw your signature before saving.', true);
    }
    signatureData = profileCanvas.toDataURL('image/png');
  } else if (state.signatureMode === 'typed') {
    const name = $('typedSignatureName').value.trim();
    if (!name) return setMessage($('profileSignatureMessage'), 'Type your name before choosing a style.', true);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, name, state.selectedTypedStyle);
    signatureData = canvas.toDataURL('image/png');
    styleName = `cursive-${state.selectedTypedStyle + 1}`;
  } else {
    const value = $('signatureInitials').value.trim().toUpperCase();
    if (!value) return setMessage($('profileSignatureMessage'), 'Enter your initials before choosing a style.', true);
    const canvas = window.document.createElement('canvas');
    drawTypedSignature(canvas, value, state.selectedTypedStyle);
    signatureData = canvas.toDataURL('image/png');
    styleName = `initials-${state.selectedTypedStyle + 1}`;
  }
  try {
    const payload = await apiFetch('/api/profile/signature', {
      method: 'PUT',
      body: JSON.stringify({
        signatureData,
        signatureType: state.signatureMode,
        styleName,
      }),
    });
    state.user = payload.user;
    state.signatureRequired = false;
    hide($('signatureSetupModal'));
    setMessage(docMessage, 'Your signature profile is saved.');
  } catch (error) {
    setMessage($('profileSignatureMessage'), error.message, true);
  }
});

const loadSavedSignature = async (imageElement) => {
  const blob = await apiFetch('/api/profile/signature');
  if (state.signatureObjectUrl) URL.revokeObjectURL(state.signatureObjectUrl);
  state.signatureObjectUrl = URL.createObjectURL(blob);
  imageElement.src = state.signatureObjectUrl;
};

const openSignerModal = async (documentId, title) => {
  if (!state.user?.hasSignature) return openSignatureSetup(true);
  state.signingDocumentId = documentId;
  $('signTitle').textContent = `Sign ${title || 'document'}`;
  $('signatureConsent').checked = false;
  $('signerName').value = '';
  $('signerAddress').value = '';
  hide($('signerInformation'));
  $('submitSig').disabled = true;
  if (state.signingPdfObjectUrl) URL.revokeObjectURL(state.signingPdfObjectUrl);
  state.signingPdfObjectUrl = null;
  $('signingPdfFrame').removeAttribute('src');
  setMessage($('signMessage'), 'Loading the document for review...');
  show($('signModal'));
  try {
    const { document } = await apiFetch(`/api/documents/${documentId}`);
    if (document.template_kind === 'dispensation_v1') {
      show($('signerInformation'));
      const { profiles } = await apiFetch('/api/submission-profiles');
      const profile = profiles.find((entry) => entry.role === state.user.role);
      $('signerName').value = profile?.name || state.user.name;
      $('signerAddress').value = profile?.address || '';
      if (!profile?.name || !profile?.address || profile.address.trim().toLowerCase() === profile.name.trim().toLowerCase()) {
        throw new Error('Ask the Worshipful Master to save your name and mailing address before signing.');
      }
    }
    const pdfResponse = await fetch(`/api/documents/${documentId}/file`, {
      credentials: 'same-origin',
      headers: { 'X-Stone-Square-Client': 'web' },
    });
    if (!pdfResponse.ok) {
      const payload = await pdfResponse.json().catch(() => ({}));
      throw new Error(payload.error || 'The PDF could not be loaded for review.');
    }
    const [pdfBlob] = await Promise.all([
      pdfResponse.blob(),
      loadSavedSignature($('signingSignaturePreview')),
    ]);
    state.signingPdfObjectUrl = URL.createObjectURL(pdfBlob);
    $('signingPdfFrame').src = state.signingPdfObjectUrl;
    $('submitSig').disabled = false;
    setMessage($('signMessage'), 'Document loaded. Review it before consenting and signing.');
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
};

const closeSignerModal = () => {
  hide($('signModal'));
  $('signingPdfFrame').removeAttribute('src');
  if (state.signingPdfObjectUrl) URL.revokeObjectURL(state.signingPdfObjectUrl);
  state.signingPdfObjectUrl = null;
  $('submitSig').disabled = true;
};

$('closeSign').addEventListener('click', closeSignerModal);
$('changeSignatureFromSign').addEventListener('click', () => {
  closeSignerModal();
  openSignatureSetup(false);
});
$('submitSig').addEventListener('click', async () => {
  if (!$('signatureConsent').checked) {
    return setMessage($('signMessage'), 'Confirm the electronic signature consent.', true);
  }
  try {
    const payload = await apiFetch(`/api/documents/${state.signingDocumentId}/sign`, {
      method: 'POST', body: JSON.stringify({ consent: true }),
    });
    closeSignerModal();
    setMessage(docMessage, payload.message);
    await renderDocuments();
  } catch (error) {
    setMessage($('signMessage'), error.message, true);
  }
});

$('dispensationForm').addEventListener('invalid', (event) => {
  event.target.closest('.parsed-covered')?.classList.remove('hidden');
  const label = document.querySelector(`label[for="${event.target.id}"]`)?.textContent?.trim() || 'required field';
  setMessage($('builderMessage'), `Complete ${label.toLowerCase()} before reviewing the PDF.`, true);
}, true);

const initialize = async () => {
  try { await minutesDatesReady; } catch { setMessage(authMessage, 'The minutes date controls could not load. Reload this page to reconnect.', true); return; }
  const inviteEmail = new URLSearchParams(window.location.search).get('email');
  if (inviteEmail) $('registerEmail').value = inviteEmail;
  try {
    const setup = await apiFetch('/api/setup');
    if (setup.registrationMode === 'access_code' && !state.invitationToken) {
      show($('selfServeFields'));
      $('registerEyebrow').textContent = 'LODGE OFFICERS';
      $('registerHeading').textContent = 'Create your account';
      $('registerHelp').textContent = 'Choose your office and enter the access code the Worshipful Master sent you.';
    }
    if (setup.needsOwnerSetup && !state.invitationToken) {
      $('registerEyebrow').textContent = 'INITIAL SETUP';
      $('registerHeading').textContent = 'Create the owner account';
      $('registerHelp').textContent = 'The first account controls document uploads and officer invitations.';
    }
  } catch (_error) {}
  if (state.invitationToken) setActiveTab('register');
  try {
    const payload = await apiFetch('/api/auth/me');
    if (state.legacyToken) {
      state.legacyToken = '';
      localStorage.removeItem('stone-square-sign-token');
    }
    state.authEpoch += 1;
    await enterWorkspace(payload.user, payload.session);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      localStorage.removeItem('stone-square-sign-token');
      state.legacyToken = '';
      if (state.invitationToken) setActiveTab('register');
    } else {
      setMessage(authMessage, 'We could not reconnect. Your sign-in may still be saved. Try reconnecting when your connection returns.', true);
      show($('reconnectSession'));
    }
  }
};

initialize();

/* ---------- Dues ----------
 * Restricted to the Worshipful Master, the Secretary and the Assistant Secretary.
 * Rendered needs-attention-first, because the point of the page is knowing who to
 * call, not admiring a total. */
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const renderDues = async (force = false) => {
  if (state.duesLoading) return;
  if (state.duesLoaded && !force) return;
  state.duesLoading = true;
  setMessage($('duesMessage'), 'Reading payments from Zeffy…');
  try {
    const led = await apiFetch('/api/dues');
    $('duesYearLine').textContent =
      `${led.duesYear} dues, ${money(led.rateCents)} each, reconciled live against both Zeffy campaigns.`;
    $('duesCollected').textContent = money(led.totals.collectedCents);
    $('duesOutstanding').textContent = money(led.totals.outstandingCents);
    $('duesPaidCount').textContent = String(led.totals.paidCount);
    $('duesUnpaidCount').textContent = String(led.totals.unpaidCount);

    const stale = $('duesStale');
    if (led.staleCampaign) {
      stale.textContent = `Last year's custom dues campaign is still open and has taken ${led.staleCampaign.count} payment(s) totalling ${money(led.staleCampaign.totalCents)}. Those are NOT counted above. Close that campaign in Zeffy.`;
      stale.classList.remove('hidden');
    } else stale.classList.add('hidden');

    const rows = $('duesRows');
    rows.replaceChildren();
    for (const r of led.rows) {
      const el = document.createElement('div');
      el.className = `item dues-row dues-${r.status}`;
      const paid = r.status === 'paid'
        ? `Paid in full${r.lastPaymentISO ? ` on ${r.lastPaymentISO}` : ''}`
        : r.status === 'partial'
          ? `${money(r.paidCents)} of ${money(r.assessedCents)}, ${money(r.remainingCents)} outstanding`
          : 'Nothing received';
      const credit = r.creditCents ? ` · ${money(r.creditCents)} credit` : '';
      const how = r.payments.length
        ? ` · matched by ${[...new Set(r.payments.map((p) => p.matchedVia))].join(', ')}`
        : '';
      el.innerHTML = `<div class="grow"><div class="name">${escapeMarkup(r.name)}</div><small>${escapeMarkup(paid + credit + how)}</small></div><span class="pill">${escapeMarkup(r.status)}</span>`;
      rows.append(el);
    }

    const panel = $('duesUnmatchedPanel');
    const un = $('duesUnmatched');
    un.replaceChildren();
    if (led.unmatched.length) {
      for (const u of led.unmatched) {
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `<div class="grow"><div class="name">${escapeMarkup(u.buyerName || u.buyerEmail || 'Unknown')}</div><small>${escapeMarkup(u.dateISO)} · ${escapeMarkup(money(u.amountCents))} · ${escapeMarkup(u.buyerEmail)}</small></div>`;
        un.append(el);
      }
      panel.classList.remove('hidden');
    } else panel.classList.add('hidden');

    setMessage($('duesMessage'), `${led.rows.length} Brothers · updated just now`);
    state.duesLoaded = true;
  } catch (error) {
    setMessage($('duesMessage'), error.message, true);
  } finally {
    state.duesLoading = false;
  }
};
