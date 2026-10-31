'use strict';
/* Forms: daily End of Day Reports (tracked), monthly mileage, incident, expense and supply forms (reviewed by admin).
   Loaded before app.js; everything here runs at call time, so app.js globals (db, ui, esc, …) are available. */

const PLACE = { type: 'place' };
const FORM_TYPES = {
  eod: {
    name: 'End of Day Report', groups: ['provider'], review: 'track',
    desc: 'Daily: patients seen and end-of-day tasks.'
  },
  mileage: {
    name: 'Monthly Mileage Report', groups: ['provider'], review: 'approve', pay: true,
    desc: 'Business miles for the month, due by the 5th of the next month.'
  },
  incident: {
    name: 'Facility Incident Report', groups: [], review: 'ack',
    desc: 'Safety, equipment or facility incidents.',
    fields: [
      { key: 'date', label: 'Date of incident', type: 'date', max: 'today', required: true },
      { key: 'time', label: 'Approximate time', type: 'time' },
      { key: 'facility', label: 'Where did it happen?', ...PLACE, required: true },
      { key: 'type', label: 'Type of incident', type: 'select', required: true,
        options: ['Slip, trip or fall (staff or visitor)', 'Equipment or property damage', 'Safety hazard', 'Staff injury', 'Threat or workplace violence', 'Supply or medication storage issue', 'Other'] },
      { key: 'severity', label: 'Severity', type: 'select', required: true,
        options: ['Low: no harm', 'Moderate: minor harm or damage', 'High: injury, major damage or ongoing risk'] },
      { key: 'what', label: 'What happened?', type: 'textarea', required: true, hint: 'Describe the incident without patient names, room numbers or health details.' },
      { key: 'people', label: 'Staff or visitors involved', type: 'text', hint: 'Names of staff or visitors only.' },
      { key: 'action', label: 'What was done about it?', type: 'textarea', required: true },
      { key: 'contact', label: 'Facility staff notified (name and title)', type: 'text' }
    ]
  },
  expense: {
    name: 'Expense Reimbursement', groups: [], review: 'approve', pay: true,
    desc: 'Work expenses, with photos of receipts.',
    fields: [
      { key: 'date', label: 'Date of expense', type: 'date', max: 'today', required: true },
      { key: 'category', label: 'Category', type: 'select', required: true,
        options: ['Meals', 'Travel, parking and tolls', 'Lodging', 'Supplies', 'CME / conference', 'Licenses and dues', 'Other'] },
      { key: 'vendor', label: 'Vendor or merchant', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'purpose', label: 'Business purpose', type: 'textarea', required: true },
      { key: 'receipts', label: 'Receipt photos', type: 'receipts', hint: 'Take a photo of each receipt or choose images.' }
    ]
  },
  supply: {
    name: 'Supply / Equipment Request', groups: [], review: 'approve',
    desc: 'Request supplies or equipment.',
    fields: [
      { key: 'item', label: 'Item', type: 'text', required: true },
      { key: 'qty', label: 'Quantity', type: 'number', required: true },
      { key: 'facility', label: 'Needed at', ...PLACE, required: true },
      { key: 'urgency', label: 'Urgency', type: 'select', required: true, options: ['Routine', 'Needed this week', 'Urgent'] },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  }
};

const DEFAULT_EOD_TASKS = [
  'All visit notes completed and signed',
  'Orders reviewed and signed',
  "Charges submitted for today's visits",
  'Abnormal labs and results addressed',
  'Follow-ups handed off to facility staff'
];
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/* ---------- lookups ---------- */
const FS = () => db.formSettings;
const canFill = (type, u) => !!u && (!FORM_TYPES[type].groups.length || FORM_TYPES[type].groups.includes(u.group));
const subById = id => db.formSubs.find(s => s.id === id);
const eodFor = (userId, date) => db.formSubs.find(s => s.type === 'eod' && s.userId === userId && s.date === date);
const mileageFor = (userId, period) => db.formSubs.find(s => s.type === 'mileage' && s.userId === userId && s.period === period);
const money = n => (+n || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const monthLabel = p => fmtMonth(p + '-01');
const fmtStamp = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const submittedDay = s => ymd(new Date(s.submittedAt));
const periodText = s => s.type === 'mileage' ? monthLabel(s.period) : fmtDay(s.date);
const lastNote = s => s.history.slice().reverse().find(h => h.note)?.note ?? '';
const round = (n, p) => Math.round(n * 10 ** p) / 10 ** p;

/* ---------- End of Day rules ---------- */
function eodExpected(u, d) {
  const st = FS();
  return d >= st.eodStart && (!u.hired || d >= u.hired) && d <= today() &&
    st.eodDays.includes(parseYmd(d).getDay()) && !approvedOff(u.id, d, d).length;
}

/** Past workdays (newest first) with no End of Day Report. Today isn't missing until it's over. */
function missingEods(u) {
  const out = [];
  for (let d = addDays(today(), -1), n = 0; d >= FS().eodStart && n < 120; d = addDays(d, -1), n++) {
    if (eodExpected(u, d) && !eodFor(u.id, d)) out.push(d);
  }
  return out;
}

const eodLate = s => submittedDay(s) > s.date;
const eodPatients = s => Object.values(s.values.patients ?? {}).reduce((n, x) => n + (+x || 0), 0) + (+s.values.other || 0);
const eodOpenTasks = s => (s.values.tasks ?? []).filter(t => !t.done);
const needsFollowUp = s => s.type === 'eod' && eodOpenTasks(s).length > 0 && !s.resolved;

/* ---------- mileage rules ---------- */
const mileageDue = p => addDays(addMonths(p + '-01', 1), 4);

/** Months whose mileage report is open (from 3 days before month end) and not yet submitted. */
function mileageMonthsDue(u) {
  const out = [];
  for (let m = monthStart(FS().eodStart); m <= monthStart(today()); m = addMonths(m, 1)) {
    const p = m.slice(0, 7);
    if (today() >= addDays(monthEnd(m), -2) && !mileageFor(u.id, p)) out.push(p);
  }
  return out;
}

/* ---------- status ---------- */
function statusInfo(s) {
  if (s.type === 'eod') {
    if (needsFollowUp(s)) return { label: 'Follow-up needed', cls: 'warn' };
    return { label: s.resolved ? 'Followed up' : 'Submitted', cls: 'ok' };
  }
  return {
    submitted: { label: 'Awaiting review', cls: 'warn' }, returned: { label: 'Returned', cls: 'bad' },
    approved: { label: 'Approved', cls: 'ok' }, reviewed: { label: 'Reviewed', cls: 'ok' },
    denied: { label: 'Denied', cls: 'bad' }, paid: { label: 'Paid', cls: 'ok' }
  }[s.status];
}

/** Bucket used by the admin status filter. */
function statusGroup(s) {
  if (s.type === 'eod') return needsFollowUp(s) ? 'review' : 'closed';
  return { submitted: 'review', returned: 'returned', denied: 'denied' }[s.status] ?? 'closed';
}

const editable = s => s.type === 'eod' ? !s.resolved : ['submitted', 'returned'].includes(s.status);

function summary(s) {
  const v = s.values;
  switch (s.type) {
    case 'eod': {
      const open = eodOpenTasks(s).length;
      return `${eodPatients(s)} patients · ${open ? `${open} task${open > 1 ? 's' : ''} not done` : 'all tasks done'}`;
    }
    case 'mileage': return v.none ? 'No business mileage' : `${v.totalMiles} miles · ${money(v.amount)}`;
    case 'incident': return `${v.type} · ${v.facility}`;
    case 'expense': return `${money(v.amount)} · ${v.category} · ${v.vendor}`;
    case 'supply': return `${v.qty} × ${v.item} · ${v.urgency}`;
  }
  return '';
}

function subRow(s, showUser) {
  const si = statusInfo(s);
  return `<div class="shift"><div><strong>${FORM_TYPES[s.type].name}</strong> · ${periodText(s)}${showUser ? ` · ${esc(userName(s.userId))}` : ''}<br>
    <span class="small">${esc(summary(s))}</span></div>
    <div class="row"><span class="badge ${si.cls}">${si.label}</span><button data-act="view-sub" data-id="${s.id}">View</button></div></div>`;
}

/* ---------- what's due ---------- */
function dueItems(u) {
  const items = [];
  if (canFill('eod', u)) {
    if (eodExpected(u, today()) && !eodFor(u.id, today())) {
      items.push({ cls: 'warn', text: 'End of Day Report for today', btn: `<button class="primary" data-act="fill-form" data-type="eod" data-date="${today()}">Start</button>` });
    }
    const missing = missingEods(u);
    missing.slice(0, 5).forEach(d => items.push({ cls: 'bad', text: `End of Day Report missing for ${fmtDay(d)}`,
      btn: `<button data-act="fill-form" data-type="eod" data-date="${d}">Submit</button>` }));
    if (missing.length > 5) items.push({ cls: 'bad', text: `…and ${missing.length - 5} more missing End of Day Reports`, btn: '' });
  }
  if (canFill('mileage', u)) {
    mileageMonthsDue(u).forEach(p => items.push({ cls: today() > mileageDue(p) ? 'bad' : 'warn',
      text: `Mileage report for ${monthLabel(p)} · due ${fmtDay(mileageDue(p))}`,
      btn: `<button data-act="fill-form" data-type="mileage" data-period="${p}">Start</button>` }));
  }
  db.formSubs.filter(s => s.userId === u.id && s.status === 'returned').forEach(s => items.push({ cls: 'bad',
    text: `${FORM_TYPES[s.type].name} (${periodText(s)}) was returned: "${esc(lastNote(s))}"`,
    btn: `<button class="primary" data-act="edit-sub" data-id="${s.id}">Fix</button>` }));
  return items;
}

function formsDueCard(u) {
  const items = dueItems(u);
  const recurring = canFill('eod', u) || canFill('mileage', u);
  if (!items.length && !recurring) return '';
  return `<div class="card"><div class="row between"><h2>Forms due</h2>${ui.tab === 'forms' ? '' : '<button class="link" data-act="tab" data-id="forms">All forms</button>'}</div>
    ${items.length ? items.map(i => `<div class="shift"><div><span class="badge ${i.cls}">${i.cls === 'bad' ? 'Overdue' : 'Due'}</span> <span class="small">${i.text}</span></div>${i.btn}</div>`).join('')
      : '<p class="muted">You\'re all caught up. ✅</p>'}</div>`;
}

/* ---------- views ---------- */
function viewForms() {
  return isAdmin() ? viewFormsAdmin() : viewFormsStaff();
}

function newFormCard(u) {
  const fillable = Object.keys(FORM_TYPES).filter(t => canFill(t, u));
  return `<div class="card"><h2>Start a form</h2>
    ${fillable.map(t => `<div class="shift"><div><strong>${FORM_TYPES[t].name}</strong><br><span class="small muted">${FORM_TYPES[t].desc}</span></div>
      <button data-act="fill-form" data-type="${t}">Start</button></div>`).join('')}</div>`;
}

function viewFormsStaff() {
  const u = me();
  const mine = db.formSubs.filter(s => s.userId === u.id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 30);
  return `<h1>Forms</h1>
    ${formsDueCard(u)}
    ${newFormCard(u)}
    <div class="card"><h2>My submissions</h2>${mine.length ? mine.map(s => subRow(s, false)).join('') : '<p class="muted">Nothing submitted yet.</p>'}</div>
    ${checklistsCard()}`;
}

function viewFormsAdmin() {
  const review = db.formSubs.filter(s => statusGroup(s) === 'review').sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const toPay = db.formSubs.filter(s => FORM_TYPES[s.type].pay && s.status === 'approved');
  const mine = db.formSubs.filter(s => s.userId === ui.userId);
  return `<div class="row between" style="margin-bottom:12px"><h1 style="margin:0">Forms</h1>
      <button data-act="form-settings">EOD &amp; mileage settings</button></div>
    <div class="card"><h2>Needs review (${review.length})</h2>
      ${review.length ? review.map(s => subRow(s, true)).join('') : '<p class="muted">Nothing waiting. ✅</p>'}</div>
    ${toPay.length ? `<div class="card"><div class="row between"><h2>Approved, awaiting payment</h2>
        <span class="badge">${money(toPay.reduce((n, s) => n + (+s.values.amount || 0), 0))}</span></div>
      ${toPay.map(s => subRow(s, true)).join('')}</div>` : ''}
    ${eodTracker()}
    ${allSubmissions()}
    ${newFormCard(me())}
    ${mine.length ? `<div class="card"><h2>My submissions</h2>${mine.map(s => subRow(s, false)).join('')}</div>` : ''}
    ${checklistsCard()}`;
}

function eodTracker() {
  const days = [...Array(7)].map((_, i) => addDays(ui.formWeek, i));
  const provs = db.staff.filter(u => canFill('eod', u)).sort((a, b) => a.name.localeCompare(b.name));
  const cell = (u, d) => {
    const s = eodFor(u.id, d);
    if (s) {
      const open = needsFollowUp(s);
      return `<td><button class="cell ${open ? 'warn' : 'ok'}" data-act="view-sub" data-id="${s.id}">✓ ${eodPatients(s)} pts${eodLate(s) ? ' · late' : ''}${open ? ' · follow-up' : ''}</button></td>`;
    }
    if (d > today() || d < FS().eodStart) return '<td class="na"></td>';
    if (approvedOff(u.id, d, d).length) return '<td class="na">Off</td>';
    if (!eodExpected(u, d)) return '<td class="na">—</td>';
    if (d === today()) return '<td><span class="cell-text warn">Due today</span></td>';
    return '<td><span class="cell-text bad">Missing</span></td>';
  };
  const totals = u => {
    const past = days.filter(d => d < today() && eodExpected(u, d));
    const subs = days.map(d => eodFor(u.id, d)).filter(Boolean);
    const missing = past.filter(d => !eodFor(u.id, d)).length;
    return `<td class="small">${subs.length}/${past.length + (eodExpected(u, today()) && days.includes(today()) ? 1 : 0)} filed${missing ? ` · <span class="badge bad">${missing} missing</span>` : ''}<br>
      ${subs.reduce((n, s) => n + eodPatients(s), 0)} patients${subs.filter(eodLate).length ? ` · ${subs.filter(eodLate).length} late` : ''}</td>`;
  };
  return `<div class="card"><div class="row between"><h2 style="margin:0">End of Day tracker</h2>
      <div class="row"><button data-act="form-week" data-d="-7" aria-label="Previous week">‹</button>
      <strong class="small">${fmtDay(days[0])} to ${fmtDay(days[6])}</strong>
      <button data-act="form-week" data-d="7" aria-label="Next week">›</button></div></div>
    <div class="scroll-x" style="margin-top:10px"><table class="matrix"><thead><tr><th class="name">Provider</th>
      ${days.map(d => `<th>${parseYmd(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</th>`).join('')}<th>Week</th></tr></thead>
      <tbody>${provs.map(u => `<tr><th class="name" scope="row">${esc(u.name)}</th>${days.map(d => cell(u, d)).join('')}${totals(u)}</tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin:.6rem 0 0">Reports are expected on ${WEEKDAYS.filter(([n]) => FS().eodDays.includes(n)).map(x => x[1]).join(', ')}, except approved time off. Late means filed after the report date.</p></div>`;
}

function filteredSubs() {
  const f = ui.formFilter;
  return db.formSubs.filter(s => (!f.type || s.type === f.type) && (!f.user || s.userId === f.user) && (!f.status || statusGroup(s) === f.status))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

function allSubmissions() {
  const f = ui.formFilter;
  const list = filteredSubs();
  const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  return `<div class="card"><div class="row between"><h2 style="margin:0">All submissions</h2><button data-act="export-forms">Export CSV</button></div>
    <div class="row" style="margin:10px 0">
      <select id="ff-type" aria-label="Form type" style="width:auto">${opt('', 'All forms', f.type)}${Object.entries(FORM_TYPES).map(([k, t]) => opt(k, t.name, f.type)).join('')}</select>
      <select id="ff-status" aria-label="Status" style="width:auto">${opt('', 'Any status', f.status)}${opt('review', 'Needs review', f.status)}${opt('returned', 'Returned', f.status)}${opt('closed', 'Approved, reviewed or paid', f.status)}${opt('denied', 'Denied', f.status)}</select>
      <select id="ff-user" aria-label="Person" style="width:auto">${opt('', 'Everyone', f.user)}${db.staff.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => opt(u.id, u.name, f.user)).join('')}</select>
    </div>
    ${list.length ? list.slice(0, 50).map(s => subRow(s, true)).join('') + (list.length > 50 ? `<p class="small muted">Showing the 50 most recent of ${list.length}. Export CSV for all.</p>` : '')
      : '<p class="muted">No submissions match.</p>'}</div>`;
}

/* ---------- filling a form ---------- */
function startForm(type, { id, date, period } = {}) {
  const sub = id ? subById(id) : null;
  const u = me();
  let d = date;
  if (!d && type === 'eod') d = eodExpected(u, today()) && !eodFor(u.id, today()) ? today() : (missingEods(u)[0] ?? today());
  ui.form = {
    type, id: sub?.id ?? null, dirty: false,
    date: sub?.date ?? d ?? today(),
    period: sub?.period ?? period ?? mileageMonthsDue(u)[0] ?? today().slice(0, 7),
    receipts: [...(sub?.values.receipts ?? [])]
  };
  ui.resetScroll = true;
}

function fieldInput(f, val) {
  const id = 'ff-' + f.key;
  const req = f.required ? 'required' : '';
  const options = f.type === 'place' ? [...db.snfs.map(s => s.name), 'Office', 'Other'] : f.options;
  let input;
  switch (f.type) {
    case 'textarea': input = `<textarea id="${id}" name="${f.key}" ${req}>${esc(val)}</textarea>`; break;
    case 'select':
    case 'place':
      input = `<select id="${id}" name="${f.key}" ${req}><option value="">Choose…</option>${options.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      break;
    case 'money': input = `<input id="${id}" name="${f.key}" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(val)}" ${req}>`; break;
    case 'number': input = `<input id="${id}" name="${f.key}" type="number" min="1" step="1" inputmode="numeric" value="${esc(val)}" ${req}>`; break;
    case 'receipts':
      input = `<input id="${id}" type="file" accept="image/*" multiple data-receipts>
        <div id="receipt-previews" class="receipts">${receiptPreviews()}</div>`;
      break;
    default:
      input = `<input id="${id}" name="${f.key}" type="${f.type}" value="${esc(val ?? (f.type === 'date' ? today() : ''))}" ${f.max === 'today' ? `max="${today()}"` : ''} ${req}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? '' : ' <span class="muted">(optional)</span>'}</label>
    ${f.hint ? `<p class="small muted hint">${esc(f.hint)}</p>` : ''}${input}</div>`;
}

function receiptPreviews() {
  return ui.form.receipts.map((r, i) => `<div class="receipt"><img src="${esc(r)}" alt="Receipt ${i + 1}">
    <button type="button" class="link" data-act="remove-receipt" data-i="${i}">Remove</button></div>`).join('');
}

function eodFields(v) {
  const snfs = snfsOf(ui.userId);
  const tasks = v.tasks ?? FS().eodTasks.map(label => ({ label, done: false, note: '' }));
  return `
    <div class="field"><label for="ff-date">Report date</label><input id="ff-date" type="date" name="date" value="${ui.form.date}" max="${today()}" required></div>
    <h3>Patients seen</h3>
    <div class="grid2">
      ${snfs.map(s => `<div class="field"><label for="pt-${s.id}">${esc(s.name)}</label>
        <input id="pt-${s.id}" type="number" min="0" step="1" inputmode="numeric" name="pt_${s.id}" value="${v.patients?.[s.id] ?? ''}" required></div>`).join('')}
      <div class="field"><label for="pt-other">Other locations <span class="muted">(optional)</span></label>
        <input id="pt-other" type="number" min="0" step="1" inputmode="numeric" name="pt_other" value="${v.other || ''}" placeholder="0"></div>
    </div>
    <h3>End-of-day tasks</h3>
    <p class="small muted">Check each task you finished. For anything not done, say what's left and when it will be done.</p>
    ${tasks.map((t, i) => `<div class="task">
      <div class="check"><input type="checkbox" id="tk${i}" name="tk${i}" ${t.done ? 'checked' : ''}><label for="tk${i}">${esc(t.label)}</label></div>
      <input type="hidden" name="tl${i}" value="${esc(t.label)}">
      <div class="task-note"><label for="tn${i}">What's left, and when will it be done?</label><input id="tn${i}" name="tn${i}" value="${esc(t.note)}"></div>
    </div>`).join('')}
    <input type="hidden" name="tcount" value="${tasks.length}">
    <div class="field" style="margin-top:1rem"><label for="ff-notes">Anything the office should know? <span class="muted">(optional)</span></label>
      <textarea id="ff-notes" name="notes">${esc(v.notes)}</textarea></div>`;
}

function tripRow(t = {}) {
  return `<tr>
    <td><input type="date" name="t_date" value="${esc(t.date)}" aria-label="Trip date"></td>
    <td><input name="t_from" value="${esc(t.from)}" aria-label="From"></td>
    <td><input name="t_to" value="${esc(t.to)}" aria-label="To"></td>
    <td><input name="t_purpose" value="${esc(t.purpose)}" aria-label="Purpose or facility"></td>
    <td><input type="number" name="t_miles" min="0" step="0.1" inputmode="decimal" value="${esc(t.miles)}" aria-label="Miles"></td>
    <td><button type="button" class="link" data-act="remove-trip" aria-label="Remove trip">✕</button></td></tr>`;
}

function mileageTotalText(miles) {
  return `Total: <strong>${round(miles, 1)} miles</strong> × ${money(FS().mileageRate)} = <strong>${money(round(miles * FS().mileageRate, 2))}</strong>`;
}

function updateMileTotal() {
  const el = $('.mile-total');
  if (el) el.innerHTML = mileageTotalText([...document.querySelectorAll('[name=t_miles]')].reduce((n, i) => n + (+i.value || 0), 0));
}

function mileageFields(v) {
  const trips = v.trips?.length ? v.trips : [{}, {}, {}];
  return `
    <div class="field"><label for="ff-month">Month</label><input id="ff-month" type="month" name="period" value="${ui.form.period}" max="${today().slice(0, 7)}" required></div>
    <div class="check"><input type="checkbox" id="ff-none" name="none" ${v.none ? 'checked' : ''}><label for="ff-none">I had no business mileage this month</label></div>
    <div class="trips">
      <p class="small muted" style="margin-top:.6rem">List each work trip. Don't include your normal commute.</p>
      <div class="scroll-x"><table class="plain trips-table">
        <thead><tr><th>Date</th><th>From</th><th>To</th><th>Purpose / facility</th><th>Miles</th><th></th></tr></thead>
        <tbody id="trip-rows">${trips.map(tripRow).join('')}</tbody></table></div>
      <button type="button" data-act="add-trip" style="margin-top:.6rem">+ Add trip</button>
      <p class="mile-total" style="margin:.8rem 0 0">${mileageTotalText(trips.reduce((n, t) => n + (+t.miles || 0), 0))}</p>
    </div>
    <p class="small muted" style="margin-top:.6rem">Reimbursed at ${money(FS().mileageRate)} per mile, set by the office.</p>`;
}

function viewFormFill() {
  const f = ui.form;
  const t = FORM_TYPES[f.type];
  const sub = f.id ? subById(f.id) : null;
  const v = sub?.values ?? {};
  const body = f.type === 'eod' ? eodFields(v) : f.type === 'mileage' ? mileageFields(v) : t.fields.map(x => fieldInput(x, v[x.key])).join('');
  const si = sub && statusInfo(sub);
  return `<div class="player">
    <div class="row between player-head"><button data-act="exit-form">‹ Back</button>${si ? `<span class="badge ${si.cls}">${si.label}</span>` : ''}</div>
    <h1>${sub ? 'Edit: ' : ''}${t.name}</h1>
    ${sub?.status === 'returned' ? `<div class="banner"><strong>Returned by the office:</strong> ${esc(lastNote(sub))}</div>` : ''}
    <div class="banner"><strong>No patient information.</strong> No names, room numbers, dates of birth or health details.</div>
    <form id="form-fill" class="card">
      ${body}
      <div class="row between" style="margin-top:1rem"><button type="button" data-act="exit-form">Cancel</button>
        <button class="primary" type="submit">${sub ? (sub.status === 'returned' ? 'Resubmit' : 'Save changes') : 'Submit'}</button></div>
    </form></div>`;
}

/* Each collector validates and returns { date, period?, values }, or null after telling the user what to fix. */
const collectors = {
  eod(fd, existing) {
    const date = fd.get('date');
    const dup = eodFor(ui.userId, date);
    if (dup && dup.id !== existing?.id) { alert(`You already filed an End of Day Report for ${fmtDay(date)}. Open it from My submissions to make changes.`); return null; }
    const tasks = [...Array(+fd.get('tcount'))].map((_, i) => ({ label: fd.get('tl' + i), done: fd.get('tk' + i) === 'on', note: String(fd.get('tn' + i) || '').trim() }));
    const noNote = tasks.filter(t => !t.done && !t.note);
    if (noNote.length) { alert(`Add a note for each unfinished task:\n• ${noNote.map(t => t.label).join('\n• ')}`); return null; }
    return {
      date,
      values: {
        patients: Object.fromEntries(snfsOf(ui.userId).map(s => [s.id, +fd.get('pt_' + s.id) || 0])),
        other: +fd.get('pt_other') || 0, tasks, notes: String(fd.get('notes') || '').trim()
      }
    };
  },
  mileage(fd, existing) {
    const period = fd.get('period');
    const dup = mileageFor(ui.userId, period);
    if (dup && dup.id !== existing?.id) { alert(`You already filed a mileage report for ${monthLabel(period)}. Open it from My submissions to make changes.`); return null; }
    const none = fd.get('none') === 'on';
    const col = k => fd.getAll('t_' + k).map(x => String(x).trim());
    const [dates, from, to, purpose, miles] = ['date', 'from', 'to', 'purpose', 'miles'].map(col);
    const trips = dates.map((_, i) => ({ date: dates[i], from: from[i], to: to[i], purpose: purpose[i], miles: miles[i] }))
      .filter(t => t.date || t.from || t.to || t.purpose || t.miles);
    if (!none) {
      if (!trips.length) { alert('Add at least one trip, or check "I had no business mileage this month."'); return null; }
      if (trips.some(t => !t.date || !(+t.miles > 0) || !t.date.startsWith(period))) {
        alert(`Each trip needs a date in ${monthLabel(period)} and miles greater than 0.`); return null;
      }
    }
    const totalMiles = none ? 0 : round(trips.reduce((n, t) => n + +t.miles, 0), 1);
    const rate = FS().mileageRate;
    return { date: period + '-01', period, values: { none, trips: none ? [] : trips.map(t => ({ ...t, miles: +t.miles })), totalMiles, rate, amount: round(totalMiles * rate, 2) } };
  }
};

function collectGeneric(type, fd) {
  const values = {};
  FORM_TYPES[type].fields.forEach(f => {
    values[f.key] = f.type === 'receipts' ? ui.form.receipts.slice()
      : f.type === 'money' || f.type === 'number' ? +fd.get(f.key) : String(fd.get(f.key) || '').trim();
  });
  if (type === 'expense' && !values.receipts.length && !confirm('No receipt photo is attached. Submit anyway?')) return null;
  return { date: values.date || today(), values };
}

document.addEventListener('submit', e => {
  if (e.target.id !== 'form-fill') return;
  e.preventDefault();
  const f = ui.form;
  const fd = new FormData(e.target);
  const existing = f.id ? subById(f.id) : null;
  const res = collectors[f.type] ? collectors[f.type](fd, existing) : collectGeneric(f.type, fd);
  if (!res) return;
  const now = new Date().toISOString();
  if (existing) {
    const resubmit = existing.status === 'returned';
    Object.assign(existing, res, { updatedAt: now }, resubmit ? { status: 'submitted' } : {});
    existing.history.push({ at: now, by: ui.userId, action: resubmit ? 'Resubmitted' : 'Edited' });
  } else {
    db.formSubs.push({ id: uid(), type: f.type, userId: ui.userId, ...res, status: 'submitted', submittedAt: now, history: [{ at: now, by: ui.userId, action: 'Submitted' }] });
  }
  save();
  ui.form = null;
  ui.resetScroll = true;
  toast(existing ? 'Changes saved' : `${FORM_TYPES[f.type].name} submitted`);
  render();
});

document.addEventListener('input', e => {
  if (!ui.form || !e.target.closest('#form-fill')) return;
  ui.form.dirty = true;
  if (e.target.name === 't_miles') updateMileTotal();
});

/** Phone photos are large; shrink receipts to ~1400px JPEGs before storing them. */
async function compressImage(file, max = 1400) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

document.addEventListener('change', async e => {
  if (e.target.matches('[data-receipts]')) {
    for (const file of e.target.files) {
      try { ui.form.receipts.push(await compressImage(file)); } catch { toast(`Couldn't read ${file.name}. Try a JPEG or PNG photo.`); }
    }
    e.target.value = '';
    ui.form.dirty = true;
    $('#receipt-previews').innerHTML = receiptPreviews();
    return;
  }
  const filter = { 'ff-type': 'type', 'ff-status': 'status', 'ff-user': 'user' }[e.target.id];
  if (filter) { ui.formFilter[filter] = e.target.value; render(); }
});

/* ---------- viewing & reviewing ---------- */
function valuesHtml(s) {
  const v = s.values;
  if (s.type === 'eod') {
    const rows = Object.entries(v.patients ?? {}).map(([id, n]) => `<tr><td>${esc(snfName(id))}</td><td class="num">${n}</td></tr>`).join('')
      + (v.other ? `<tr><td>Other locations</td><td class="num">${v.other}</td></tr>` : '');
    return `<h3>Patients seen: ${eodPatients(s)}</h3>${rows ? `<table class="plain">${rows}</table>` : ''}
      <h3 style="margin-top:1rem">Tasks</h3>
      ${v.tasks.map(t => `<p class="small" style="margin:0 0 .4rem">${t.done ? '✅' : '⚠️'} ${esc(t.label)}${t.done ? '' : `<br><span class="muted">${esc(t.note)}</span>`}</p>`).join('')}
      ${v.notes ? `<h3 style="margin-top:1rem">Notes</h3><p>${esc(v.notes)}</p>` : ''}`;
  }
  if (s.type === 'mileage') {
    if (v.none) return '<p>No business mileage this month.</p>';
    return `<div class="scroll-x"><table class="plain"><thead><tr><th>Date</th><th>From</th><th>To</th><th>Purpose</th><th class="num">Miles</th></tr></thead>
      <tbody>${v.trips.map(t => `<tr><td>${fmtDay(t.date)}</td><td>${esc(t.from)}</td><td>${esc(t.to)}</td><td>${esc(t.purpose)}</td><td class="num">${t.miles}</td></tr>`).join('')}</tbody></table></div>
      <p style="margin-top:.6rem">${v.totalMiles} miles × ${money(v.rate)} = <strong>${money(v.amount)}</strong></p>`;
  }
  return FORM_TYPES[s.type].fields.map(f => {
    if (f.type === 'receipts') {
      return `<div class="field"><label>${f.label}</label>${v.receipts?.length
        ? `<div class="receipts">${v.receipts.map((r, i) => `<img src="${esc(r)}" alt="Receipt ${i + 1}">`).join('')}</div>`
        : '<span class="badge warn">No receipt attached</span>'}</div>`;
    }
    const raw = v[f.key];
    if (raw === '' || raw == null) return '';
    const val = f.type === 'money' ? money(raw) : f.type === 'date' ? fmtDay(raw) : raw;
    return `<div class="field"><label>${esc(f.label)}</label><div style="white-space:pre-wrap">${esc(val)}</div></div>`;
  }).join('');
}

function reviewActions(s) {
  const t = FORM_TYPES[s.type];
  const set = status => () => { s.status = status; };
  if (s.type === 'eod') {
    return needsFollowUp(s) ? [{ v: 'resolve', label: 'Mark followed up', cls: 'primary', done: 'Marked followed up', run: () => { s.resolved = true; } }] : [];
  }
  if (s.status === 'submitted' && t.review === 'ack') {
    return [
      { v: 'return', label: 'Ask for more info', needsNote: true, done: 'Returned for more information', run: set('returned') },
      { v: 'reviewed', label: 'Mark reviewed', cls: 'primary', done: 'Reviewed', run: set('reviewed') }
    ];
  }
  if (s.status === 'submitted') {
    return [
      { v: 'deny', label: 'Deny', cls: 'danger', needsNote: true, done: 'Denied', run: set('denied') },
      { v: 'return', label: 'Return', needsNote: true, done: 'Returned for changes', run: set('returned') },
      { v: 'approve', label: 'Approve', cls: 'primary', done: 'Approved', run: set('approved') }
    ];
  }
  if (s.status === 'approved' && t.pay) return [{ v: 'paid', label: 'Mark paid', cls: 'primary', done: 'Marked paid', run: set('paid') }];
  return [];
}

function subDialog(s) {
  const si = statusInfo(s);
  const acts = isAdmin() ? reviewActions(s) : [];
  const canEdit = s.userId === ui.userId && editable(s);
  const late = s.type === 'eod' ? eodLate(s) : s.type === 'mileage' && submittedDay(s) > mileageDue(s.period);
  const body = `<p><strong>${esc(userName(s.userId))}</strong> · ${periodText(s)}<br>
      <span class="badge ${si.cls}">${si.label}</span> <span class="small muted">Submitted ${fmtStamp(s.submittedAt)}${late ? ' · <strong>late</strong>' : ''}</span></p>
    ${valuesHtml(s)}
    <h3 style="margin-top:1rem">History</h3>
    ${s.history.map(h => `<p class="small" style="margin:0 0 .3rem">${fmtStamp(h.at)} · ${esc(userName(h.by))}: ${esc(h.action)}${h.note ? ` · "${esc(h.note)}"` : ''}</p>`).join('')}
    ${acts.length ? `<div class="field" style="margin-top:1rem"><label for="rv-note">Note${acts.some(a => a.needsNote) ? ' (required to return or deny)' : ' (optional)'}</label>
      <textarea id="rv-note" name="note"></textarea></div>` : ''}`;
  openDialog(FORM_TYPES[s.type].name, body, {
    wide: true,
    extra: acts.map(a => `<button value="${a.v}" formnovalidate class="${a.cls ?? ''}">${a.label}</button>`).join('')
      + (canEdit ? `<button value="edit" formnovalidate class="primary">${s.status === 'returned' ? 'Fix and resubmit' : 'Edit'}</button>` : ''),
    onClose: (rv, fd) => {
      if (rv === 'edit') { startForm(s.type, { id: s.id }); return; }
      const a = acts.find(x => x.v === rv);
      if (!a) return;
      const note = String(fd.get('note') || '').trim();
      if (a.needsNote && !note) { toast('Add a note so they know what to change'); setTimeout(() => subDialog(s)); return; }
      a.run();
      s.history.push({ at: new Date().toISOString(), by: ui.userId, action: a.done, note });
      save(); toast(a.done);
    }
  });
}

/* ---------- settings & export ---------- */
function formSettingsDialog() {
  const st = FS();
  openDialog('EOD & mileage settings', `
    <fieldset><legend>End of Day Report required on</legend><div class="row">
      ${WEEKDAYS.map(([n, label]) => `<label class="day-pick"><input type="checkbox" name="day" value="${n}" ${st.eodDays.includes(n) ? 'checked' : ''}> ${label}</label>`).join('')}
    </div></fieldset>
    <div class="field"><label for="st-start">Track End of Day Reports starting</label><input id="st-start" type="date" name="start" value="${st.eodStart}" required></div>
    <div class="field"><label for="st-tasks">End-of-day tasks (one per line)</label>
      <p class="small muted hint">Providers check each one off. Changes apply to new reports.</p>
      <textarea id="st-tasks" name="tasks" class="code" style="min-height:150px" required>${esc(st.eodTasks.join('\n'))}</textarea></div>
    <div class="field"><label for="st-rate">Mileage rate (dollars per mile)</label><input id="st-rate" type="number" name="rate" min="0" step="0.005" value="${st.mileageRate}" required></div>`, {
    onSubmit: fd => {
      const tasks = String(fd.get('tasks')).split('\n').map(x => x.trim()).filter(Boolean);
      if (!tasks.length) { alert('Add at least one end-of-day task.'); return false; }
      Object.assign(st, { eodDays: fd.getAll('day').map(Number), eodStart: fd.get('start'), eodTasks: tasks, mileageRate: +fd.get('rate') });
      save(); toast('Settings saved');
    }
  });
}

function exportForms(list) {
  const lines = [['Form', 'Person', 'Group', 'Date or month', 'Status', 'Submitted', 'Late', 'Amount', 'Patients', 'Summary']];
  list.forEach(s => {
    const u = userOf(s.userId);
    const late = s.type === 'eod' ? eodLate(s) : s.type === 'mileage' && submittedDay(s) > mileageDue(s.period);
    lines.push([FORM_TYPES[s.type].name, u?.name, GROUPS[u?.group] ?? '', s.period ?? s.date, statusInfo(s).label, fmtStamp(s.submittedAt),
      late ? 'yes' : '', s.values.amount != null ? round(+s.values.amount, 2) : '', s.type === 'eod' ? eodPatients(s) : '', summary(s)]);
  });
  const csv = lines.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `forms-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- actions ---------- */
const formActions = {
  'fill-form': b => startForm(b.dataset.type, { date: b.dataset.date, period: b.dataset.period }),
  'edit-sub': b => startForm(subById(b.dataset.id).type, { id: b.dataset.id }),
  'exit-form': () => {
    if (ui.form.dirty && !confirm('Discard what you entered?')) return false;
    ui.form = null; ui.resetScroll = true;
  },
  'view-sub': b => { subDialog(subById(b.dataset.id)); return false; },
  'add-trip': () => { $('#trip-rows').insertAdjacentHTML('beforeend', tripRow()); return false; },
  'remove-trip': b => {
    const row = b.closest('tr');
    if (row.parentElement.children.length > 1) row.remove(); else row.querySelectorAll('input').forEach(i => { i.value = ''; });
    updateMileTotal();
    return false;
  },
  'remove-receipt': b => { ui.form.receipts.splice(+b.dataset.i, 1); $('#receipt-previews').innerHTML = receiptPreviews(); return false; },
  'form-week': b => { ui.formWeek = addDays(ui.formWeek, +b.dataset.d); },
  'form-settings': () => { formSettingsDialog(); return false; },
  'export-forms': () => { exportForms(filteredSubs()); return false; }
};

/* ---------- sample data ---------- */
function seedForms(staff, snfs) {
  const t = today();
  const start = addDays(t, -13);
  const at = (d, h, m = 0) => { const x = parseYmd(d); x.setHours(h, m); return x.toISOString(); };
  const snfsFor = id => snfs.filter(s => s.staff.includes(id));
  const providers = staff.filter(u => u.group === 'provider');
  const skip = { u2: [addDays(t, -4)], u3: [addDays(t, -2), addDays(t, -1)] };
  const lateDay = { u4: addDays(t, -9) };
  const openTask = { u1: addDays(t, -3) };
  const subs = [];
  const add = (type, userId, fields, submittedAt, status = 'submitted', extraHistory = []) => subs.push({
    id: uid(), type, userId, status, submittedAt, ...fields,
    history: [{ at: submittedAt, by: userId, action: 'Submitted' }, ...extraHistory]
  });

  let i = 0;
  for (let d = start; d < t; d = addDays(d, 1), i++) {
    if (![1, 2, 3, 4, 5].includes(parseYmd(d).getDay())) continue;
    providers.forEach((u, p) => {
      if (skip[u.id]?.includes(d)) return;
      const patients = Object.fromEntries(snfsFor(u.id).map((s, k) => [s.id, 4 + ((i * 7 + p * 3 + k * 5) % 9)]));
      const tasks = DEFAULT_EOD_TASKS.map(label => ({ label, done: true, note: '' }));
      if (openTask[u.id] === d) Object.assign(tasks[2], { done: false, note: 'Two Bayshore visits still need charges entered; finishing tomorrow morning.' });
      const when = lateDay[u.id] === d ? at(addDays(d, 1), 8, 15) : at(d, 17 + (p % 2), 10 + p * 7);
      add('eod', u.id, { date: d, values: { patients, other: 0, tasks, notes: '' } }, when);
    });
  }

  const month = t.slice(0, 7);
  const prev = addMonths(monthStart(t), -1).slice(0, 7);
  const trip = (d, from, to, purpose, miles) => ({ date: d, from, to, purpose, miles });
  const reyesTrips = [
    trip(`${month}-06`, 'FPP office', 'Lakeview Nursing & Rehab', 'Rounds', 18.4),
    trip(`${month}-13`, 'Lakeview Nursing & Rehab', 'Bayshore Health & Rehab', 'Rounds', 42.0),
    trip(`${month}-20`, 'FPP office', 'Bayshore Health & Rehab', 'Care conference', 39.5),
    trip(`${month}-27`, 'FPP office', 'Lakeview Nursing & Rehab', 'Rounds', 18.4)
  ];
  const miles = round(reyesTrips.reduce((n, x) => n + x.miles, 0), 1);
  add('mileage', 'u1', { date: `${month}-01`, period: month, values: { none: false, trips: reyesTrips, totalMiles: miles, rate: 0.7, amount: round(miles * 0.7, 2) } }, at(t, 9, 5));
  const bellTrips = [trip(`${prev}-09`, 'FPP office', 'Palm Bay Care Center', 'Rounds', 24.2), trip(`${prev}-23`, 'FPP office', 'Lakeview Nursing & Rehab', 'Rounds', 31.0)];
  add('mileage', 'u2', { date: `${prev}-01`, period: prev, values: { none: false, trips: bellTrips, totalMiles: 55.2, rate: 0.7, amount: 38.64 } },
    at(`${month}-02`, 10), 'paid', [{ at: at(`${month}-03`, 11), by: 'u0', action: 'Approved', note: '' }, { at: at(`${month}-15`, 9), by: 'u0', action: 'Marked paid', note: '' }]);

  add('expense', 'u5', { date: addDays(t, -2), values: { date: addDays(t, -2), category: 'Supplies', vendor: 'Office supply store', amount: 42.18, purpose: 'Replacement printer toner for the front office.', receipts: [] } }, at(addDays(t, -2), 15, 20));
  add('incident', 'u4', { date: addDays(t, -1), values: {
    date: addDays(t, -1), time: '10:40', facility: 'Lakeview Nursing & Rehab', type: 'Safety hazard', severity: 'Low: no harm',
    what: 'Water leaking from a ceiling tile outside the nurses\' station left the hallway floor wet. Nobody fell.',
    people: '', action: 'Told facility maintenance and put out wet-floor signs until it was cleaned up.', contact: 'J. Rivera, maintenance supervisor'
  } }, at(addDays(t, -1), 11, 5));
  add('supply', 'u6', { date: addDays(t, -6), values: { item: 'Visitor sign-in clipboards', qty: 3, facility: 'Office', urgency: 'Routine', notes: '' } },
    at(addDays(t, -6), 9, 30), 'approved', [{ at: at(addDays(t, -5), 10), by: 'u0', action: 'Approved', note: 'Ordered with this week\'s supplies.' }]);

  return {
    formSubs: subs,
    formSettings: { eodDays: [1, 2, 3, 4, 5], eodStart: start, eodTasks: DEFAULT_EOD_TASKS.slice(), mileageRate: 0.7 }
  };
}
