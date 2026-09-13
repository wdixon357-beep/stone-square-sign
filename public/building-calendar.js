const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const monthBounds = date => {
  const year=date.getFullYear(), month=date.getMonth(), pad=value=>String(value).padStart(2,'0');
  return {from:`${year}-${pad(month+1)}-01`,to:`${year}-${pad(month+1)}-${pad(new Date(year,month+1,0).getDate())}`};
};
export const eventOccurs = (event, date) => event.startDate <= date && (event.endDate || event.startDate) >= date;
const eventTime = event => event.allDay ? 'All day' : event.startTime ? `${event.startTime}${event.endTime ? ' to '+event.endTime : ''}` : 'Time not provided';
export class BuildingCalendarWorkspace {
  constructor({api,user}) {this.api=api;this.user=user;this.month=new Date();this.calendarMode='month';this.buildingSequence=0;this.calendarSequence=0;this.buildingRoot=document.getElementById('buildingSection');this.calendarRoot=document.getElementById('calendarSection');this.bind();}
  can(key){return this.user()?.role==='owner'||Boolean(this.user()?.permissions?.includes(key));}
  bind(){
    this.calendarRoot.addEventListener('input', event=>{if(event.target.closest('#calendarEventForm'))this.calendarDirty=true;});
    this.buildingRoot.addEventListener('click',event=>{const button=event.target.closest('[data-building]');if(button)this.decision(button);});
    this.calendarRoot.addEventListener('click',event=>{const button=event.target.closest('[data-calendar]');if(button)this.calendarAction(button);});
    this.calendarRoot.addEventListener('submit',event=>{if(event.target.id==='calendarEventForm'){event.preventDefault();void this.saveEvent(event.target);}});
  }
  message(root,text){const element=root.querySelector('[data-message]');if(element)element.textContent=text;}
  async building(){
    if(!this.can('building.view'))return;
    const sequence=++this.buildingSequence;
    this.buildingRoot.innerHTML='<div class="content-head"><div><h1>Building Requests</h1><p>Requests submitted through the existing building portal.</p></div><button class="secondary" data-building="refresh">Refresh</button></div><p data-message role="status"></p><div class="building-requests"></div>';
    try{const result=await this.api('/api/building/requests');if(sequence!==this.buildingSequence)return;this.requests=result.requests;this.mayDecide=result.canDecide;
      this.buildingRoot.querySelector('.building-requests').innerHTML=this.requests.length?this.requests.map(request=>`<article class="panel building-request"><div class="content-head"><div><h2>${escape(request.organization)}</h2><p>${escape(request.date)} · ${escape(request.start||'Time not provided')}${request.end?' to '+escape(request.end):''}</p></div><span class="status">${escape(request.status)}</span></div><p>${escape(request.spaces?.join(', '))}</p><p>${escape(request.description)}</p><p>${escape(request.contactName)}${request.contact?' · '+escape(request.contact):''}</p><p>Reference: ${escape(request.id)}</p>${request.note?`<p>Decision note: ${escape(request.note)}</p>`:''}${request.decidedBy?`<p>Recorded by ${escape(request.decidedBy)}${request.decidedAt?' · '+escape(request.decidedAt):''}</p>`:''}${request.status!=='pending'?`<p>${request.requesterNotified?'Requester notification recorded.':'Requester notification has not been confirmed.'}</p>`:''}${this.can('building.decide')&&result.canDecide?`<div data-building-controls><label for="building-note-${escape(request.id)}">Note to the requester</label><textarea id="building-note-${escape(request.id)}" maxlength="2000">${escape(request.note||'')}</textarea><p class="helper">Approving or declining uses the existing portal and sends its decision notifications to the requester and officers.</p><div class="row-buttons"><button class="primary" data-building="approved" data-id="${escape(request.id)}">Approve</button><button class="secondary" data-building="denied" data-id="${escape(request.id)}">Decline</button></div></div>`:''}</article>`).join(''):'<p>No building requests.</p>';
    }catch(error){this.message(this.buildingRoot,error.message||'Building requests could not load.');}
  }
  async decision(button){
    if(button.dataset.building==='refresh')return this.building();
    if(this.buildingBusy||!this.can('building.decide')||!this.mayDecide)return;
    const request=this.requests?.find(item=>item.id===button.dataset.id);if(!request)return;
    const decision=button.dataset.building;if(!['approved','denied'].includes(decision))return;
    const note=document.getElementById('building-note-'+request.id).value;
    if(!window.confirm(`${decision==='approved'?'Approve':'Decline'} ${request.organization} for ${request.date}? The existing building portal will send decision notifications to the requester and officers.`))return;
    this.buildingBusy=true;button.disabled=true;
    try{await this.api(`/api/building/requests/${encodeURIComponent(request.id)}/decision`,{method:'POST',body:JSON.stringify({decision,note,revision:request.revision})});await this.building();this.message(this.buildingRoot,'Decision recorded. Check the request card for notification status.');}
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
  refreshPermissions(){this.buildingRoot.querySelectorAll('[data-building-controls]').forEach(element=>element.hidden=!this.can('building.decide'));this.calendarRoot.querySelectorAll('[data-calendar-manage],#calendarEventForm').forEach(element=>element.hidden=!this.can('calendar.manage'));}
}
