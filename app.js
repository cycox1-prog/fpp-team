'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const addMonths = (s, n) => { const d = parseYmd(s); d.setMonth(d.getMonth() + n); return ymd(d); };
const mondayOf = s => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const monthStart = s => s.slice(0, 8) + '01';
const monthEnd = s => addDays(addMonths(monthStart(s), 1), -1);
const today = () => ymd(new Date());
const fmtDay = s => {
  const d = parseYmd(s);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
};
const fmtMonth = s => parseYmd(s).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const fmtRange = (a, b) => a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`;
const eachDay = (a, b) => { const out = []; for (let d = a; d <= b && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };
const overlaps = (r, from, to) => r.from <= to && r.to >= from;
const fmtClock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const hrs = n => (Math.round(n * 100) / 100).toFixed(2);
const localInput = iso => { const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayStartIso = s => parseYmd(s).toISOString();

/* ---------- data ---------- */
const KEY = 'fpp-team-v2';
const ROLES = ['Physician', 'Nurse Practitioner', 'Medical Assistant', 'Front Desk', 'Billing', 'Office Manager'];
const OTHER_ROLE = '__other';
/** Groups drive course assignment, provider coverage and who clocks in. Role is just a job title. */
const GROUPS = { provider: 'Provider', billing: 'Billing', staff: 'Staff', admin: 'Admin' };
const defaultGroup = role => ({ Physician: 'provider', 'Nurse Practitioner': 'provider', Billing: 'billing', 'Office Manager': 'admin' }[role] ?? 'staff');
const KINDS = ['Vacation', 'Sick', 'CME / conference', 'Personal', 'Other'];

function seed() {
  const t = today();
  const staff = [
    { id: 'u0', name: 'Admin User', role: 'Office Manager', admin: true },
    { id: 'u1', name: 'Dr. Alicia Reyes', role: 'Physician' },
    { id: 'u2', name: 'Marcus Bell, NP', role: 'Nurse Practitioner' },
    { id: 'u3', name: 'Dr. Samuel Nguyen', role: 'Physician' },
    { id: 'u4', name: 'Dr. Priya Patel', role: 'Physician' },
    { id: 'u5', name: 'Tanya Moore', role: 'Medical Assistant' },
    { id: 'u6', name: 'Dana Shaw', role: 'Front Desk' },
    { id: 'u7', name: 'Jordan Pike', role: 'Billing' }
  ];
  staff.forEach(u => { u.group = defaultGroup(u.role); u.managerId = SEED_MANAGERS[u.id] ?? null; });
  const snfs = [
    { id: 's1', name: 'Lakeview Nursing & Rehab', address: 'Orlando, FL', staff: ['u1', 'u2', 'u4', 'u5'] },
    { id: 's2', name: 'Palm Bay Care Center', address: 'Tampa, FL', staff: ['u2', 'u3', 'u5'] },
    { id: 's3', name: 'Bayshore Health & Rehab', address: 'Jacksonville, FL', staff: ['u1', 'u3', 'u4', 'u6'] }
  ];
  addSeedRegions(snfs, staff.map(u => u.id));
  const mk = (userId, kind, from, to, status, extra = {}) =>
    ({ id: uid(), userId, kind, from: addDays(t, from), to: addDays(t, to), reason: '', status, created: new Date().toISOString(), coverage: [], ...extra });
  const requests = [
    mk('u1', 'Vacation', 5, 7, 'approved', { reason: 'Family trip', coverage: [{ snfId: 's1', coverId: 'u4' }, { snfId: 's3', coverId: 'u3' }] }),
    mk('u2', 'CME / conference', 6, 8, 'pending', { reason: 'Geriatrics conference', suggest: 'u4' }),
    mk('u5', 'Personal', 10, 11, 'pending', { reason: 'Appointment' })
  ];
  return {
    v: 2, staff, snfs, requests, ...seedTime(), ...seedCourses(),
    templates: [
      { id: 't1', name: 'Opening checklist', items: ['Unlock and disarm', 'Check supplies stocked', 'Power on workstations and printers', 'Review today\'s SNF rounding list'] },
      { id: 't2', name: 'Closing checklist', items: ['Workstations locked', 'Shred bins locked', 'Lights off, doors locked, alarm set'] }
    ],
    runs: [],
    ...seedForms(staff, snfs)
  };
}

/** Demo reporting lines: the medical director at the top, the office manager running the office staff. */
const SEED_MANAGERS = { u0: 'u1', u2: 'u1', u3: 'u1', u4: 'u1', u5: 'u0', u6: 'u0', u7: 'u0' };

/** A week of punches for hourly staff, including one missed clock-out and one missed clock-in with fix requests. */
function seedTime() {
  const t = today();
  const at = (d, h, m) => { const x = parseYmd(d); x.setHours(h, m); return x.toISOString(); };
  const days = [];
  for (let k = 7; k >= 1; k--) if (![0, 6].includes(parseYmd(addDays(t, -k)).getDay())) days.push(addDays(t, -k));
  const time = [];
  days.forEach((d, i) => [['u5', 0], ['u6', 1], ['u7', 2]].forEach(([userId, n]) => {
    time.push({ id: uid(), userId, in: at(d, 7 + (n === 2 ? 1 : 0), 50 + ((i + n) % 3) * 4), out: at(d, 16, 20 + ((i * 3 + n) % 4) * 5) });
  }));
  const last = days[days.length - 1], prev = days[days.length - 2];
  const missedOut = time.find(e => e.userId === 'u5' && ymd(new Date(e.in)) === last);
  missedOut.out = null;
  const danaPrev = time.findIndex(e => e.userId === 'u6' && ymd(new Date(e.in)) === prev);
  time.splice(danaPrev, 1);
  const created = at(t, 8, 10);
  const punchFixes = [
    { id: uid(), userId: 'u5', entryId: missedOut.id, prevIn: missedOut.in, prevOut: null, in: missedOut.in, out: at(last, 16, 35),
      reason: 'Forgot to clock out before leaving Lakeview.', status: 'pending', created },
    { id: uid(), userId: 'u6', entryId: null, prevIn: null, prevOut: null, in: at(prev, 8, 5), out: at(prev, 16, 30),
      reason: "My phone died that morning, so I couldn't clock in.", status: 'pending', created }
  ];
  return { time, punchFixes };
}

let db;
try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
if (!db || db.v !== 2) db = seed();
db.time ??= [];
db.punchFixes ??= [];
if (!db.courses) Object.assign(db, seedCourses());
// Older data predates groups: derive them from job titles.
db.staff.forEach(u => { u.group ??= defaultGroup(u.role); });
// Older data predates the org chart: place the demo people, leave anyone else at the top for an admin to place.
db.staff.forEach(u => {
  if (!('managerId' in u)) u.managerId = db.staff.some(x => x.id === SEED_MANAGERS[u.id]) ? SEED_MANAGERS[u.id] : null;
});
// Older data predates regions.
if (!db.snfs.some(s => 'region' in s)) addSeedRegions(db.snfs, db.staff.map(u => u.id));
db.courses.forEach(c => {
  if (!c.groups) { c.groups = [...new Set((c.roles ?? []).map(defaultGroup))]; delete c.roles; }
});
if (!db.formSubs) { Object.assign(db, seedForms(db.staff, db.snfs)); delete db.forms; delete db.submissions; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage unavailable */ } };

const ui = { userId: null, tab: 'home', month: monthStart(today()), week: mondayOf(today()), snf: '', play: null, resetScroll: false,
  form: null, formWeek: mondayOf(today()), formFilter: { type: '', status: '', user: '' },
  snfView: 'list', regionDate: today(), calView: 'timeoff' };
try { ui.userId = sessionStorage.getItem('fpp-user'); } catch { /* ignore */ }

const me = () => db.staff.find(s => s.id === ui.userId);
const isAdmin = () => !!me()?.admin;
const userOf = id => db.staff.find(s => s.id === id);
const userName = id => userOf(id)?.name ?? 'Unknown';
const shortName = n => n.replace(/^Dr\.\s+/, '').replace(/,.*$/, '').split(' ').pop();
const isProvider = u => u?.group === 'provider';
/** Hourly staff clock in and out; providers and admins don't. */
const isHourly = u => !!u && !u.admin && !isProvider(u);
const snfName = id => db.snfs.find(s => s.id === id)?.name ?? 'Removed SNF';
const snfsOf = userId => db.snfs.filter(s => s.staff.includes(userId));

/* ---------- time-off queries ---------- */
const approvedOff = (userId, from, to, ignoreId) =>
  db.requests.filter(r => r.userId === userId && r.status === 'approved' && r.id !== ignoreId && overlaps(r, from, to));

function requestsOn(date, { includePending, snf }) {
  return db.requests.filter(r =>
    (r.status === 'approved' || (includePending && r.status === 'pending')) &&
    r.from <= date && date <= r.to &&
    (!snf || snfsOf(r.userId).some(s => s.id === snf)));
}

/** Providers who could cover `snf` for [from,to]: anyone but the requester, flagged if out. */
function coverCandidates(req, snfId) {
  return db.staff.filter(isProvider).filter(p => p.id !== req.userId).map(p => ({
    p, assigned: db.snfs.find(s => s.id === snfId)?.staff.includes(p.id) ?? false,
    off: approvedOff(p.id, req.from, req.to, req.id)[0]
  })).sort((a, b) => (b.assigned - a.assigned) || a.p.name.localeCompare(b.p.name));
}

const coverOptions = (req, snfId, selected) => {
  const c = coverCandidates(req, snfId);
  return `<option value="">Select a provider…</option>` + c.map(({ p, assigned, off }) =>
    `<option value="${p.id}" ${off ? 'disabled' : ''} ${p.id === selected && !off ? 'selected' : ''}>${esc(p.name)} · ${assigned ? 'assigned here' : 'not assigned here'}${off ? ` · OUT ${esc(fmtRange(off.from, off.to))}` : ''}</option>`).join('');
};

function bestCover(req, snfId) {
  const c = coverCandidates(req, snfId).filter(x => !x.off);
  if (req.suggest && c.some(x => x.p.id === req.suggest)) return req.suggest;
  return c.find(x => x.assigned)?.p.id ?? '';
}

function coverageLines(r) {
  if (r.status !== 'approved' || !r.coverage?.length) return '';
  return r.coverage.map(c => `<br><span class="small">↳ ${esc(snfName(c.snfId))}: ${c.coverId
    ? `${esc(userName(c.coverId))} sees patients` : '<span class="badge bad">needs coverage</span>'}</span>`).join('');
}

/* ---------- toast & dialog ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  if (!t.matches(':popover-open')) t.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidePopover(), 3200);
}

function openDialog(title, bodyHtml, { onSubmit, okLabel = 'Save', extra = '', wide = false, sticky = false, onClose } = {}) {
  const dlg = $('#dlg');
  dlg.className = wide ? 'wide' : '';
  // Sticky dialogs (long forms) close only from their buttons, so a stray click or Esc can't discard work.
  dlg.setAttribute('closedby', sticky ? 'none' : 'any');
  dlg.innerHTML = `<form method="dialog">
    <h2 id="dlg-title">${esc(title)}</h2>
    ${bodyHtml}
    <div class="actions">
      ${extra}
      <button value="cancel" formnovalidate>${onSubmit ? 'Cancel' : 'Close'}</button>
      ${onSubmit ? `<button class="primary" value="ok">${esc(okLabel)}</button>` : ''}
    </div></form>`;
  const form = $('form', dlg);
  form.addEventListener('submit', e => {
    if (e.submitter?.value === 'ok' && onSubmit && onSubmit(new FormData(form)) === false) e.preventDefault();
  });
  dlg.addEventListener('close', () => {
    const rv = dlg.returnValue;
    dlg.returnValue = '';
    onClose?.(rv, new FormData(form));
    render();
  }, { once: true });
  dlg.showModal();
}

/* ---------- calendar ---------- */
function monthGrid(first, { highlight = null, includePending = false, snf = '', interactive = true } = {}) {
  const gridStart = mondayOf(first);
  const gridEnd = addDays(mondayOf(monthEnd(first)), 6);
  const cells = eachDay(gridStart, gridEnd).map(d => {
    const off = requestsOn(d, { includePending, snf });
    const covs = off.filter(r => r.status === 'approved').flatMap(r => r.coverage.filter(c => !snf || c.snfId === snf)
      .map(c => ({ ...c, req: r })));
    const chips = [
      ...off.map(r => `<span class="off ${r.status === 'pending' ? 'pend' : ''}">${esc(shortName(userName(r.userId)))}</span>`),
      ...covs.map(c => c.coverId ? `<span class="cov">↳ ${esc(shortName(userName(c.coverId)))}</span>` : '<span class="cov need">⚠ cover</span>')
    ];
    const shown = chips.slice(0, 3).join('') + (chips.length > 3 ? `<span class="more">+${chips.length - 3}</span>` : '');
    const cls = ['day', d.slice(0, 7) !== first.slice(0, 7) ? 'other' : '', d === today() ? 'today' : '',
      highlight && d >= highlight[0] && d <= highlight[1] ? 'hl' : ''].join(' ');
    const label = `${fmtDay(d)}: ${off.length} out`;
    const num = `<span class="num">${+d.slice(8)}</span>`;
    return interactive
      ? `<button class="${cls}" data-act="day" data-date="${d}" aria-label="${esc(label)}">${num}${shown}</button>`
      : `<div class="${cls}" aria-label="${esc(label)}">${num}${shown}</div>`;
  });
  return `<div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="hd">${d}</div>`).join('')}${cells.join('')}</div>`;
}

