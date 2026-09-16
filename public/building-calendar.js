const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const monthBounds = date => {
  const year=date.getFullYear(), month=date.getMonth(), pad=value=>String(value).padStart(2,'0');
  return {from:`${year}-${pad(month+1)}-01`,to:`${year}-${pad(month+1)}-${pad(new Date(year,month+1,0).getDate())}`};
};
export const eventOccurs = (event, date) => event.startDate <= date && (event.endDate || event.startDate) >= date;
export const formatCalendarTime = value => {
  const text = String(value || '').trim();
  const twentyFour = text.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    return `${hour % 12 || 12}:${twentyFour[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
  }
  const twelveHour = text.match(/^(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)$/i);
  if (twelveHour) return `${Number(twelveHour[1])}:${twelveHour[2]} ${twelveHour[3].toUpperCase()}`;
  return text;
};
export const eventTime = event => event.allDay ? 'All day' : event.startTime ? `${formatCalendarTime(event.startTime)}${event.endTime ? ' to '+formatCalendarTime(event.endTime) : ''}` : 'Time not provided';
export const BUILDING_SPACES = ['Lodge building','Back yard','Front yard'];
export const frontYardOnly = spaces => Array.isArray(spaces) && spaces.length === 1 && spaces[0] === 'Front yard';
export function validateBuildingRequest(request){
  if(!request.bookings?.length||request.bookings.length>12)return 'Choose between one and twelve dates.';
  if(!request.spaces?.length||request.spaces.some(space=>!BUILDING_SPACES.includes(space)))return 'Select at least one part of the property.';
  if(frontYardOnly(request.spaces)&&typeof request.bathroomAccess!=='boolean')return 'Choose whether you will need restroom access.';
  if(!String(request.purpose||'').trim())return 'Describe the Lodge event.';
  const seen=new Set();
  for(const booking of request.bookings){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(booking.date)||Number.isNaN(Date.parse(booking.date+'T12:00:00Z'))||new Date(booking.date+'T12:00:00Z').toISOString().slice(0,10)!==booking.date)return 'Enter a valid date for every booking.';
    if(seen.has(booking.date))return 'Use one booking row per date.';seen.add(booking.date);
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(booking.start)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(booking.end)||booking.end<=booking.start)return 'Each date needs a start and later end time. Times are Eastern.';
  }
  return '';
}
export const buildingOverlaps=(bookings,busy)=>bookings.flatMap(booking=>busy.filter(block=>block.date===booking.date&&block.status!=='denied'&&(block.allDay||(block.start&&block.end&&booking.start<block.end&&booking.end>block.start))).map(block=>({...block,requestedDate:booking.date})));
export class BuildingCalendarWorkspace {
  constructor({api,user}) {this.api=api;this.user=user;this.month=new Date();this.calendarMode='month';this.buildingSequence=0;this.calendarSequence=0;this.buildingRoot=document.getElementById('buildingSection');this.calendarRoot=document.getElementById('calendarSection');this.bind();}
  can(key){return this.user()?.role==='owner'||Boolean(this.user()?.permissions?.includes(key));}
  bind(){
    this.calendarRoot.addEventListener('input', event=>{if(event.target.closest('#calendarEventForm'))this.calendarDirty=true;});
    this.buildingRoot.addEventListener('click',event=>{const button=event.target.closest('[data-building]');if(button){if(button.dataset.building.startsWith('request-'))void this.requestAction(button);else void this.decision(button);}});
    this.buildingRoot.addEventListener('input',event=>{const form=event.target.closest('#buildingRequestForm');if(form){this.syncBathroomQuestion(form);this.availabilityKey=null;this.saveRequestDraft(form);}});
    this.buildingRoot.addEventListener('submit',event=>{if(event.target.id==='buildingRequestForm'){event.preventDefault();void this.submitRequest(event.target);}});
    this.calendarRoot.addEventListener('click',event=>{const button=event.target.closest('[data-calendar]');if(button)this.calendarAction(button);});
    this.calendarRoot.addEventListener('submit',event=>{if(event.target.id==='calendarEventForm'){event.preventDefault();void this.saveEvent(event.target);}});
  }
  message(root,text){const element=root.querySelector('[data-message]');if(element)element.textContent=text;}
  requestDraftKey(){return this.user()?.id?`ss22-web-draft:${this.user().id}:building-request`:'';}
  clearRequestDraft(){const key=this.requestDraftKey();if(key)try{sessionStorage.removeItem(key);}catch{}}
  hasUnsavedRequest(){
    const form=this.buildingRoot.querySelector('#buildingRequestForm');if(!form)return false;
    const rows=[...form.querySelectorAll('.building-booking-row')];
    const spaces=[...form.querySelectorAll('[name="space"]:checked')].map(input=>input.value);
    return Boolean(form.querySelector('[name="purpose"]')?.value.trim()||form.querySelector('[name="phone"]')?.value.trim()||form.querySelector('[name="bathroomAccess"]:checked')||rows.length>1||rows.some(row=>[...row.querySelectorAll('[data-booking]')].some(input=>input.value))||spaces.length!==1||spaces[0]!==BUILDING_SPACES[0]);
  }
  saveRequestDraft(form){
    const key=this.requestDraftKey();if(!key)return;
    try{if(!this.hasUnsavedRequest())sessionStorage.removeItem(key);else{const draft=this.collectRequest(form);delete draft.submissionId;sessionStorage.setItem(key,JSON.stringify(draft));}}catch{}
  }
  restoreRequestDraft(form){
    const key=this.requestDraftKey();if(!key)return;
    try{const draft=JSON.parse(sessionStorage.getItem(key)||'null');if(!draft||!Array.isArray(draft.bookings))return;draft.bookings=draft.bookings.slice(0,12);const rows=form.querySelector('#buildingBookingRows');while(rows.children.length>1)rows.lastElementChild.remove();for(let index=1;index<draft.bookings.length;index++)this.addBookingRow();[...rows.children].forEach((row,index)=>{const booking=draft.bookings[index]||{};row.querySelectorAll('[data-booking]').forEach(input=>{input.value=String(booking[input.dataset.booking]||'');});});form.querySelectorAll('[name="space"]').forEach(input=>{input.checked=Array.isArray(draft.spaces)&&BUILDING_SPACES.includes(input.value)&&draft.spaces.includes(input.value);});this.syncBathroomQuestion(form);const bathroom=form.querySelector(`[name="bathroomAccess"][value="${draft.bathroomAccess===true?'yes':'no'}"]`);if(frontYardOnly(draft.spaces)&&bathroom)bathroom.checked=true;form.querySelector('[name="purpose"]').value=String(draft.purpose||'').slice(0,1000);form.querySelector('[name="phone"]').value=String(draft.phone||'').slice(0,40);form.querySelector('#buildingRequestMessage').textContent='An unfinished building request from this tab has been restored.';}catch{}
  }
  async building(){
    if(!this.can('building.view')&&!this.can('building.request'))return;
    if(this.buildingUserId!==this.user()?.id){this.requestFormOpen=false;this.requestSubmissionId=null;this.pendingRequestPayload=null;this.buildingUserId=this.user()?.id;}
    const sequence=++this.buildingSequence;
    if(!this.requestFormOpen)this.buildingRoot.innerHTML='<div class="content-head"><div><h1>Building Requests</h1><p>Requests submitted through the existing building portal.</p></div><button class="secondary" data-building="refresh">Refresh</button></div><p data-message role="status"></p><div id="buildingRequestComposer"></div><div class="building-requests"></div>';
    if(this.can('building.request')&&!this.requestFormOpen){const button=document.createElement('button');button.className='primary';button.type='button';button.dataset.building='request-new';button.textContent='New Building Request';this.buildingRoot.querySelector('#buildingRequestComposer').append(button);}
    if(!this.can('building.view')){this.buildingRoot.querySelector('.building-requests').replaceChildren();if(!this.requestFormOpen)this.newRequest();return;}
    try{const result=await this.api('/api/building/requests');if(sequence!==this.buildingSequence)return;this.requests=result.requests;this.mayDecide=result.canDecide;
      this.buildingRoot.querySelector('.building-requests').innerHTML=this.requests.length?this.requests.map(request=>`<article class="panel building-request"><div class="content-head"><div><h2>${escape(request.organization)}</h2><p>${escape(request.date)} · ${escape(request.start||'Time not provided')}${request.end?' to '+escape(request.end):''}</p></div><span class="status">${escape(request.agreementStatus==='awaiting_secretary_attestation'?'Awaiting Secretary attestation':request.agreementStatus==='fully_executed'?'Agreement complete':request.status)}</span></div><p>${escape(request.spaces?.join(', '))}</p>${frontYardOnly(request.spaces)?`<p><strong>Restroom access:</strong> ${request.bathroomAccess?'Yes':'No'}</p>`:''}<p>${escape(request.description)}</p><p>${escape(request.contactName)}${request.contact?' · '+escape(request.contact):''}</p>${request.coordinator?`<p>Request coordinator: ${escape(request.coordinator.name)} · ${escape(request.coordinator.email)}</p>`:''}${request.agreementText?`<details><summary>View full Building Use Agreement</summary><div style="white-space:pre-wrap;margin-top:12px;max-height:520px;overflow:auto;padding:16px;border:1px solid var(--line);border-radius:10px">${escape(request.agreementText)}</div></details>`:''}<p>Reference: ${escape(request.id)}</p>${request.note?`<p>Decision note: ${escape(request.note)}</p>`:''}${request.decidedBy?`<p>Recorded by ${escape(request.decidedBy)}${request.decidedAt?' · '+escape(request.decidedAt):''}</p>`:''}${request.status!=='pending'?`<p>${request.requesterNotified?'Requester notification recorded.':'Requester notification will be sent after all required signatures are recorded.'}</p>`:''}${request.agreementStatus==='awaiting_secretary_attestation'&&this.user()?.role==='secretary'?`<div data-building-attestation><p class="helper">Review the approved agreement before applying your saved Secretary signature.</p><button class="primary" data-building="attest" data-id="${escape(request.id)}">Attest agreement</button></div>`:this.can('building.decide')&&result.canDecide&&request.status==='pending'?`<div data-building-controls><label for="building-note-${escape(request.id)}">Note to the requester</label><textarea id="building-note-${escape(request.id)}" maxlength="2000">${escape(request.note||'')}</textarea>${request.ownerOnly?`<fieldset><legend>Lodge authorization and final conditions</legend><label>Authorization date<input id="building-auth-date-${escape(request.id)}" type="date"></label><label>Minutes or resolution reference<input id="building-auth-record-${escape(request.id)}" maxlength="500"></label><label>Approved fee<input id="building-auth-fee-${escape(request.id)}" maxlength="100" placeholder="Example: $25 per approved session"></label><label>Insurance decision<select id="building-auth-insurance-${escape(request.id)}"><option value="">Choose</option><option value="required">Required</option><option value="waived">Waived</option></select></label><label>Security deposit decision<select id="building-auth-deposit-${escape(request.id)}"><option value="">Choose</option><option value="required">Required</option><option value="waived">Waived</option></select></label><label>Conditions<textarea id="building-auth-conditions-${escape(request.id)}" maxlength="2000"></textarea></label></fieldset><p class="helper">Approval applies your saved signature. Secretary McDuffie must attest before the organization receives payment access.</p>`:'<p class="helper">The portal sends the decision notification to the requester and officers.</p>'}<div class="row-buttons"><button class="primary" data-building="approved" data-id="${escape(request.id)}">Approve</button><button class="secondary" data-building="denied" data-id="${escape(request.id)}">Decline</button></div></div>`:''}</article>`).join(''):'<p>No building requests.</p>';
    }catch(error){this.message(this.buildingRoot,error.message||'Building requests could not load.');}
  }
  newRequest(){
    if(!this.can('building.request')||this.requestBusy)return;
    if(this.requestFormOpen)return;
    this.requestFormOpen=true;this.pendingRequestPayload=null;this.requestSubmissionId=crypto.randomUUID();this.availabilityKey=null;
    const account=this.user();
    this.buildingRoot.querySelector('#buildingRequestComposer').innerHTML=`<form id="buildingRequestForm" class="panel building-request-form"><h2>New Building Request</h2><p>This request is for Stone Square Lodge No. 22 use, submitted under ${escape(account.name)}${account.email?' ('+escape(account.email)+')':''}. Private-party rentals use the public building request process.</p><fieldset><legend>Property requested</legend>${BUILDING_SPACES.map((space,index)=>`<label class="calendar-checkbox"><input type="checkbox" name="space" value="${space}" ${index===0?'checked':''}> ${space}</label>`).join('')}</fieldset><fieldset id="buildingBathroomAccess" hidden><legend>Front yard access</legend><p>Will you need access to the restroom?</p><label class="calendar-checkbox"><input type="radio" name="bathroomAccess" value="yes"> Yes</label><label class="calendar-checkbox"><input type="radio" name="bathroomAccess" value="no"> No</label></fieldset><h3>Dates and times</h3><p class="helper">Times are Eastern. Add one row per date, up to twelve dates.</p><div id="buildingBookingRows"></div><button class="secondary" type="button" data-building="request-add">Add another date</button><label>Event details<textarea name="purpose" required maxlength="1000"></textarea></label><label>Phone (optional)<input name="phone" type="tel" maxlength="40" autocomplete="tel"></label><button class="secondary" type="button" data-building="request-check">Review availability</button><div id="buildingRequestAvailability" role="status"></div><p class="helper">Submitting sends the request through the existing building portal and its notifications. It does not reserve the property. Wait for written Lodge approval before making arrangements that depend on the space.</p><div class="row-buttons"><button class="primary" type="submit">Submit building request</button><button class="secondary" type="button" data-building="request-cancel">Cancel</button></div><p id="buildingRequestMessage" role="status"></p></form>`;
    this.addBookingRow();
    this.restoreRequestDraft(this.buildingRoot.querySelector('#buildingRequestForm'));
    this.syncBathroomQuestion(this.buildingRoot.querySelector('#buildingRequestForm'));
  }
  syncBathroomQuestion(form){const spaces=[...form.querySelectorAll('[name="space"]:checked')].map(input=>input.value),onlyFront=frontYardOnly(spaces),section=form.querySelector('#buildingBathroomAccess');if(!section)return;section.hidden=!onlyFront;const choices=[...section.querySelectorAll('[name="bathroomAccess"]')];choices.forEach(choice=>{choice.required=onlyFront;if(!onlyFront)choice.checked=false;});}
  addBookingRow(){
    const rows=this.buildingRoot.querySelector('#buildingBookingRows');if(rows.children.length>=12)return;
    const row=document.createElement('div');row.className='building-booking-row';row.innerHTML='<label>Date<input type="date" data-booking="date" required></label><label>Start (Eastern)<input type="time" data-booking="start" required></label><label>End (Eastern)<input type="time" data-booking="end" required></label><button type="button" class="secondary" data-building="request-remove" aria-label="Remove this date">Remove</button>';rows.append(row);this.availabilityKey=null;
  }
  collectRequest(form){const spaces=[...form.querySelectorAll('[name="space"]:checked')].map(input=>input.value),bathroom=form.querySelector('[name="bathroomAccess"]:checked');return{bookings:[...form.querySelectorAll('.building-booking-row')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-booking]')].map(input=>[input.dataset.booking,input.value]))),spaces,bathroomAccess:frontYardOnly(spaces)?(bathroom?.value==='yes'?true:bathroom?.value==='no'?false:null):null,phone:form.querySelector('[name="phone"]').value.trim(),purpose:form.querySelector('[name="purpose"]').value.trim(),submissionId:this.requestSubmissionId};}
  async requestAction(button){
    if(this.requestBusy||!this.can('building.request'))return;
    if(this.pendingRequestPayload){this.buildingRoot.querySelector('#buildingRequestMessage').textContent='The previous submission has not been confirmed. Retry the original request before making changes.';return;}
    const action=button.dataset.building;
    if(action==='request-new')return this.newRequest();
    if(action==='request-add')return this.addBookingRow();
    if(action==='request-remove'){if(this.buildingRoot.querySelector('#buildingBookingRows').children.length>1){button.closest('.building-booking-row').remove();this.availabilityKey=null;}return;}
    if(action==='request-cancel'){if(this.hasUnsavedRequest()&&!window.confirm('Discard this unsent building request?'))return;this.clearRequestDraft();this.requestFormOpen=false;this.requestSubmissionId=null;return this.building();}
    if(action==='request-check')return this.checkRequestAvailability(this.buildingRoot.querySelector('#buildingRequestForm'));
  }
  async checkRequestAvailability(form){
    const sequence=this.requestAvailabilitySequence=(this.requestAvailabilitySequence||0)+1;
    const payload=this.collectRequest(form),message=form.querySelector('#buildingRequestMessage'),error=validateBuildingRequest(payload);if(error){message.textContent=error;return false;}
    const key=JSON.stringify(payload.bookings),dates=payload.bookings.map(booking=>booking.date).sort();
    const availability=form.querySelector('#buildingRequestAvailability');availability.textContent='Checking the existing building calendar…';
    let busy=[],warning='';
    try{const result=await this.api(`/api/building/availability?from=${dates[0]}&to=${dates.at(-1)}`);if(!Array.isArray(result.busy))throw Error();busy=result.busy;warning=result.warning||'';}
    catch{warning='Building availability could not be confirmed. This request still requires written Lodge approval.';}
    if(sequence!==this.requestAvailabilitySequence)return false;
    if(busy.some(block=>payload.bookings.some(booking=>booking.date===block.date)&&block.status!=='denied'&&!block.allDay&&(!block.start||!block.end)))warning=[warning,'Some building entries have unconfirmed times. Availability is not confirmed.'].filter(Boolean).join(' ');
    if(JSON.stringify(this.collectRequest(form).bookings)!==key){message.textContent='The requested dates changed. Review availability again.';return false;}
    this.availabilityKey=key;this.availabilityWarning=warning;this.requestConflicts=buildingOverlaps(payload.bookings,busy);
    availability.replaceChildren();
    for(const booking of payload.bookings){const blocks=busy.filter(block=>block.date===booking.date&&block.status!=='denied');const item=document.createElement('p');item.textContent=booking.date+': '+(blocks.length?blocks.map(block=>`${block.label||'Building use'} (${block.status==='pending'?'pending hold':'booked'}, ${block.allDay?'all day':(block.start||'time not provided')+(block.end?' to '+block.end:'')})`).join('; '):'No entries returned for this date.');availability.append(item);}
    if(warning){const item=document.createElement('p');item.className='calendar-warnings';item.textContent=warning;availability.append(item);}
    message.textContent=this.requestConflicts.length?'A requested time overlaps a booking or pending hold. Choose another date or time and review availability again.':'Availability reviewed. Submission is a request, not approval.';
    return this.requestConflicts.length===0;
  }
  async submitRequest(form){
    if(this.requestBusy||!this.can('building.request'))return;
    const message=form.querySelector('#buildingRequestMessage');let payload=this.collectRequest(form);const error=validateBuildingRequest(payload);if(error){message.textContent=error;return;}
    const retry=Boolean(this.pendingRequestPayload);
    if(retry){
      const previous={...this.pendingRequestPayload};delete previous.acknowledgeAvailabilityWarning;
      if(JSON.stringify(previous)!==JSON.stringify(payload)){message.textContent='The previous submission is unconfirmed. Restore its original entries before retrying; a changed request cannot reuse this identifier.';return;}
      payload={...this.pendingRequestPayload};
    }
    this.requestBusy=true;const controls=[...form.querySelectorAll('input,textarea,button')].map(element=>({element,disabled:element.disabled}));controls.forEach(({element})=>element.disabled=true);
    try{
      if(!retry&&!await this.checkRequestAvailability(form))return;
      const warning=this.availabilityWarning?`\n\nAvailability warning: ${this.availabilityWarning} By continuing, you acknowledge that availability is unconfirmed.`:'';
      if(!window.confirm(retry?'Retry the original building request with the same identifier? This checks the earlier submission and does not approve or reserve the property.':`Submit this Lodge building request for ${payload.bookings.length} date${payload.bookings.length===1?'':'s'}? The portal will send request notifications. This is not approval or a confirmed reservation.${warning}`))return;
      if(!retry)payload.acknowledgeAvailabilityWarning=Boolean(this.availabilityWarning);
      this.pendingRequestPayload=structuredClone(payload);
      const result=await this.api('/api/building/requests',{method:'POST',body:JSON.stringify(payload)});if(!result.ok)throw Error('The request could not be confirmed. Your entries remain here for retry.');
      this.requestFormOpen=false;this.requestSubmissionId=null;this.pendingRequestPayload=null;
      this.clearRequestDraft();
      const refs=result.refs?.length?result.refs:[result.ref];
      form.innerHTML=`<h2>Request submitted for review</h2><p>Reference${refs.length===1?'':'s'}: <strong>${refs.map(escape).join(', ')}</strong></p><p>This is not approval. Wait for written Lodge confirmation.</p><p>${result.wmNotified?'Worshipful Master notification recorded.':'Worshipful Master notification has not been confirmed.'}</p><button type="button" class="secondary" data-building="request-new">New Building Request</button>`;
    }catch(error){
      if(error.status>=400&&error.status<500)this.pendingRequestPayload=null;
      message.textContent=this.pendingRequestPayload?'The submission could not be confirmed. Your original entries and request identifier are preserved. Select Submit building request to retry the same request.':error.message||'Submission could not be completed. Your entries are preserved.';
    }
    finally{this.requestBusy=false;controls.forEach(({element,disabled})=>{if(element.isConnected)element.disabled=element.matches?.('input,textarea')?Boolean(this.pendingRequestPayload):disabled;});}
  }
  async decision(button){
    if(button.dataset.building==='refresh')return this.building();
    const request=this.requests?.find(item=>item.id===button.dataset.id);if(!request)return;
    const decision=button.dataset.building;
    if(decision==='attest'){
      if(this.buildingBusy||this.user()?.role!=='secretary')return;
      if(!window.confirm(`Attest the approved Building Use Agreement for ${request.organization} with your saved Secretary signature?`))return;
      this.buildingBusy=true;button.disabled=true;try{await this.api(`/api/building/requests/${encodeURIComponent(request.id)}/attest`,{method:'POST',body:JSON.stringify({revision:request.revision})});await this.building();this.message(this.buildingRoot,'Secretary attestation recorded. The organization was notified and payment access is available.');}catch(error){this.message(this.buildingRoot,error.message||'The attestation could not be recorded.');}finally{this.buildingBusy=false;if(button.isConnected)button.disabled=false;}return;
    }
    if(this.buildingBusy||!this.can('building.decide')||!this.mayDecide)return;
    if(!['approved','denied'].includes(decision))return;
    const note=document.getElementById('building-note-'+request.id).value;
    if(decision==='denied'&&!note.trim()){this.message(this.buildingRoot,'Enter the explanation the organization will receive before declining.');return;}
    let authorization;
    if(decision==='approved'&&request.ownerOnly){authorization={date:document.getElementById('building-auth-date-'+request.id)?.value||'',record:document.getElementById('building-auth-record-'+request.id)?.value||'',fee:document.getElementById('building-auth-fee-'+request.id)?.value||'',insurance:document.getElementById('building-auth-insurance-'+request.id)?.value||'',deposit:document.getElementById('building-auth-deposit-'+request.id)?.value||'',conditions:document.getElementById('building-auth-conditions-'+request.id)?.value||''};if(!authorization.date||!authorization.record.trim()||!authorization.fee.trim()||!authorization.insurance||!authorization.deposit){this.message(this.buildingRoot,'Complete the Lodge authorization, final fee, insurance, and deposit decisions before approval.');return;}}
    if(!window.confirm(`${decision==='approved'?'Approve':'Decline'} ${request.organization} for ${request.date}? The existing building portal will send decision notifications to the requester and officers.`))return;
    this.buildingBusy=true;button.disabled=true;
    try{await this.api(`/api/building/requests/${encodeURIComponent(request.id)}/decision`,{method:'POST',body:JSON.stringify({decision,note,revision:request.revision,authorization})});await this.building();this.message(this.buildingRoot,decision==='approved'&&request.ownerOnly?'Approval and Worshipful Master signature recorded. Secretary attestation is still required.':'Decision recorded. Check the request card for notification status.');}
    catch(error){if(error.status===409){await this.building();this.message(this.buildingRoot,'This request changed before your decision was saved. Review its latest status and decide again.');}else this.message(this.buildingRoot,error.message||'The decision could not be recorded.');}
    finally{this.buildingBusy=false;if(button.isConnected)button.disabled=false;}
  }
  async calendar(){
    if(!this.can('calendar.view')||this.calendarDirty)return;
    this.calendarDirty=false;const sequence=++this.calendarSequence;
    const range=monthBounds(this.month),label=this.month.toLocaleDateString('en-US',{month:'long',year:'numeric'});
    this.calendarRoot.innerHTML=`<div class="content-head"><div><h1>Lodge Calendar</h1><p>Building use and Lodge events. Times are Eastern.</p></div>${this.can('calendar.manage')?'<button class="primary" data-calendar="new" data-calendar-manage>Add event</button>':''}</div><div class="calendar-toolbar"><button class="secondary" data-calendar="previous" aria-label="Previous month">Previous</button><h2>${escape(label)}</h2><button class="secondary" data-calendar="next" aria-label="Next month">Next</button><button class="secondary" data-calendar="mode">${this.calendarMode==='month'?'Agenda view':'Month view'}</button></div><p data-message role="status"></p><div class="calendar-warnings" role="status"></div><div id="lodgeCalendarEvents"></div><div id="calendarEventDetails"></div>`;
    try{const result=await this.api(`/api/lodge-calendar?from=${range.from}&to=${range.to}`);if(sequence!==this.calendarSequence)return;this.events=result.events||[];this.calendarRoot.querySelector('.calendar-warnings').textContent=(result.warnings||[]).join(' ');this.renderEvents(range);}
    catch(error){this.message(this.calendarRoot,error.message||'The calendar could not load.');}
  }
  renderEvents(range){
    const root=this.calendarRoot.querySelector('#lodgeCalendarEvents');
    const card=event=>`<button class="calendar-event" data-calendar="detail" data-id="${escape(event.id)}"><strong>${escape(event.title)}</strong><span>${escape(eventTime(event))}</span><small>${escape(event.category)}${event.status?' · '+escape(event.status):''}</small></button>`;
    if(this.calendarMode==='agenda'){root.innerHTML=this.events.length?`<div class="calendar-agenda">${[...this.events].sort((a,b)=>(a.startDate+(a.startTime||'')).localeCompare(b.startDate+(b.startTime||''))).map(event=>`<article><p>${escape(event.startDate)}${event.endDate&&event.endDate!==event.startDate?' through '+escape(event.endDate):''}</p>${card(event)}</article>`).join('')}</div>`:'<p>No events in this month.</p>';return;}
    const start=new Date(range.from+'T12:00:00'),count=Number(range.to.slice(-2));let cells='';
    for(let empty=0;empty<start.getDay();empty++)cells+='<div class="calendar-empty" aria-hidden="true"></div>';
    for(let day=1;day<=count;day++){const date=range.from.slice(0,8)+String(day).padStart(2,'0');cells+=`<section class="calendar-day" aria-label="${date}"><h3>${day}</h3>${this.events.filter(event=>eventOccurs(event,date)).map(card).join('')}</section>`;}
    root.innerHTML=`<div class="calendar-weekdays" aria-hidden="true">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div>${this.events.length?'':'<p>No events in this month.</p>'}`;
  }
  async calendarAction(button){
    const action=button.dataset.calendar;
    if(this.calendarBusy)return;
    if(this.calendarDirty){if(!window.confirm('Leave your unsaved calendar changes?'))return;this.calendarDirty=false;}
    if(['previous','next','mode'].includes(action)){if(action==='mode')this.calendarMode=this.calendarMode==='month'?'agenda':'month';else this.month=new Date(this.month.getFullYear(),this.month.getMonth()+(action==='next'?1:-1),1);return this.calendar();}
    const event=this.events?.find(item=>item.id===button.dataset.id);
    if(action==='detail'&&event)return this.details(event);
    if(action==='new'&&this.can('calendar.manage'))return this.editEvent();
    if(action==='edit'&&event?.editable&&this.can('calendar.manage'))return this.editEvent(event);
    if(action==='cancel'){this.calendarRoot.querySelector('#calendarEventDetails').replaceChildren();return;}
    if(action==='delete'&&event?.editable&&this.can('calendar.manage')){
      if(!window.confirm(`Delete ${event.title} from the Lodge Calendar?`))return;
      try{await this.api(`/api/lodge-calendar/${encodeURIComponent(event.id)}`,{method:'DELETE',...(event.revision!==undefined?{body:JSON.stringify({revision:event.revision})}:{})});await this.calendar();this.message(this.calendarRoot,'Event deleted.');}catch(error){this.message(this.calendarRoot,error.message);}
    }
  }
  details(event){
    this.calendarRoot.querySelector('#calendarEventDetails').innerHTML=`<section class="panel calendar-details"><h2>${escape(event.title)}</h2><p>${escape(event.startDate)}${event.endDate&&event.endDate!==event.startDate?' through '+escape(event.endDate):''} · ${escape(eventTime(event))}</p><p>${escape(event.location)}</p><p>${escape(event.description)}</p><p>${escape(event.category)} · ${escape(event.status)} · ${escape(event.source)}</p>${this.can('calendar.manage')&&event.editable?`<div class="row-buttons" data-calendar-manage><button class="secondary" data-calendar="edit" data-id="${escape(event.id)}">Edit event</button><button class="secondary" data-calendar="delete" data-id="${escape(event.id)}">Delete event</button></div>`:'<p class="helper">This event is maintained by its source.</p>'}</section>`;
    this.calendarRoot.querySelector('#calendarEventDetails').scrollIntoView({block:'nearest'});
  }
  editEvent(event={}){
    this.calendarDirty=false;this.editingEvent=event;
    const field=(key,label,type='text',required=false)=>`<label>${label}<input name="${key}" type="${type}" value="${escape(event[key]||'')}" ${required?'required':''}></label>`;
    this.calendarRoot.querySelector('#calendarEventDetails').innerHTML=`<form id="calendarEventForm" class="panel calendar-details"><h2>${event.id?'Edit event':'Add event'}</h2>${field('title','Event title','text',true)}<div class="calendar-form-grid">${field('startDate','Start date','date',true)}${field('endDate','End date (inclusive)','date')}${field('startTime','Start time','time')}${field('endTime','End time','time')}</div><label class="calendar-checkbox"><input name="allDay" type="checkbox" ${event.allDay?'checked':''}> All day</label><p class="helper">Leave times blank when they are not known.</p>${field('location','Location')}<label>Category<select name="category">${['lodge','jurisdiction','community'].map(category=>`<option value="${category}" ${(event.category||'lodge')===category?'selected':''}>${category}</option>`).join('')}</select></label><label>Status<select name="status">${['scheduled','tentative','cancelled'].map(status=>`<option value="${status}" ${(event.status||'scheduled')===status?'selected':''}>${status}</option>`).join('')}</select></label><label>Description<textarea name="description" maxlength="6000">${escape(event.description)}</textarea></label><div class="row-buttons"><button class="primary" type="submit">Save event</button><button class="secondary" type="button" data-calendar="cancel">Cancel</button></div><p data-editor-message role="status"></p></form>`;
    this.calendarRoot.querySelector('#calendarEventForm')?.scrollIntoView?.({block:'start'});
  }
  async saveEvent(form){
    if(this.calendarBusy||!this.can('calendar.manage'))return;
    const data=new FormData(form),event={status:this.editingEvent?.status||'scheduled',source:this.editingEvent?.source||'Lodge calendar',sourceUrl:this.editingEvent?.sourceUrl||'',...Object.fromEntries(data)};event.allDay=data.has('allDay');if(!event.endDate)event.endDate=event.startDate;if(event.allDay){event.startTime='';event.endTime='';}
    const message=form.querySelector('[data-editor-message]');
    if(event.endDate<event.startDate){message.textContent='The end date cannot precede the start date.';return;}
    if(!window.confirm(`${this.editingEvent?.id?'Save changes to':'Add'} ${event.title} on the Lodge Calendar?`))return;
    if(this.editingEvent?.revision!==undefined)event.revision=this.editingEvent.revision;
    this.calendarBusy=true;const button=form.querySelector('[type="submit"]');const controls=[...form.querySelectorAll('input, textarea, select, button')].map(element=>({element,disabled:element.disabled}));controls.forEach(({element})=>element.disabled=true);button.disabled=true;
    try{const id=this.editingEvent?.id;await this.api('/api/lodge-calendar'+(id?'/'+encodeURIComponent(id):''),{method:id?'PUT':'POST',body:JSON.stringify(event)});this.calendarDirty=false;await this.calendar();this.message(this.calendarRoot,'Event saved.');}
    catch(error){message.textContent=error.status===409?'This event changed. Your edits remain here; reopen the calendar to review the latest record before saving again.':error.message;}
    finally{this.calendarBusy=false;controls.forEach(({element,disabled})=>{if(element.isConnected)element.disabled=disabled;});if(button.isConnected)button.disabled=false;}
  }
  refreshPermissions(){this.buildingRoot.querySelectorAll('#buildingRequestForm,[data-building="request-new"]').forEach(element=>element.hidden=!this.can('building.request'));const queue=this.buildingRoot.querySelector('.building-requests');if(queue)queue.hidden=!this.can('building.view');this.buildingRoot.querySelectorAll('[data-building-controls]').forEach(element=>element.hidden=!this.can('building.decide'));this.buildingRoot.querySelectorAll('[data-building-attestation]').forEach(element=>element.hidden=this.user()?.role!=='secretary');this.calendarRoot.querySelectorAll('[data-calendar-manage],#calendarEventForm').forEach(element=>element.hidden=!this.can('calendar.manage'));}
}