function viewCalendar() {
  const oncall = ui.calView === 'oncall';
  return `<div class="row between"><div class="seg" role="group" aria-label="Calendar view">
      <button data-act="cal-view" data-v="timeoff" aria-pressed="${!oncall}">Time off</button>
      <button data-act="cal-view" data-v="oncall" aria-pressed="${oncall}">On-call</button>
    </div>${isAdmin() ? '<button data-act="cal-export" style="margin-bottom:14px">Export CSV</button>' : ''}</div>
    ${oncall ? viewOnCall() : viewTimeOffCalendar()}`;
}

/* ---------- calendar export ---------- */
function downloadCsv(fileName, rows) {
  const csv = rows.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

const weekday = d => parseYmd(d).toLocaleDateString('en-US', { weekday: 'long' });

/** Who sees a provider's patients at each of their SNFs while they're out, as one cell. */
function coverageText(r) {
  if (!isProvider(userOf(r.userId))) return 'Not required';
  if (r.status !== 'approved') return 'Assigned at approval';
  const gaps = new Set(coverageGaps().filter(g => g.req.id === r.id).map(g => g.snfId));
  return snfsOf(r.userId).map(s => {
    const c = r.coverage.find(x => x.snfId === s.id);
    return `${s.name}: ${gaps.has(s.id) || !c?.coverId ? 'NEEDS COVERAGE' : userName(c.coverId)}`;
  }).join('; ') || 'No SNFs assigned';
}

function timeOffRows(from, to, { pending, snf, perDay }) {
  const reqs = db.requests.filter(r => (r.status === 'approved' || (pending && r.status === 'pending')) && overlaps(r, from, to) &&
    (!snf || snfsOf(r.userId).some(s => s.id === snf))).sort((a, b) => a.from.localeCompare(b.from) || userName(a.userId).localeCompare(userName(b.userId)));
  const who = r => { const u = userOf(r.userId); return [u?.name ?? 'Removed', GROUPS[u?.group] ?? '', u?.role ?? '']; };
  if (perDay) {
    return [['Date', 'Day', 'Employee', 'Group', 'Job title', 'Type', 'Status', 'Coverage'],
      ...reqs.flatMap(r => eachDay(r.from < from ? from : r.from, r.to > to ? to : r.to).map(d => [d, weekday(d), ...who(r), r.kind, r.status, coverageText(r)]))
        .sort((a, b) => a[0].localeCompare(b[0]))];
  }
  return [['Employee', 'Group', 'Job title', 'Type', 'Status', 'First day', 'Last day', 'Days', 'Reason', 'Coverage', 'Office note'],
    ...reqs.map(r => [...who(r), r.kind, r.status, r.from, r.to, eachDay(r.from, r.to).length, r.reason, coverageText(r), r.note ?? ''])];
}

/** Same Date / Shift / Provider columns as the on-call template, so an export can be edited and imported back. */
function onCallRows(from, to) {
  const source = { csv: 'Imported', draft: 'Drafted', manual: 'Set by hand' };
  return [['Date', 'Day', 'Shift', 'Provider', 'Email', 'Set by', 'Issue'],
    ...eachDay(from, to).map(d => {
      const shift = shiftFor(d);
      const id = assignee(d, shift);
      const u = userOf(id);
      return [d, weekday(d), SHIFTS[shift].csv, u?.name ?? '', u?.email ?? '', source[entryFor(d, shift)?.source] ?? (u ? 'Default' : ''),
        oncallIssues(d, d)[0]?.kind === 'conflict' ? 'On call during approved time off' : u ? '' : 'Unassigned'];
    })];
}

function calendarExportDialog() {
  const from = ui.month, to = monthEnd(ui.month);
  const which = ui.calView === 'oncall' ? 'oncall' : 'timeoff';
  openDialog('Export calendar', `
    <fieldset><legend>Calendar</legend>
      ${[['timeoff', 'Time off'], ['oncall', 'On-call'], ['both', 'Both (two files)']].map(([v, label]) =>
        `<label class="day-pick"><input type="radio" name="which" value="${v}" ${v === which ? 'checked' : ''}> ${label}</label>`).join('')}
    </fieldset>
    <div class="grid2">
      <div class="field"><label for="ex-from">From</label><input id="ex-from" type="date" name="from" value="${from}" required></div>
      <div class="field"><label for="ex-to">To</label><input id="ex-to" type="date" name="to" value="${to}" required></div>
    </div>
    <fieldset class="ex-timeoff"><legend>Time-off options</legend>
      <div class="field"><label for="ex-snf">SNF</label><select id="ex-snf" name="snf"><option value="">All SNFs</option>
        ${db.snfs.slice().sort(byName).map(s => `<option value="${s.id}" ${ui.snf === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <label class="day-pick"><input type="radio" name="layout" value="request" checked> One row per request</label>
      <label class="day-pick"><input type="radio" name="layout" value="day"> One row per day off</label>
      <div class="check"><input type="checkbox" id="ex-pending" name="pending"><label for="ex-pending">Include pending requests</label></div>
    </fieldset>
    <p class="small muted ex-oncall">The on-call file uses the same columns as the import template, so you can edit it and import it back.</p>`, {
    okLabel: 'Download',
    onSubmit: fd => {
      const f = fd.get('from'), t = fd.get('to'), w = fd.get('which');
      if (t < f) { alert('"To" must be on or after "From".'); return false; }
      if (eachDay(f, t).length > 366) { alert('Export up to one year at a time.'); return false; }
      const range = `${f}_to_${t}`;
      if (w !== 'oncall') {
        const rows = timeOffRows(f, t, { pending: fd.get('pending') === 'on', snf: fd.get('snf'), perDay: fd.get('layout') === 'day' });
        downloadCsv(`time-off_${range}.csv`, rows);
      }
      // A short gap lets the browser accept the second download.
      if (w !== 'timeoff') setTimeout(() => downloadCsv(`on-call_${range}.csv`, onCallRows(f, t)), w === 'both' ? 400 : 0);
      toast(w === 'both' ? 'Downloading two CSV files' : 'Downloading CSV');
    }
  });
}

function viewTimeOffCalendar() {
  const first = ui.month, last = monthEnd(first);
  const list = db.requests.filter(r => (r.status === 'approved' || (isAdmin() && r.status === 'pending')) && overlaps(r, first, last) &&
    (!ui.snf || snfsOf(r.userId).some(s => s.id === ui.snf))).sort((a, b) => a.from.localeCompare(b.from));
  return `<div class="row between" style="margin-bottom:12px">
      <button data-act="month" data-d="-1" aria-label="Previous month">‹</button>
      <h1 style="margin:0">${fmtMonth(first)}</h1>
      <button data-act="month" data-d="1" aria-label="Next month">›</button></div>
    <div class="row" style="margin-bottom:12px">
      <select id="snf-filter" style="width:auto" aria-label="Filter by SNF"><option value="">All SNFs</option>
        ${db.snfs.map(s => `<option value="${s.id}" ${ui.snf === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <button data-act="month-today">Today</button>
    </div>
    ${monthGrid(first, { includePending: isAdmin(), snf: ui.snf })}
    <p class="small muted legend"><span class="off">Name</span> out · ${isAdmin() ? '<span class="off pend">Name</span> pending · ' : ''}<span class="cov">↳ Name</span> covering patients · <span class="cov need">⚠ cover</span> needs coverage. Tap a day for details.</p>
    <div class="card"><h2>Time off this month</h2>
      ${list.length ? list.map(r => `<div class="shift"><div><strong>${esc(userName(r.userId))}</strong> <span class="muted small">${esc(userOf(r.userId)?.role)}</span><br>
        ${esc(r.kind)} · ${fmtRange(r.from, r.to)}${coverageLines(r)}</div>
        ${r.status === 'pending' ? '<button data-act="review" data-id="' + r.id + '">Review</button>' : ''}</div>`).join('') : '<p class="muted">No time off scheduled.</p>'}</div>`;
}

function dayDialog(date) {
  const reqs = requestsOn(date, { includePending: isAdmin(), snf: '' });
  const snfs = db.snfs.filter(s => !ui.snf || s.id === ui.snf);
  const body = `<h3>Out</h3>
    ${reqs.length ? reqs.map(r => `<div class="shift"><div><strong>${esc(userName(r.userId))}</strong> <span class="muted small">${esc(userOf(r.userId)?.role)}</span><br>
      <span class="small">${esc(r.kind)} · ${fmtRange(r.from, r.to)}</span></div>${r.status === 'pending' ? '<span class="badge warn">pending</span>' : ''}</div>`).join('') : '<p class="muted">Nobody is out.</p>'}
    <h3 style="margin-top:1rem">SNF coverage</h3>
    ${snfs.map(s => {
      const people = s.staff.map(userOf).filter(Boolean);
      const out = r => reqs.find(x => x.userId === r.id && x.status === 'approved');
      const present = people.filter(p => isProvider(p) && !out(p));
      const gone = people.filter(p => isProvider(p) && out(p));
      return `<div class="shift"><div><strong>${esc(s.name)}</strong><br>
        <span class="small">Providers in: ${present.length ? present.map(p => esc(shortName(p.name))).join(', ') : '<span class="badge bad">none assigned</span>'}</span>
        ${gone.map(p => {
          const c = out(p).coverage.find(x => x.snfId === s.id);
          return `<br><span class="small">${esc(shortName(p.name))} is out → ${c?.coverId ? `<strong>${esc(userName(c.coverId))}</strong> sees patients` : '<span class="badge bad">needs coverage</span>'}</span>`;
        }).join('')}</div></div>`;
    }).join('')}`;
  openDialog(fmtDay(date), body);
}

/* ---------- login & shell ---------- */
function renderLogin() {
  return `<div class="login">
    <h1><img class="login-logo" src="assets/logo.svg" alt="Florida Physician Partners, Post-Acute Hospitalists" width="693" height="313"></h1>
    <p class="muted tagline">Time off, SNF coverage, training and forms.<br>Demo sign-in: pick a person.</p>
    ${db.staff.map(s => `<button class="user" data-act="login" data-id="${s.id}">
      <span><strong>${esc(s.name)}</strong><br><span class="muted small">${esc(s.role)}</span></span>
      ${s.admin ? '<span class="badge">Admin</span>' : ''}</button>`).join('')}
    <p class="small muted">Demo build: no passwords, data is stored only in this browser.</p>
  </div>`;
}

const TABS_EMP = [['home', 'Home', '🏠'], ['calendar', 'Calendar', '📅'], ['snfs', 'SNFs', '🏥'], ['timeoff', 'Time off', '🏖'], ['courses', 'Courses', '🎓'], ['forms', 'Forms', '📋']];
const TABS_ADMIN = [['calendar', 'Calendar', '📅'], ['requests', 'Requests', '📥'], ['timesheets', 'Hours', '⏱'], ['snfs', 'SNFs', '🏥'], ['courses', 'Courses', '🎓'], ['forms', 'Forms', '📋'], ['team', 'Team', '👥']];

function renderShell() {
  const tabs = isAdmin() ? TABS_ADMIN : TABS_EMP;
  if (!tabs.some(t => t[0] === ui.tab) && ui.tab !== 'org') ui.tab = tabs[0][0];
  const views = { org: viewOrgPage, home: viewHome, calendar: viewCalendar, snfs: viewSnfs, timeoff: viewTimeOff, forms: viewForms, requests: viewRequests, timesheets: viewTimesheets, courses: viewCourses, team: viewTeam };
  const pending = db.requests.filter(r => r.status === 'pending').length + db.punchFixes.filter(f => f.status === 'pending').length;
  const needCover = coverageGaps().length;
  const formCount = isAdmin() ? db.formSubs.filter(s => statusGroup(s) === 'review').length : dueItems(me()).length;
  const badge = id => id === 'requests' && (pending || needCover) ? ` (${pending + needCover})`
    : id === 'forms' && formCount ? ` (${formCount})` : '';
  return `<header class="top">
      <div class="title"><img class="brand-logo" src="assets/logo.svg" alt="Florida Physician Partners" width="693" height="313"></div>
      <div class="who"><strong>${esc(me().name)}</strong><br>${esc(me().role)}</div>
      <button data-act="logout">Sign out</button>
    </header>
    <nav class="tabs" aria-label="Main">
      ${tabs.map(([id, label, ico]) => `<button data-act="tab" data-id="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}>
        <span class="ico" aria-hidden="true">${ico}</span>${label}${badge(id)}</button>`).join('')}
    </nav>
    <main>${ui.form ? viewFormFill() : ui.play ? viewPlayer() : views[ui.tab]()}</main>`;
}

/**
 * Approved provider time off that leaves an SNF uncovered: no covering provider picked, the SNF was assigned
 * after approval, or the covering provider is out themselves during those dates.
 */
function coverageGaps() {
  return db.requests.filter(r => r.status === 'approved' && r.to >= today() && isProvider(userOf(r.userId)))
    .flatMap(r => snfsOf(r.userId).filter(s => {
      const c = r.coverage.find(x => x.snfId === s.id);
      return !c?.coverId || approvedOff(c.coverId, r.from, r.to, r.id).length > 0;
    }).map(s => ({ req: r, snfId: s.id })));
}

/* ---------- staff home ---------- */
function viewHome() {
  const u = me();
  const mine = snfsOf(u.id);
  const upcoming = db.requests.filter(r => r.userId === u.id && r.status !== 'denied' && r.status !== 'cancelled' && r.to >= today()).sort((a, b) => a.from.localeCompare(b.from));
  const covering = db.requests.filter(r => r.status === 'approved' && r.to >= today() && r.coverage.some(c => c.coverId === u.id)).sort((a, b) => a.from.localeCompare(b.from));
  const doneToday = db.runs.filter(r => r.userId === u.id && r.date === today() && r.done).map(r => r.templateId);
  return `${isHourly(u) ? clockCard(u) : ''}
  ${formsDueCard(u)}
  ${myOnCallCard(u)}
  ${myTeamCard(u)}
  ${trainingCard(u)}
  <div class="card"><h2>My SNFs</h2>
    ${mine.length ? mine.map(s => `<div class="shift"><div><strong>${esc(s.name)}</strong><br><span class="muted small">${esc(s.address)}</span></div>
      <div class="muted small" style="text-align:right">${s.staff.filter(id => id !== u.id).map(id => esc(shortName(userName(id)))).join(', ')}</div></div>`).join('') : '<p class="muted">You are not assigned to an SNF yet.</p>'}</div>
  ${covering.length ? `<div class="card"><h2>I'm covering</h2>
    ${covering.map(r => `<div class="shift"><div><strong>${esc(userName(r.userId))}'s patients</strong><br>
      <span class="small">${r.coverage.filter(c => c.coverId === u.id).map(c => esc(snfName(c.snfId))).join(', ')}</span></div>
      <div class="small muted">${fmtRange(r.from, r.to)}</div></div>`).join('')}</div>` : ''}
  <div class="card"><div class="row between"><h2>My time off</h2><button class="primary" data-act="new-timeoff">Request</button></div>
    ${upcoming.length ? upcoming.map(r => `<div class="shift"><div>${esc(r.kind)} · ${fmtRange(r.from, r.to)}${coverageLines(r)}</div>${statusBadge(r.status)}</div>`).join('') : '<p class="muted">Nothing upcoming.</p>'}</div>
  <div class="card"><h2>Checklists due today</h2>
    ${db.templates.map(t => `<div class="shift"><span>${esc(t.name)}</span>
      ${doneToday.includes(t.id) ? '<span class="badge ok">Done</span>' : `<button data-act="run-checklist" data-id="${t.id}">Start</button>`}</div>`).join('') || '<p class="muted">None.</p>'}</div>`;
}

/* ---------- time clock ---------- */
/* A punch still open from an earlier day is a missed clock-out: it counts 0 hours until fixed and doesn't block clocking in today. */
const isStale = e => !e.out && e.in < dayStartIso(today());
const openEntry = userId => db.time.find(t => t.userId === userId && !t.out && !isStale(t));
const entryHours = e => e.out ? (new Date(e.out) - new Date(e.in)) / 36e5 : isStale(e) ? 0 : (Date.now() - new Date(e.in)) / 36e5;
const pendingFix = entryId => db.punchFixes.find(f => f.entryId === entryId && f.status === 'pending');
const fixKind = f => !f.entryId ? 'Forgot to clock in' : !f.prevOut ? 'Missed clock-out' : 'Time correction';
const fmtPunch = (inIso, outIso) => `${fmtDay(ymd(new Date(inIso)))} · ${fmtClock(inIso)} to ${outIso ? fmtClock(outIso) : 'no clock-out'}`;
const entriesInWeek = (week, userId) => db.time.filter(e => e.in >= dayStartIso(week) && e.in < dayStartIso(addDays(week, 7)) && (!userId || e.userId === userId));

function clockCard(u) {
  const open = openEntry(u.id);
  const week = entriesInWeek(mondayOf(today()), u.id);
  const total = week.reduce((n, e) => n + entryHours(e), 0);
  const stale = db.time.filter(e => e.userId === u.id && isStale(e)).sort((a, b) => b.in.localeCompare(a.in));
  const fixes = db.punchFixes.filter(f => f.userId === u.id && (f.status === 'pending' || f.decidedAt >= dayStartIso(addDays(today(), -14))))
    .sort((a, b) => b.created.localeCompare(a.created));
  const fixBtn = e => pendingFix(e.id) ? '<span class="badge warn">fix requested</span>'
    : `<button class="link" data-act="punch-fix" data-id="${e.id}">Fix</button>`;
  return `<div class="card">
    ${stale.map(e => `<div class="banner row between"><span>You didn't clock out on <strong>${fmtDay(ymd(new Date(e.in)))}</strong> (clocked in at ${fmtClock(e.in)}).</span>
      ${pendingFix(e.id) ? '<span class="badge warn">Fix requested</span>' : `<button class="primary" data-act="punch-fix" data-id="${e.id}">Request fix</button>`}</div>`).join('')}
    <div class="clock-status">
      <div class="muted small">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="time" id="live-clock">${fmtClock(new Date().toISOString())}</div>
      ${open ? `<p>Clocked in since <strong>${fmtClock(open.in)}</strong></p>` : '<p class="muted">You are clocked out.</p>'}
    </div>
    ${open ? '<button class="big clock-out" data-act="clockout">Clock out</button>' : '<button class="big primary" data-act="clockin">Clock in</button>'}
    <div class="row between" style="margin-top:.6rem">
      <p class="small muted" style="margin:0">This week: <strong>${hrs(total)} h</strong>${total > 40 ? ` <span class="badge warn">${hrs(total - 40)} h overtime</span>` : ''}</p>
      <button class="link small" data-act="punch-fix">Forgot to clock in or out?</button></div>
    ${week.length ? `<details style="margin-top:.4rem"><summary class="small">This week's punches</summary>
      ${week.slice().sort((a, b) => b.in.localeCompare(a.in)).map(e => `<div class="shift small"><span>${fmtDay(ymd(new Date(e.in)))}</span>
        <span>${fmtClock(e.in)} to ${e.out ? fmtClock(e.out) : isStale(e) ? '<span class="badge bad">no clock-out</span>' : 'now'} · ${hrs(entryHours(e))} h ${fixBtn(e)}</span></div>`).join('')}</details>` : ''}
    ${fixes.length ? `<h3 style="margin-top:1rem">Punch fix requests</h3>${fixes.map(f => `<div class="shift small"><div>${fixKind(f)}: ${fmtPunch(f.in, f.out)}
      ${f.note ? `<br><span class="muted">Office note: ${esc(f.note)}</span>` : ''}</div>${statusBadge(f.status)}</div>`).join('')}` : ''}
  </div>`;
}

/** Employee asks the office to add a missing punch or correct an existing one. */
function punchFixDialog(entry) {
  const recent = db.time.filter(x => x.userId === ui.userId && x.in >= dayStartIso(addDays(today(), -30))).sort((a, b) => b.in.localeCompare(a.in));
  const nowLocal = localInput(new Date().toISOString());
  openDialog('Request a punch fix', `
    <p class="small muted">The office reviews every request before your timesheet changes.</p>
    <div class="field"><label for="pf-entry">Which punch?</label><select id="pf-entry" name="entry">
      <option value="">I forgot to clock in (add a missing punch)</option>
      ${recent.map(x => `<option value="${x.id}" ${x.id === entry?.id ? 'selected' : ''} ${pendingFix(x.id) ? 'disabled' : ''}>${fmtPunch(x.in, x.out)}${pendingFix(x.id) ? ' (fix already requested)' : ''}</option>`).join('')}
    </select></div>
    <div class="grid2">
      <div class="field"><label for="pf-in">Correct clock-in</label><input id="pf-in" type="datetime-local" name="in" value="${entry ? localInput(entry.in) : ''}" max="${nowLocal}" required></div>
      <div class="field"><label for="pf-out">Correct clock-out</label><input id="pf-out" type="datetime-local" name="out" value="${entry?.out ? localInput(entry.out) : ''}" max="${nowLocal}" required></div>
    </div>
    <div class="field"><label for="pf-why">What happened?</label><textarea id="pf-why" name="reason" required placeholder="For example: forgot to clock out before leaving Lakeview."></textarea></div>`, {
    okLabel: 'Send request',
    onSubmit: fd => {
      const target = db.time.find(x => x.id === fd.get('entry'));
      const inIso = new Date(fd.get('in')).toISOString();
      const outIso = new Date(fd.get('out')).toISOString();
      if (outIso <= inIso) { alert('Clock-out must be after clock-in.'); return false; }
      if (outIso > new Date().toISOString()) { alert("Clock-out can't be in the future."); return false; }
      const clash = db.time.find(x => x.userId === ui.userId && x.id !== target?.id && x.out && x.in < outIso && x.out > inIso);
      if (clash) { alert(`Those times overlap another punch (${fmtPunch(clash.in, clash.out)}). Pick that punch to correct it instead.`); return false; }
      if ((new Date(outIso) - new Date(inIso)) / 36e5 > 16 && !confirm('That is more than 16 hours. Send anyway?')) return false;
      db.punchFixes.push({
        id: uid(), userId: ui.userId, entryId: target?.id ?? null, prevIn: target?.in ?? null, prevOut: target?.out ?? null,
        in: inIso, out: outIso, reason: String(fd.get('reason')).trim(), status: 'pending', created: new Date().toISOString()
      });
      save(); toast('Request sent to the office');
    }
  });
}

/** Admin approves (optionally adjusting the times) or denies a punch fix; approval updates the timesheet. */
function punchFixReviewDialog(f) {
  const nowLocal = localInput(new Date().toISOString());
  openDialog('Review punch fix', `
    <p><strong>${esc(userName(f.userId))}</strong> · ${fixKind(f)}<br><span class="small muted">Requested ${new Date(f.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></p>
    <table class="plain"><tbody>
      <tr><th>Current</th><td>${f.entryId ? fmtPunch(f.prevIn, f.prevOut) : 'No punch recorded'}</td></tr>
      <tr><th>Requested</th><td><strong>${fmtPunch(f.in, f.out)}</strong> (${hrs((new Date(f.out) - new Date(f.in)) / 36e5)} h)</td></tr>
    </tbody></table>
    <p style="margin-top:.8rem">"${esc(f.reason)}"</p>
    <p class="small muted">Adjust the times before approving if needed.</p>
    <div class="grid2">
      <div class="field"><label for="rf-in">Clock-in</label><input id="rf-in" type="datetime-local" name="in" value="${localInput(f.in)}" max="${nowLocal}" required></div>
      <div class="field"><label for="rf-out">Clock-out</label><input id="rf-out" type="datetime-local" name="out" value="${localInput(f.out)}" max="${nowLocal}" required></div>
    </div>
    <div class="field"><label for="rf-note">Note to employee (required to deny)</label><textarea id="rf-note" name="note"></textarea></div>`, {
    okLabel: 'Approve',
    extra: '<button class="danger" value="deny" formnovalidate>Deny</button>',
    onSubmit: fd => {
      const inIso = new Date(fd.get('in')).toISOString();
      const outIso = new Date(fd.get('out')).toISOString();
      if (outIso <= inIso) { alert('Clock-out must be after clock-in.'); return false; }
      const entry = f.entryId && db.time.find(x => x.id === f.entryId);
      if (entry) Object.assign(entry, { in: inIso, out: outIso, edited: true });
      else db.time.push({ id: uid(), userId: f.userId, in: inIso, out: outIso, edited: true });
      Object.assign(f, { status: 'approved', in: inIso, out: outIso, note: String(fd.get('note') || '').trim(), decidedBy: ui.userId, decidedAt: new Date().toISOString() });
      save(); toast('Punch fix approved; timesheet updated');
    },
    onClose: (rv, fd) => {
      if (rv !== 'deny') return;
      const note = String(fd.get('note') || '').trim();
      if (!note) { toast('Add a note so they know why'); setTimeout(() => punchFixReviewDialog(f)); return; }
      Object.assign(f, { status: 'denied', note, decidedBy: ui.userId, decidedAt: new Date().toISOString() });
      save(); toast('Punch fix denied');
    }
  });
}

function viewTimesheets() {
  const entries = entriesInWeek(ui.week).sort((a, b) => b.in.localeCompare(a.in));
  const rows = db.staff.filter(isHourly).map(s => {
    const mine = entries.filter(e => e.userId === s.id);
    const total = mine.reduce((n, e) => n + entryHours(e), 0);
    return { s, mine, total, ot: Math.max(0, total - 40), open: mine.filter(e => !e.out).length };
  });
  const end = addDays(ui.week, 6);
  const fixCount = db.punchFixes.filter(f => f.status === 'pending').length;
  return `${fixCount ? `<div class="banner row between"><span><strong>${fixCount} punch fix request${fixCount > 1 ? 's' : ''}</strong> waiting for review.</span>
      <button class="primary" data-act="tab" data-id="requests">Review</button></div>` : ''}
  <div class="row between" style="margin-bottom:12px">
      <button data-act="week" data-d="-7" aria-label="Previous week">‹</button>
      <strong>${fmtDay(ui.week)} to ${fmtDay(end)}</strong>
      <button data-act="week" data-d="7" aria-label="Next week">›</button></div>
  <div class="row" style="margin-bottom:12px"><span class="grow"></span>
    <button data-act="add-entry">Add punch</button><button data-act="export-csv">Export CSV</button></div>
  <div class="card"><table class="plain">
    <thead><tr><th>Staff</th><th class="num">Punches</th><th class="num">Hours</th><th class="num">Overtime</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.s.name)}<br><span class="muted small">${esc(r.s.role)}</span>${r.open ? ' <span class="badge">on the clock</span>' : ''}</td>
      <td class="num">${r.mine.length}</td><td class="num">${hrs(r.total)}</td>
      <td class="num">${r.ot ? `<span class="badge warn">${hrs(r.ot)}</span>` : '0.00'}</td></tr>`).join('')}</tbody></table>
    <p class="small muted" style="margin:.6rem 0 0">Providers don't clock in. Overtime is hours over 40 in the week.</p></div>
  <div class="card"><h2>Punches</h2>
    ${entries.length ? entries.map(e => {
      const stale = isStale(e);
      return `<div class="shift"><div><strong>${esc(userName(e.userId))}</strong><br>
        <span class="small">${fmtDay(ymd(new Date(e.in)))} · ${fmtClock(e.in)} to ${e.out ? fmtClock(e.out) : stale ? '<em>no clock-out</em>' : '<em>still in</em>'} (${hrs(entryHours(e))} h)</span>
        ${stale ? '<span class="badge bad">missed clock-out</span>' : ''}${e.edited ? ' <span class="badge">edited</span>' : ''}${pendingFix(e.id) ? ' <span class="badge warn">fix requested</span>' : ''}</div>
        <button data-act="edit-entry" data-id="${e.id}">Edit</button></div>`;
    }).join('') : '<p class="muted">No punches this week.</p>'}</div>`;
}

function entryDialog(e) {
  const isNew = !e;
  const body = `
    <div class="field"><label for="e-user">Staff</label><select id="e-user" name="userId">
      ${db.staff.filter(isHourly).map(x => `<option value="${x.id}" ${x.id === e?.userId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="e-in">Clock in</label><input id="e-in" type="datetime-local" name="in" value="${e ? localInput(e.in) : ''}" required></div>
    <div class="field"><label for="e-out">Clock out</label><input id="e-out" type="datetime-local" name="out" value="${e?.out ? localInput(e.out) : ''}"></div>`;
  openDialog(isNew ? 'Add punch' : 'Edit punch', body, {
    extra: isNew ? '' : '<button class="danger" value="delete" formnovalidate>Delete</button>',
    onSubmit: fd => {
      const inIso = new Date(fd.get('in')).toISOString();
      const outIso = fd.get('out') ? new Date(fd.get('out')).toISOString() : null;
      if (outIso && outIso <= inIso) { alert('Clock out must be after clock in.'); return false; }
      const patch = { userId: fd.get('userId'), in: inIso, out: outIso, edited: true };
      if (isNew) db.time.push({ id: uid(), ...patch }); else Object.assign(e, patch);
      save(); toast('Punch saved');
    },
    onClose: rv => {
      if (rv === 'delete' && confirm('Delete this punch?')) { db.time = db.time.filter(x => x.id !== e.id); save(); toast('Punch deleted'); }
    }
  });
}

function exportCsv() {
  const lines = [['Staff', 'Role', 'Date', 'Clock in', 'Clock out', 'Hours', 'Edited']];
  entriesInWeek(ui.week).sort((a, b) => a.in.localeCompare(b.in)).forEach(e => {
    const u = userOf(e.userId);
    lines.push([u?.name, u?.role, ymd(new Date(e.in)), fmtClock(e.in), e.out ? fmtClock(e.out) : '', hrs(entryHours(e)), e.edited ? 'yes' : '']);
  });
  const csv = lines.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `timesheets-${ui.week}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const statusBadge = s => `<span class="badge ${s === 'approved' ? 'ok' : s === 'denied' ? 'bad' : s === 'cancelled' ? '' : 'warn'}">${s}</span>`;

/* ---------- SNFs ---------- */
function viewSnfs() {
  const t = today();
  const live = requestsOn(t, { includePending: false, snf: '' });
  const order = u => (isProvider(u) ? 0 : 1);
  const regions = ui.snfView === 'regions';
  return `<div class="row between" style="margin-bottom:12px"><h1 style="margin:0">SNFs</h1>
      ${isAdmin() ? '<button class="primary" data-act="new-snf">Add SNF</button>' : ''}</div>
    <div class="seg" role="group" aria-label="SNF view">
      <button data-act="snf-view" data-v="list" aria-pressed="${!regions}">Assignments</button>
      <button data-act="snf-view" data-v="regions" aria-pressed="${regions}">Regional chart</button>
    </div>
    ${regions ? viewRegions() : db.snfs.slice().sort((a, b) => (a.region ?? 99) - (b.region ?? 99) || byName(a, b)).map(s => {
      const people = s.staff.map(userOf).filter(Boolean).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      return `<div class="card"><div class="row between"><div><h2 style="margin:0">${esc(s.name)}</h2><span class="muted small">${s.region ? `Region ${s.region}` : 'No region'}${s.address ? ` · ${esc(s.address)}` : ''}</span></div>
        ${isAdmin() ? `<button data-act="edit-snf" data-id="${s.id}">Edit</button>` : ''}</div>
        ${people.length ? people.map(p => {
          const out = live.find(r => r.userId === p.id);
          const cover = out?.coverage.find(c => c.snfId === s.id);
          const covering = live.filter(r => r.coverage.some(c => c.snfId === s.id && c.coverId === p.id));
          return `<div class="shift"><div><strong>${esc(p.name)}</strong>${p.id === ui.userId ? ' <span class="badge">You</span>' : ''}<br>
            <span class="muted small">${esc(p.role)}</span>
            ${out ? `<br><span class="small">Out until ${fmtDay(out.to)}${isProvider(p) ? ` · ${cover?.coverId ? `covered by ${esc(userName(cover.coverId))}` : '<span class="badge bad">needs coverage</span>'}` : ''}</span>` : ''}
            ${covering.map(r => `<br><span class="small">Covering ${esc(userName(r.userId))}'s patients until ${fmtDay(r.to)}</span>`).join('')}</div>
            ${out ? '<span class="badge warn">Out today</span>' : ''}</div>`;
        }).join('') : '<p class="muted">Nobody assigned.</p>'}</div>`;
    }).join('')}`;
}

function snfDialog(s) {
  const isNew = !s;
  const body = `
    <div class="field"><label for="n-name">SNF name</label><input id="n-name" name="name" value="${esc(s?.name)}" required></div>
    <div class="field"><label for="n-addr">Location</label><input id="n-addr" name="address" value="${esc(s?.address)}"></div>
    <div class="field"><label for="n-region">Region</label><select id="n-region" name="region" required>
      ${!s?.region ? '<option value="">Choose a region…</option>' : ''}
      ${REGIONS.map(n => `<option value="${n}" ${s?.region === n ? 'selected' : ''}>Region ${n}</option>`).join('')}</select></div>
    <fieldset><legend>Assigned staff</legend>
      ${db.staff.filter(u => !u.admin).map(u => `<div class="check"><input type="checkbox" id="m-${u.id}" name="m_${u.id}" ${s?.staff.includes(u.id) ? 'checked' : ''}>
        <label for="m-${u.id}">${esc(u.name)} <span class="muted small">${esc(u.role)}</span></label></div>`).join('')}</fieldset>`;
  openDialog(isNew ? 'Add SNF' : 'Edit SNF', body, {
    extra: isNew ? '' : '<button class="danger" value="delete" formnovalidate>Delete</button>',
    onSubmit: fd => {
      const patch = { name: String(fd.get('name')).trim(), address: String(fd.get('address') || '').trim(), region: +fd.get('region'),
        staff: db.staff.filter(u => !u.admin && fd.get('m_' + u.id) === 'on').map(u => u.id) };
      if (isNew) db.snfs.push({ id: uid(), ...patch }); else Object.assign(s, patch);
      save(); toast('SNF saved');
    },
    onClose: rv => {
      if (rv === 'delete' && confirm(`Delete ${s.name}? Coverage entries for it are removed.`)) {
        db.snfs = db.snfs.filter(x => x.id !== s.id);
        db.requests.forEach(r => { r.coverage = r.coverage.filter(c => c.snfId !== s.id); });
        save(); toast('SNF deleted');
      }
    }
  });
}

/* ---------- time off (staff) ---------- */
function viewTimeOff() {
  const mine = db.requests.filter(r => r.userId === ui.userId).sort((a, b) => b.from.localeCompare(a.from));
  return `<div class="row between" style="margin-bottom:12px"><h1>Time off</h1><button class="primary" data-act="new-timeoff">Request time off</button></div>
  <div class="card">${mine.length ? mine.map(r => `<div class="shift"><div><strong>${esc(r.kind)}</strong> · ${fmtRange(r.from, r.to)}
      ${r.reason ? `<br><span class="muted small">${esc(r.reason)}</span>` : ''}${coverageLines(r)}
      ${r.note ? `<br><span class="small">Admin note: ${esc(r.note)}</span>` : ''}</div>
      <div class="row">${statusBadge(r.status)}${r.status === 'pending' ? `<button data-act="cancel-req" data-id="${r.id}">Cancel</button>` : ''}</div></div>`).join('') : '<p class="muted">No requests yet.</p>'}</div>`;
}

function timeOffDialog() {
  const u = me();
  const needsCover = isProvider(u) && snfsOf(u.id).length > 0;
  openDialog('Request time off', `
    <div class="field"><label for="to-kind">Type</label><select id="to-kind" name="kind">${KINDS.map(k => `<option>${k}</option>`).join('')}</select></div>
    <div class="grid2">
      <div class="field"><label for="to-from">First day out</label><input id="to-from" type="date" name="from" min="${today()}" required></div>
      <div class="field"><label for="to-to">Last day out</label><input id="to-to" type="date" name="to" min="${today()}" required></div>
    </div>
    ${needsCover ? `<div class="banner">Another provider must see your patients at ${snfsOf(u.id).map(s => esc(s.name)).join(', ')}.
      Suggest who could cover; the office confirms coverage when approving.</div>
      <div class="field"><label for="to-sug">Suggested covering provider (optional)</label><select id="to-sug" name="suggest"><option value="">No suggestion</option>
        ${db.staff.filter(p => isProvider(p) && p.id !== u.id).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label for="to-why">Note (optional)</label><textarea id="to-why" name="reason"></textarea></div>`, {
    okLabel: 'Send request',
    onSubmit: fd => {
      const from = fd.get('from'), to = fd.get('to');
      if (to < from) { alert('The last day must be on or after the first day.'); return false; }
      if (db.requests.some(r => r.userId === u.id && (r.status === 'approved' || r.status === 'pending') && overlaps(r, from, to))) {
        alert('You already have a request that overlaps these dates.'); return false;
      }
      db.requests.push({ id: uid(), userId: u.id, kind: fd.get('kind'), from, to, reason: String(fd.get('reason') || '').trim(),
        suggest: fd.get('suggest') || null, status: 'pending', created: new Date().toISOString(), coverage: [] });
      save(); toast('Request sent');
    }
  });
}

/* ---------- requests (admin) ---------- */
function viewRequests() {
  const t = today();
  const pending = db.requests.filter(r => r.status === 'pending').sort((a, b) => a.from.localeCompare(b.from));
  const gaps = coverageGaps();
  const upcoming = db.requests.filter(r => r.status === 'approved' && r.to >= t).sort((a, b) => a.from.localeCompare(b.from));
  const past = db.requests.filter(r => r.status !== 'pending' && !(r.status === 'approved' && r.to >= t)).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 10);
  const row = (r, actions) => `<div class="shift"><div><strong>${esc(userName(r.userId))}</strong> <span class="muted small">${esc(userOf(r.userId)?.role)}</span><br>
    ${esc(r.kind)} · ${fmtRange(r.from, r.to)}${r.reason ? `<br><span class="muted small">${esc(r.reason)}</span>` : ''}${coverageLines(r)}</div><div class="row">${actions}</div></div>`;
  const fixes = db.punchFixes.filter(f => f.status === 'pending').sort((a, b) => a.created.localeCompare(b.created));
  const recentFixes = db.punchFixes.filter(f => f.status !== 'pending').sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)).slice(0, 5);
  const fixRow = (f, action) => `<div class="shift"><div><strong>${esc(userName(f.userId))}</strong> · ${fixKind(f)}<br>
    <span class="small">${f.entryId ? `${fmtPunch(f.prevIn, f.prevOut)} → ` : ''}<strong>${fmtPunch(f.in, f.out)}</strong></span>
    <br><span class="muted small">${esc(f.reason)}</span></div><div class="row">${action}</div></div>`;
  return `<h1>Requests</h1>
  ${fixes.length ? `<div class="card"><h2>Punch fix requests</h2>${fixes.map(f => fixRow(f, `<button class="primary" data-act="review-fix" data-id="${f.id}">Review</button>`)).join('')}</div>` : ''}
  <div class="card"><h2>Time off: pending review</h2>${pending.length ? pending.map(r => row(r, `<button class="primary" data-act="review" data-id="${r.id}">Review</button>`)).join('') : '<p class="muted">Nothing waiting.</p>'}</div>
  ${gaps.length ? `<div class="card"><h2>Coverage needed</h2>${gaps.map(g => `<div class="shift"><div><strong>${esc(userName(g.req.userId))}</strong> · ${esc(snfName(g.snfId))}<br>
      <span class="small">${fmtRange(g.req.from, g.req.to)}</span></div>
      <button class="primary" data-act="fix-cover" data-id="${g.req.id}" data-snf="${g.snfId}">Assign</button></div>`).join('')}</div>` : ''}
  <div class="card"><h2>Approved, upcoming</h2>${upcoming.length ? upcoming.map(r => row(r, `<button class="danger" data-act="cancel-approved" data-id="${r.id}">Cancel</button>`)).join('') : '<p class="muted">None.</p>'}</div>
  <div class="card"><h2>History</h2>${past.length ? past.map(r => row(r, statusBadge(r.status))).join('') : '<p class="muted">None yet.</p>'}</div>
  ${recentFixes.length ? `<div class="card"><h2>Recent punch fixes</h2>${recentFixes.map(f => fixRow(f, statusBadge(f.status))).join('')}</div>` : ''}`;
}

function reviewDialog(r) {
  const u = userOf(r.userId);
  const snfs = snfsOf(u.id);
  const prov = isProvider(u);
  const days = eachDay(r.from, r.to).length;

  const conflicts = [];
  const sharedIds = new Set(snfs.map(s => s.id));
  db.requests.filter(o => o.id !== r.id && o.userId !== u.id && (o.status === 'approved' || o.status === 'pending') && overlaps(o, r.from, r.to)).forEach(o => {
    const shared = snfsOf(o.userId).filter(s => sharedIds.has(s.id));
    if (shared.length) conflicts.push({ lvl: 'warn', text: `${userName(o.userId)} is ${o.status === 'pending' ? 'also requesting' : 'out'} ${fmtRange(o.from, o.to)} (${shared.map(s => s.name).join(', ')}).` });
  });
  if (prov) snfs.forEach(s => {
    const others = db.staff.filter(p => isProvider(p) && p.id !== u.id && s.staff.includes(p.id));
    const avail = others.filter(p => !approvedOff(p.id, r.from, r.to, r.id).length);
    if (!others.length) conflicts.push({ lvl: 'bad', text: `${u.name} is the only provider assigned to ${s.name}; coverage must come from another SNF's provider.` });
    else if (!avail.length) conflicts.push({ lvl: 'bad', text: `No other provider assigned to ${s.name} is available for these dates.` });
  });
  const covering = db.requests.filter(o => o.status === 'approved' && o.userId !== u.id && overlaps(o, r.from, r.to) && o.coverage.some(c => c.coverId === u.id));
  covering.forEach(o => conflicts.push({ lvl: 'bad', text: `${u.name} is covering ${userName(o.userId)}'s patients (${fmtRange(o.from, o.to)}). Approving leaves that coverage open.` }));
  oncallClashes(u.id, r.from, r.to).forEach(d => conflicts.push({ lvl: 'bad',
    text: `${u.name} is on call ${SHIFTS[shiftFor(d)].label} ${fmtDay(d)} (${SHIFTS[shiftFor(d)].time}). Reassign that shift on the On-call calendar.` }));

  const months = []; for (let m = monthStart(r.from); m <= r.to && months.length < 3; m = addMonths(m, 1)) months.push(m);

  const coverHtml = !prov ? '<p class="small muted">Coverage is only required for providers.</p>'
    : !snfs.length ? '<p class="small muted">This provider has no SNF assignments, so no coverage is needed.</p>'
    : `<h3>Coverage</h3>${snfs.map(s => `<div class="field"><label for="cv-${s.id}">Who will see ${esc(u.name)}'s patients at ${esc(s.name)}?</label>
        <select id="cv-${s.id}" name="cv_${s.id}" required>${coverOptions(r, s.id, bestCover(r, s.id))}</select></div>`).join('')}`;

  const body = `
    <p><strong>${esc(u.name)}</strong> · ${esc(u.role)}<br>${esc(r.kind)} · ${fmtRange(r.from, r.to)} (${days} day${days > 1 ? 's' : ''})</p>
    ${r.reason ? `<p class="muted">"${esc(r.reason)}"</p>` : ''}
    <p class="small muted">Assigned SNFs: ${snfs.map(s => esc(s.name)).join(', ') || 'none'}</p>
    <h3>Calendar check</h3>
    ${months.map(m => `<div class="small"><strong>${fmtMonth(m)}</strong></div>${monthGrid(m, { highlight: [r.from, r.to], includePending: true, interactive: false })}`).join('')}
    <p class="small muted legend">Shaded days are the requested dates. Dashed names are other pending requests.</p>
    <h3>Conflicts</h3>
    ${conflicts.length ? conflicts.map(c => `<p class="conflict ${c.lvl}">${c.lvl === 'bad' ? '⛔' : '⚠️'} ${esc(c.text)}</p>`).join('') : '<p class="small">✅ No overlapping time off at this person\'s SNFs.</p>'}
    ${coverHtml}
    <div class="field"><label for="rv-note">Note to requester (optional)</label><textarea id="rv-note" name="note"></textarea></div>`;

  openDialog('Review time off', body, {
    wide: true, okLabel: 'Approve',
    extra: '<button class="danger" value="deny" formnovalidate>Deny</button>',
    onSubmit: fd => {
      const coverage = prov ? snfs.map(s => ({ snfId: s.id, coverId: fd.get('cv_' + s.id) })) : [];
      if (coverage.some(c => !c.coverId || approvedOff(c.coverId, r.from, r.to, r.id).length)) { alert('Pick an available covering provider for every SNF.'); return false; }
      if (covering.length && !confirm('This leaves other providers\' patients without coverage until you reassign them. Approve anyway?')) return false;
      covering.forEach(o => o.coverage.forEach(c => { if (c.coverId === u.id) c.coverId = null; }));
      Object.assign(r, { status: 'approved', coverage, note: String(fd.get('note') || '').trim(), decided: new Date().toISOString() });
      save(); toast(covering.length ? 'Approved. Some coverage now needs reassigning.' : 'Approved and added to the calendar');
    },
    onClose: (rv, fd) => {
      if (rv === 'deny') {
        Object.assign(r, { status: 'denied', note: String(fd.get('note') || '').trim(), decided: new Date().toISOString() });
        save(); toast('Request denied');
      }
    }
  });
}

function fixCoverDialog(r, snfId) {
  let entry = r.coverage.find(c => c.snfId === snfId);
  if (!entry) r.coverage.push(entry = { snfId, coverId: null });  // SNF assigned after the time off was approved
  openDialog('Assign coverage', `<p>Who will see <strong>${esc(userName(r.userId))}'s</strong> patients at <strong>${esc(snfName(snfId))}</strong>, ${fmtRange(r.from, r.to)}?</p>
    <div class="field"><label for="fx">Covering provider</label><select id="fx" name="cover" required>${coverOptions(r, snfId, bestCover(r, snfId))}</select></div>`, {
    okLabel: 'Assign',
    onSubmit: fd => { entry.coverId = fd.get('cover'); save(); toast('Coverage assigned'); }
  });
}

/* ---------- team ---------- */
/* ---------- org chart ---------- */
const TOP = '__top';
const byName = (a, b) => a.name.localeCompare(b.name);
const managerOf = u => userOf(u?.managerId);
const reportsOf = id => db.staff.filter(s => s.managerId === id).sort(byName);

/** Everyone below `id` in the chart, so nobody can be placed under their own report. */
function descendantsOf(id) {
  const out = new Set();
  const walk = x => reportsOf(x).forEach(r => { if (!out.has(r.id)) { out.add(r.id); walk(r.id); } });
  walk(id);
  return out;
}

function orgChart() {
  const seen = new Set();
  const node = u => {
    seen.add(u.id);
    const reps = reportsOf(u.id).filter(r => !seen.has(r.id));
    const tag = isAdmin() ? 'button' : 'div';
    return `<li><${tag} class="org-card g-${u.group}${u.id === ui.userId ? ' me' : ''}"${isAdmin() ? ` data-act="edit-staff" data-id="${u.id}"` : ''}>
        <strong>${esc(u.name)}</strong><span class="small">${esc(u.role)}</span>
        <span class="small muted">${GROUPS[u.group]}${reps.length ? ` · ${reps.length} report${reps.length > 1 ? 's' : ''}` : ''}${u.id === ui.userId ? ' · You' : ''}</span>
      </${tag}>${reps.length ? `<ul>${reps.map(node).join('')}</ul>` : ''}</li>`;
  };
  const roots = db.staff.filter(s => !managerOf(s)).sort(byName);
  let html = roots.map(node).join('');
  // Anyone unreachable (only possible with bad data) still shows up at the top.
  db.staff.filter(s => !seen.has(s.id)).forEach(s => { html += node(s); });
  return `<div class="org" role="tree" aria-label="Organization chart"><ul>${html}</ul></div>
    <p class="small muted" style="margin:.6rem 0 0">${roots.length > 1 ? `${roots.length} people are at the top of the chart. ` : ''}${isAdmin() ? 'Select someone to edit them or change who they report to.' : ''}
      Colors: <span class="org-key g-provider">Provider</span> <span class="org-key g-billing">Billing</span> <span class="org-key g-staff">Staff</span> <span class="org-key g-admin">Admin</span></p>`;
}

function viewOrgPage() {
  return `<div class="row between" style="margin-bottom:12px"><button data-act="tab" data-id="${isAdmin() ? 'team' : 'home'}">‹ Back</button></div>
    <h1>Org chart</h1><div class="card">${orgChart()}</div>`;
}

function myTeamCard(u) {
  const mgr = managerOf(u);
  const reps = reportsOf(u.id);
  return `<div class="card"><div class="row between"><h2>My team</h2><button class="link" data-act="tab" data-id="org">Org chart</button></div>
    <div class="shift"><span class="muted small">Reports to</span><span>${mgr ? `<strong>${esc(mgr.name)}</strong> <span class="muted small">${esc(mgr.role)}</span>` : 'No one (top of the chart)'}</span></div>
    ${reps.length ? `<div class="shift"><span class="muted small">Direct reports</span><span class="small" style="text-align:right">${reps.map(r => esc(r.name)).join(', ')}</span></div>` : ''}</div>`;
}

function viewTeam() {
  const org = ui.teamView === 'org';
  return `<div class="row between" style="margin-bottom:12px"><h1 style="margin:0">Team</h1><button class="primary" data-act="add-staff">Add staff</button></div>
  <div class="seg" role="group" aria-label="Team view">
    <button data-act="team-view" data-v="list" aria-pressed="${!org}">People</button>
    <button data-act="team-view" data-v="org" aria-pressed="${org}">Org chart</button>
  </div>
  ${org ? `<div class="card">${orgChart()}</div>` : `
  <p class="small muted">Groups decide which courses each person must complete. Providers also need coverage for time off, and Billing and Staff clock in.</p>
  ${Object.entries(GROUPS).map(([g, label]) => {
    const people = db.staff.filter(s => s.group === g).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="card"><div class="row between"><h2 style="margin:0">${label}</h2><span class="badge">${people.length}</span></div>
      ${people.length ? people.map(s => `<div class="shift"><div><strong>${esc(s.name)}</strong>${s.admin ? ' <span class="badge">Manages app</span>' : ''}<br>
        <span class="muted small">${esc(s.role)}${s.admin ? '' : ' · ' + (snfsOf(s.id).map(x => esc(x.name)).join(', ') || 'no SNF')}
          · ${managerOf(s) ? `reports to ${esc(managerOf(s).name)}` : 'top of org chart'}</span>
        ${s.phone || s.email || s.hired ? `<br><span class="small">${[
          s.phone && `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>`,
          s.email && `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`,
          s.hired && `Hired ${fmtDay(s.hired)}`
        ].filter(Boolean).join(' · ')}</span>` : ''}</div>
        <div class="row"><button data-act="edit-staff" data-id="${s.id}">Edit</button>${s.admin ? '' : `<button class="danger" data-act="remove-staff" data-id="${s.id}">Remove</button>`}</div></div>`).join('')
        : '<p class="muted small" style="margin:.4rem 0 0">Nobody in this group.</p>'}</div>`;
  }).join('')}`}
  <div class="card"><h2>Demo data</h2><p class="small muted">Everything is stored only in this browser. SNF names are placeholders.</p><button class="danger" data-act="reset">Reset demo data</button></div>`;
}

function staffDialog(s) {
  const isNew = !s;
  const customRole = !!s && !ROLES.includes(s.role);
  const blocked = s ? new Set([s.id, ...descendantsOf(s.id)]) : new Set();
  openDialog(isNew ? 'Add staff' : 'Edit staff', `
    <div class="field"><label for="s-name">Name</label><input id="s-name" name="name" value="${esc(s?.name)}" required></div>
    <div class="field"><label for="s-role">Job title</label><select id="s-role" name="role">
        ${ROLES.map(r => `<option ${r === s?.role ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        <option value="${OTHER_ROLE}" ${customRole ? 'selected' : ''}>Other (type a job title)…</option></select>
      <div class="custom-title"><label for="s-role-other" class="small">Job title</label>
        <input id="s-role-other" name="roleOther" value="${customRole ? esc(s.role) : ''}" placeholder="For example: Practice Administrator" maxlength="60"></div></div>
    <div class="field"><label for="s-group">Group</label><select id="s-group" name="group" required>
      ${isNew ? '<option value="">Choose a group…</option>' : ''}
      ${Object.entries(GROUPS).map(([g, label]) => `<option value="${g}" ${g === s?.group ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label for="s-mgr">Reports to</label>
      <p class="small muted hint">Where ${isNew ? 'they belong' : 'they sit'} in the org chart.</p>
      <select id="s-mgr" name="managerId" required>
        ${isNew ? '<option value="">Choose…</option>' : ''}
        <option value="${TOP}" ${s && !s.managerId ? 'selected' : ''}>No one (top of the org chart)</option>
        ${db.staff.filter(x => !blocked.has(x.id)).sort(byName).map(x => `<option value="${x.id}" ${x.id === s?.managerId ? 'selected' : ''}>${esc(x.name)} · ${esc(x.role)}</option>`).join('')}
      </select></div>
    ${isNew && db.staff.length ? `<details class="field"><summary class="small">Will anyone report to them? (optional)</summary>
      <p class="small muted hint" style="margin-top:.4rem">Use this when the new person takes over an existing team.</p>
      ${db.staff.slice().sort(byName).map(x => `<div class="check"><input type="checkbox" id="dr-${x.id}" name="reports" value="${x.id}">
        <label for="dr-${x.id}">${esc(x.name)} <span class="muted small">· now reports to ${esc(managerOf(x)?.name ?? 'no one')}</span></label></div>`).join('')}
    </details>` : ''}
    <div class="grid2">
      <div class="field"><label for="s-phone">Phone</label><input id="s-phone" name="phone" type="tel" value="${esc(s?.phone)}" autocomplete="off"></div>
      <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" value="${esc(s?.email)}" autocomplete="off"></div>
    </div>
    <div class="field"><label for="s-addr">Address</label><textarea id="s-addr" name="address" rows="2" autocomplete="off">${esc(s?.address)}</textarea></div>
    <div class="grid2">
      <div class="field"><label for="s-dob">Date of birth</label><input id="s-dob" name="dob" type="date" value="${esc(s?.dob)}" max="${today()}"></div>
      <div class="field"><label for="s-hired">Date of employment</label><input id="s-hired" name="hired" type="date" value="${esc(s?.hired)}"></div>
    </div>
    ${isNew ? '<p class="small muted">Assign them to SNFs from the SNFs tab.</p>' : ''}`, {
    onSubmit: fd => {
      const str = k => String(fd.get(k) || '').trim();
      if (str('dob') && str('hired') && str('hired') < str('dob')) { alert('Date of employment must be after date of birth.'); return false; }
      const role = fd.get('role') === OTHER_ROLE ? str('roleOther') : fd.get('role');
      if (!role) { alert('Type a job title, or pick one from the list.'); $('#s-role-other').focus(); return false; }
      const managerId = fd.get('managerId') === TOP ? null : fd.get('managerId');
      const patch = {
        name: str('name'), role, group: fd.get('group'), managerId,
        phone: str('phone'), email: str('email'), address: str('address'), dob: str('dob'), hired: str('hired')
      };
      if (isNew) {
        const reports = fd.getAll('reports');
        // Their new reports can't include anyone above them, or the chart would loop.
        const above = new Set();
        for (let m = userOf(managerId); m && !above.has(m.id); m = managerOf(m)) above.add(m.id);
        const loop = reports.filter(id => above.has(id));
        if (loop.length) { alert(`${loop.map(userName).join(', ')} can't report to them, because they're above them in the chart.`); return false; }
        const id = uid();
        db.staff.push({ id, ...patch });
        reports.forEach(r => { userOf(r).managerId = id; });
      } else {
        if (s.group === 'provider' && patch.group !== 'provider' &&
          db.requests.some(r => r.status === 'approved' && r.to >= today() && r.coverage.some(c => c.coverId === s.id)) &&
          !confirm(`${s.name} is covering other providers' patients. Moving them out of Providers keeps those assignments, so reassign them if needed. Continue?`)) return false;
        Object.assign(s, patch);
      }
      save(); toast(isNew ? 'Staff added' : 'Staff updated');
    }
  });
}

/** Removing someone also closes their gap in the org chart: their direct reports move to whoever the admin picks. */
function removeStaffDialog(s) {
  const reports = reportsOf(s.id);
  const mgr = managerOf(s);
  // A direct report can be promoted into the spot; anyone deeper would create a loop.
  const deeper = new Set([...descendantsOf(s.id)].filter(id => !reports.some(r => r.id === id)));
  const options = db.staff.filter(x => x.id !== s.id && !deeper.has(x.id)).sort(byName);
  openDialog(`Remove ${s.name}?`, `
    <p>Their time-off requests are deleted, any patients they were covering are flagged for new coverage, and they're taken off the org chart.</p>
    ${reports.length ? `<div class="field"><label for="rm-mgr">${reports.length} ${reports.length > 1 ? 'people report' : 'person reports'} to ${esc(s.name)}. Who should they report to now?</label>
      <p class="small muted hint">${reports.map(r => esc(r.name)).join(', ')}. Pick one of them to promote them into ${esc(s.name)}'s spot.</p>
      <select id="rm-mgr" name="to" required>
        <option value="${mgr?.id ?? TOP}" selected>${mgr ? `${esc(mgr.name)} (${esc(s.name)}'s manager)` : 'No one (top of the org chart)'}</option>
        ${mgr ? `<option value="${TOP}">No one (top of the org chart)</option>` : ''}
        ${options.filter(x => x.id !== mgr?.id).map(x => `<option value="${x.id}">${esc(x.name)}${reports.some(r => r.id === x.id) ? ' (promote)' : ''}</option>`).join('')}
      </select></div>` : ''}`, {
    okLabel: 'Remove',
    onSubmit: fd => {
      const to = !reports.length || fd.get('to') === TOP ? null : fd.get('to');
      const promoted = reports.find(r => r.id === to);
      if (promoted) promoted.managerId = s.managerId ?? null;
      reports.filter(r => r !== promoted).forEach(r => { r.managerId = to; });
      db.requests = db.requests.filter(r => r.userId !== s.id);
      db.requests.forEach(r => r.coverage.forEach(c => { if (c.coverId === s.id) c.coverId = null; }));
      db.snfs.forEach(n => { n.staff = n.staff.filter(id => id !== s.id); });
      db.staff = db.staff.filter(x => x.id !== s.id);
      save(); toast(`${s.name} removed${reports.length ? ' and the org chart updated' : ''}`);
    }
  });
}

/* ---------- checklists (shown on the Forms tab) ---------- */
function checklistsCard() {
  const admin = isAdmin();
  const runsToday = db.runs.filter(r => r.date === today());
  return `<div class="card"><div class="row between"><h2>Checklists</h2>${admin ? '<button data-act="new-template">New checklist</button>' : ''}</div>
    ${db.templates.map(t => {
      const done = runsToday.filter(r => r.templateId === t.id && r.done);
      return `<div class="shift"><div><strong>${esc(t.name)}</strong><br><span class="muted small">${t.items.length} items${admin ? ` · ${done.length ? 'completed today by ' + done.map(r => esc(userName(r.userId))).join(', ') : 'not completed today'}` : ''}</span></div>
        <button data-act="run-checklist" data-id="${t.id}">${admin ? 'Open' : done.some(r => r.userId === ui.userId) ? 'View' : 'Start'}</button></div>`;
    }).join('')}</div>`;
}

function checklistDialog(t) {
  let run = db.runs.find(r => r.templateId === t.id && r.userId === ui.userId && r.date === today());
  const locked = run?.done;
  const checked = run?.checked ?? {};
  const readOnly = locked || isAdmin();
  const body = `<div>${t.items.map((it, i) => `<div class="check"><input type="checkbox" id="ck${i}" name="ck${i}" ${checked[i] ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>
    <label for="ck${i}">${esc(it)}</label></div>`).join('')}</div>
    ${locked ? `<p class="small muted" style="margin-top:.6rem">Completed at ${new Date(run.doneAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>` : ''}`;
  const collect = fd => {
    run ??= (db.runs.push(run = { id: uid(), templateId: t.id, userId: ui.userId, date: today(), checked: {}, done: false }), run);
    run.checked = Object.fromEntries(t.items.map((_, i) => [i, fd.get('ck' + i) === 'on']));
  };
  openDialog(t.name, body, readOnly ? {} : {
    okLabel: 'Save progress',
    extra: '<button value="complete" formnovalidate class="primary">Mark complete</button>',
    onSubmit: fd => { collect(fd); save(); toast('Progress saved'); },
    onClose: (rv, fd) => {
      if (rv !== 'complete') return;
      collect(fd);
      const missing = t.items.filter((_, i) => !run.checked[i]).length;
      if (missing) toast(`${missing} item(s) still unchecked, progress saved`);
      else { run.done = true; run.doneAt = new Date().toISOString(); toast('Checklist complete'); }
      save();
    }
  });
}

function templateDialog() {
  openDialog('New checklist', `
    <div class="field"><label for="t-name">Name</label><input id="t-name" name="name" required></div>
    <div class="field"><label for="t-items">Items (one per line)</label><textarea id="t-items" name="items" required></textarea></div>`, {
    onSubmit: fd => {
      const items = String(fd.get('items')).split('\n').map(x => x.trim()).filter(Boolean);
      if (!items.length) return false;
      db.templates.push({ id: uid(), name: String(fd.get('name')).trim(), items });
      save(); toast('Checklist created');
    }
  });
}

/* ---------- actions ---------- */
const reqById = id => db.requests.find(r => r.id === id);

const actions = {
  login: b => { ui.userId = b.dataset.id; ui.tab = me().admin ? 'calendar' : 'home'; try { sessionStorage.setItem('fpp-user', ui.userId); } catch { /* ignore */ } },
  logout: () => { ui.userId = null; ui.play = null; ui.form = null; try { sessionStorage.removeItem('fpp-user'); } catch { /* ignore */ } },
  tab: b => {
    if (ui.form?.dirty && !confirm('Discard the form you were filling out?')) return false;
    ui.tab = b.dataset.id; ui.play = null; ui.form = null;
  },
  month: b => { ui.month = addMonths(ui.month, +b.dataset.d); },
  'month-today': () => { ui.month = monthStart(today()); },
  'cal-export': () => { calendarExportDialog(); return false; },
  day: b => { dayDialog(b.dataset.date); return false; },
  week: b => { ui.week = addDays(ui.week, +b.dataset.d); },
  clockin: () => {
    if (!openEntry(ui.userId)) db.time.push({ id: uid(), userId: ui.userId, in: new Date().toISOString(), out: null });
    save(); toast('Clocked in');
  },
  clockout: () => {
    const e = openEntry(ui.userId);
    if (e) { e.out = new Date().toISOString(); save(); toast(`Clocked out · ${hrs(entryHours(e))} h`); }
  },
  'punch-fix': b => { punchFixDialog(db.time.find(e => e.id === b.dataset.id)); return false; },
  'review-fix': b => { punchFixReviewDialog(db.punchFixes.find(f => f.id === b.dataset.id)); return false; },
  'add-entry': () => { entryDialog(null); return false; },
  'edit-entry': b => { entryDialog(db.time.find(e => e.id === b.dataset.id)); return false; },
  'export-csv': () => { exportCsv(); return false; },
  'new-timeoff': () => { timeOffDialog(); return false; },
  review: b => { reviewDialog(reqById(b.dataset.id)); return false; },
  'fix-cover': b => { fixCoverDialog(reqById(b.dataset.id), b.dataset.snf); return false; },
  'cancel-req': b => { reqById(b.dataset.id).status = 'cancelled'; save(); toast('Request cancelled'); },
  'cancel-approved': b => {
    const r = reqById(b.dataset.id);
    if (!confirm(`Cancel ${userName(r.userId)}'s approved time off (${fmtRange(r.from, r.to)})? Coverage is removed.`)) return false;
    r.status = 'cancelled'; r.coverage = []; save(); toast('Time off cancelled');
  },
  'new-snf': () => { snfDialog(null); return false; },
  'edit-snf': b => { snfDialog(db.snfs.find(s => s.id === b.dataset.id)); return false; },
  'run-checklist': b => { checklistDialog(db.templates.find(t => t.id === b.dataset.id)); return false; },
  'new-template': () => { templateDialog(); return false; },
  'add-staff': () => { staffDialog(null); return false; },
  'edit-staff': b => { staffDialog(userOf(b.dataset.id)); return false; },
  'remove-staff': b => { removeStaffDialog(userOf(b.dataset.id)); return false; },
  'team-view': b => { ui.teamView = b.dataset.v; },
  reset: () => {
    if (!confirm('Erase all demo data and start over?')) return false;
    db = seed(); addSeedOnCall(); save();
  }
};

Object.assign(actions, courseActions, formActions, regionActions, oncallActions);

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const fn = actions[b.dataset.act];
  if (fn && fn(b) !== false) render();
});

document.addEventListener('change', e => {
  if (e.target.id === 'snf-filter') { ui.snf = e.target.value; render(); }
  if (e.target.id === 'pf-entry') {
    // Prefill the punch fix times from the chosen punch.
    const x = db.time.find(t => t.id === e.target.value);
    $('#pf-in').value = x ? localInput(x.in) : '';
    $('#pf-out').value = x?.out ? localInput(x.out) : '';
  }
});

/* ---------- render ---------- */
function render() {
  if (ui.userId && !me()) ui.userId = null;
  const scrollY = ui.resetScroll ? 0 : window.scrollY;
  ui.resetScroll = false;
  $('#app').innerHTML = ui.userId ? renderShell() : renderLogin();
  window.scrollTo(0, scrollY);
}

// Older data predates the on-call schedule: add the on-call NP and draft this month and next.
// Runs here, not with the other migrations, because drafting needs the helpers defined above.
if (!db.oncallSettings) { addSeedOnCall(); save(); }

render();

setInterval(() => {
  const el = $('#live-clock');
  if (el) el.textContent = fmtClock(new Date().toISOString());
}, 15000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
