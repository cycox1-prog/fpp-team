'use strict';
/* On-call schedule. Each date has one after-hours shift starting at 5pm:
     Sun–Thu  "night"  5pm–5am, the full-time on-call NP by default
     Fri      "wkd1"   Fri 5pm–Sat 5pm, weekend rotation (one provider for the practice)
     Sat      "wkd2"   Sat 5pm–Sun 5pm, weekend rotation
   Weekday daytime (5am–5pm) isn't scheduled here: it's the providers assigned to each SNF, plus time-off coverage.
   Loaded before app.js; everything here runs at call time, so app.js globals (db, ui, esc, …) are available. */

const SHIFTS = {
  night: { label: 'Weeknight', time: '5pm–5am', csv: 'Weeknight (5pm-5am)' },
  wkd1: { label: 'Fri–Sat', time: 'Fri 5pm–Sat 5pm', csv: 'Fri-Sat (Fri 5pm-Sat 5pm)' },
  wkd2: { label: 'Sat–Sun', time: 'Sat 5pm–Sun 5pm', csv: 'Sat-Sun (Sat 5pm-Sun 5pm)' }
};
const ONCALL_NP_ID = 'u8';

const OC = () => db.oncallSettings;
const shiftFor = d => ({ 5: 'wkd1', 6: 'wkd2' }[parseYmd(d).getDay()] ?? 'night');
/** Calendar days a shift touches, for checking time off. A night ends at 5am, so only its start date counts. */
const shiftDays = (d, shift) => shift === 'night' ? [d] : [d, addDays(d, 1)];
const entryFor = (d, shift = shiftFor(d)) => db.oncall.find(e => e.date === d && e.shift === shift);
/** Who is on call for a date's shift. Weeknights fall back to the on-call NP when nothing was scheduled. */
function assignee(d, shift = shiftFor(d)) {
  const e = entryFor(d, shift);
  if (e) return e.userId;
  return shift === 'night' ? OC().nightNp ?? null : null;
}
const offDuring = (userId, d, shift) => shiftDays(d, shift).some(x => approvedOff(userId, x, x).length);
const providers = () => db.staff.filter(isProvider).sort(byName);

function setEntry(d, shift, userId, source) {
  db.oncall = db.oncall.filter(e => !(e.date === d && e.shift === shift));
  db.oncall.push({ date: d, shift, userId: userId || null, source, updated: new Date().toISOString() });
}

/** Problems in [from, to]: unassigned shifts and people on call during their own approved time off. */
function oncallIssues(from, to) {
  return eachDay(from, to).flatMap(d => {
    const shift = shiftFor(d);
    const who = assignee(d, shift);
    if (!who || !userOf(who)) return [{ d, shift, kind: 'open', text: `${SHIFTS[shift].label} ${fmtDay(d)} has nobody on call` }];
    if (offDuring(who, d, shift)) return [{ d, shift, kind: 'conflict', text: `${userName(who)} is on call ${SHIFTS[shift].label} ${fmtDay(d)} but has approved time off` }];
    return [];
  });
}

/* ---------- weekend rotation draft ---------- */
/** Fill a month's shifts: nights to the on-call NP, weekends in rotation order skipping anyone off. */
function draftMonth(first, overwrite) {
  const rot = OC().rotation.filter(id => isProvider(userOf(id)));
  const last = db.oncall.filter(e => e.shift !== 'night' && e.date < first && e.userId).sort((a, b) => b.date.localeCompare(a.date))[0];
  let idx = last ? rot.indexOf(last.userId) + 1 : 0;
  let prev = last?.userId ?? null;
  let filled = 0;
  for (const d of eachDay(first, monthEnd(first))) {
    const shift = shiftFor(d);
    const existing = entryFor(d, shift);
    if (existing && !overwrite) {
      if (shift !== 'night' && existing.userId) { prev = existing.userId; const i = rot.indexOf(prev); if (i >= 0) idx = i + 1; }
      continue;
    }
    if (shift === 'night') {
      const np = OC().nightNp;
      setEntry(d, shift, np && userOf(np) && !offDuring(np, d, shift) ? np : null, 'draft');
    } else {
      let pick = null;
      for (let k = 0; k < rot.length; k++) {
        const id = rot[(idx + k) % rot.length];
        if (id !== prev && !offDuring(id, d, shift)) { pick = id; idx = (idx + k + 1) % rot.length; break; }
      }
      setEntry(d, shift, pick, 'draft');
      prev = pick;
    }
    filled++;
  }
  return filled;
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
}

function parseDate(s) {
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return ymd(new Date(+m[1], m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) return ymd(new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[1] - 1, +m[2]));
  return null;
}

function parseShift(s, d) {
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (!t) return shiftFor(d);
  if (t.startsWith('fri') || t === 'wkd1') return 'wkd1';
  if (t.startsWith('sat') || t === 'wkd2') return 'wkd2';
  if (t.includes('night') || t.includes('5pm-5am') || t === 'weekday') return 'night';
  return null;
}

/** "Dr. Samuel Nguyen", "Samuel Nguyen MD" and "samuel nguyen" all become "samuel nguyen". */
const CREDENTIALS = new Set(['dr', 'md', 'do', 'np', 'aprn', 'fnp', 'agnp', 'dnp', 'pa', 'pac', 'rn', 'mba', 'phd']);
const normName = s => s.toLowerCase().replace(/[^a-z ,]/g, '').split(/[\s,]+/).filter(w => w && !CREDENTIALS.has(w)).join(' ');

/** Match a provider by full name, email, or a unique last name. */
function matchProvider(s) {
  const n = normName(s);
  const all = providers();
  return all.find(p => normName(p.name) === n) || all.find(p => p.email && p.email.toLowerCase() === s.toLowerCase())
    || (all.filter(p => normName(p.name).split(' ').pop() === n).length === 1 ? all.find(p => normName(p.name).split(' ').pop() === n) : null);
}

function analyzeCsv(text) {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map(h => h.toLowerCase());
  const col = names => head.findIndex(h => names.some(n => h.includes(n)));
  const ci = { date: col(['date']), shift: col(['shift']), who: col(['provider', 'on call', 'on-call', 'name']) };
  if (ci.date < 0 || ci.who < 0) return { fatal: 'The first row must be headers including "Date" and "Provider". Download the template to see the format.' };
  const ok = [], errors = [], warnings = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const d = parseDate(r[ci.date] ?? '');
    if (!d) { errors.push(`Row ${line}: "${r[ci.date] ?? ''}" isn't a date (use YYYY-MM-DD or M/D/YYYY).`); return; }
    const shift = parseShift(ci.shift >= 0 ? r[ci.shift] ?? '' : '', d);
    if (!shift) { errors.push(`Row ${line}: unknown shift "${r[ci.shift]}".`); return; }
    if (shift !== shiftFor(d)) { errors.push(`Row ${line}: ${fmtDay(d)} has a ${SHIFTS[shiftFor(d)].label} shift, not ${SHIFTS[shift].label}.`); return; }
    const name = r[ci.who] ?? '';
    const p = name ? matchProvider(name) : null;
    if (name && !p) { errors.push(`Row ${line}: no provider named "${name}".`); return; }
    if (p && offDuring(p.id, d, shift)) warnings.push(`${p.name} has approved time off during ${SHIFTS[shift].label} ${fmtDay(d)}.`);
    if (!p) warnings.push(`${SHIFTS[shift].label} ${fmtDay(d)} is left unassigned.`);
    ok.push({ d, shift, userId: p?.id ?? null });
  });
  const months = [...new Set(ok.map(x => x.d.slice(0, 7)))].sort();
  return { ok, errors, warnings, months };
}

function importPreviewDialog(text, fileName) {
  const res = analyzeCsv(text);
  if (res.fatal) { alert(res.fatal); return; }
  const list = (items, cls) => items.slice(0, 12).map(t => `<p class="small conflict ${cls}" style="margin:0 0 .3rem">${esc(t)}</p>`).join('')
    + (items.length > 12 ? `<p class="small muted">…and ${items.length - 12} more.</p>` : '');
  openDialog('Import on-call schedule', `
    <p><strong>${esc(fileName)}</strong><br><span class="small">${res.ok.length} shift${res.ok.length === 1 ? '' : 's'} ready
      ${res.months.length ? ` for ${res.months.map(monthLabel).join(', ')}` : ''}.</span></p>
    ${res.errors.length ? `<h3>${res.errors.length} row${res.errors.length === 1 ? '' : 's'} can't be imported</h3>${list(res.errors, 'bad')}` : ''}
    ${res.warnings.length ? `<h3>Check these</h3>${list(res.warnings, '')}` : ''}
    ${!res.errors.length && !res.warnings.length ? '<p class="small">✅ Everything matched and nobody is on call during their time off.</p>' : ''}
    <p class="small muted">Importing replaces these dates' on-call assignments. Other dates aren't changed.</p>`, {
    wide: true, okLabel: `Import ${res.ok.length} shifts`,
    onSubmit: () => {
      if (!res.ok.length) return false;
      res.ok.forEach(x => setEntry(x.d, x.shift, x.userId, 'csv'));
      if (res.months.length) ui.month = res.months[0] + '-01';
      save(); toast(`Imported ${res.ok.length} on-call shifts`);
    }
  });
}

function downloadTemplate() {
  const lines = [['Date', 'Day', 'Shift', 'Provider']];
  eachDay(ui.month, monthEnd(ui.month)).forEach(d => {
    const shift = shiftFor(d);
    lines.push([d, parseYmd(d).toLocaleDateString('en-US', { weekday: 'long' }), SHIFTS[shift].csv, userOf(assignee(d, shift))?.name ?? '']);
  });
  const csv = lines.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `on-call-${ui.month.slice(0, 7)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.addEventListener('change', async e => {
  if (e.target.id !== 'oc-file' || !e.target.files[0]) return;
  const file = e.target.files[0];
  e.target.value = '';
  importPreviewDialog(await file.text(), file.name);
});

/* ---------- calendar ---------- */
function viewOnCall() {
  const first = ui.month, last = monthEnd(first);
  const issues = oncallIssues(first, last);
  const gridStart = mondayOf(first), gridEnd = addDays(mondayOf(last), 6);
  const cells = eachDay(gridStart, gridEnd).map(d => {
    const shift = shiftFor(d);
    const who = assignee(d, shift);
    const problem = issues.find(x => x.d === d);
    const mine = who && who === ui.userId;
    const label = shift === 'night' ? '🌙' : SHIFTS[shift].label;
    const cls = ['day', d.slice(0, 7) !== first.slice(0, 7) ? 'other' : '', d === today() ? 'today' : ''].join(' ');
    const chip = who && userOf(who)
      ? `<span class="oc ${shift}${problem ? ' need' : ''}${mine ? ' mine' : ''}">${label} ${esc(shortName(userName(who)))}${problem ? ' ⚠' : ''}</span>`
      : `<span class="oc need">${label} ⚠ open</span>`;
    return `<button class="${cls}" data-act="oc-day" data-date="${d}" aria-label="${esc(`${fmtDay(d)}: ${SHIFTS[shift].label} on call ${who ? userName(who) : 'nobody'}`)}">
      <span class="num">${+d.slice(8)}</span>${chip}</button>`;
  });
  const u = me();
  return `<div class="row between" style="margin-bottom:12px">
      <button data-act="month" data-d="-1" aria-label="Previous month">‹</button>
      <h1 style="margin:0">${fmtMonth(first)}</h1>
      <button data-act="month" data-d="1" aria-label="Next month">›</button></div>
    ${isAdmin() ? `<div class="row" style="margin-bottom:12px">
      <button data-act="oc-import">Import CSV</button><input type="file" id="oc-file" accept=".csv,text/csv" hidden>
      <button data-act="oc-template">Download template</button>
      <button data-act="oc-draft">Draft rotation</button>
      <span class="grow"></span><button data-act="oc-settings">On-call settings</button></div>` : ''}
    ${issues.length ? `<div class="card"><h2>Needs attention (${issues.length})</h2>
      ${issues.map(x => `<div class="shift"><span class="small">${x.kind === 'open' ? '⛔' : '⚠️'} ${esc(x.text)}</span>
        ${isAdmin() ? `<button data-act="oc-day" data-date="${x.d}">Fix</button>` : ''}</div>`).join('')}</div>` : ''}
    <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="hd">${d}</div>`).join('')}${cells.join('')}</div>
    <p class="small muted legend"><span class="oc night">🌙</span> weeknight ${SHIFTS.night.time} · <span class="oc wkd1">Fri–Sat</span> ${SHIFTS.wkd1.time} ·
      <span class="oc wkd2">Sat–Sun</span> ${SHIFTS.wkd2.time}${isProvider(u) ? ' · <span class="oc mine">yours</span>' : ''}.
      Weekdays 5am–5pm are covered by each SNF's providers. ${isAdmin() ? 'Select a day to change who is on call.' : 'Select a day for details.'}</p>`;
}

function onCallDayDialog(d) {
  const shift = shiftFor(d);
  const who = assignee(d, shift);
  const dow = parseYmd(d).getDay();
  const admin = isAdmin();
  const off = requestsOn(d, { includePending: false, snf: '' }).filter(r => isProvider(userOf(r.userId)));
  let daytime;
  const nameOr = id => (id && userOf(id)?.name) || 'nobody';
  if (dow === 6) daytime = `Covered by the Fri–Sat on-call: <strong>${esc(nameOr(assignee(addDays(d, -1), 'wkd1')))}</strong>`;
  else if (dow === 0) daytime = `Covered by the Sat–Sun on-call: <strong>${esc(nameOr(assignee(addDays(d, -1), 'wkd2')))}</strong>`;
  else {
    daytime = db.snfs.slice().sort((a, b) => (a.region ?? 99) - (b.region ?? 99) || byName(a, b)).map(s => {
      const st = snfStatus(s, d);
      const names = st.ps.map(x => x.state === 'in' ? esc(shortName(x.p.name)) : x.state === 'covered' ? `${esc(shortName(x.cover.name))} <span class="muted">(for ${esc(shortName(x.p.name))})</span>` : '').filter(Boolean);
      return `<div class="shift small"><span>${esc(s.name)}</span><span style="text-align:right">${names.join(', ')}
        ${needsAttention(st.state) ? ` <span class="badge bad">${SNF_STATE[st.state][0]}</span>` : ''}</span></div>`;
    }).join('');
  }
  const options = providers().map(p => {
    const out = offDuring(p.id, d, shift);
    return `<option value="${p.id}" ${p.id === who ? 'selected' : ''}>${esc(p.name)}${p.id === OC().nightNp ? ' · on-call NP' : ''}${out ? ' · has time off' : ''}</option>`;
  }).join('');
  const problem = oncallIssues(d, d)[0];
  openDialog(fmtDay(d), `
    <h3>${SHIFTS[shift].label} on call · ${SHIFTS[shift].time}</h3>
    ${problem ? `<p class="conflict ${problem.kind === 'open' ? 'bad' : ''}">${problem.kind === 'open' ? '⛔' : '⚠️'} ${esc(problem.text)}</p>` : ''}
    ${admin ? `<div class="field"><label for="oc-who">On call</label><select id="oc-who" name="who">
        <option value="">Nobody (unassigned)</option>${options}</select></div>`
      : `<p><strong>${who ? esc(userName(who)) : 'Nobody assigned'}</strong>${who === ui.userId ? ' <span class="badge">You</span>' : ''}</p>`}
    ${entryFor(d, shift) ? `<p class="small muted">${{ csv: 'Imported from CSV', draft: 'From the drafted rotation', manual: 'Set by hand' }[entryFor(d, shift).source] ?? ''}.</p>` : ''}
    <h3 style="margin-top:1rem">Daytime 5am–5pm</h3>${daytime}
    ${off.length ? `<h3 style="margin-top:1rem">Providers off</h3><p class="small">${off.map(r => esc(userName(r.userId))).join(', ')}</p>` : ''}`, admin ? {
    wide: true, okLabel: 'Save',
    onSubmit: fd => {
      const id = fd.get('who');
      if (id && offDuring(id, d, shift) && !confirm(`${userName(id)} has approved time off during this shift. Assign anyway?`)) return false;
      setEntry(d, shift, id, 'manual');
      save(); toast('On-call updated');
    }
  } : { wide: true });
}

function onCallSettingsDialog() {
  const st = OC();
  openDialog('On-call settings', `
    <div class="field"><label for="oc-np">Full-time on-call NP (weeknights, 5pm–5am)</label><select id="oc-np" name="np">
      <option value="">None</option>${providers().map(p => `<option value="${p.id}" ${p.id === st.nightNp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <fieldset><legend>Weekend rotation</legend>
      <p class="small muted hint">Providers take weekend shifts in this order, skipping anyone with approved time off. The draft continues from the last weekend already scheduled.</p>
      ${providers().map(p => `<div class="check"><input type="checkbox" id="rot-${p.id}" name="rot" value="${p.id}" ${st.rotation.includes(p.id) ? 'checked' : ''}>
        <label for="rot-${p.id}">${esc(p.name)}</label></div>`).join('')}</fieldset>`, {
    onSubmit: fd => {
      const rot = fd.getAll('rot');
      if (!rot.length) { alert('Pick at least one provider for the weekend rotation.'); return false; }
      Object.assign(st, { nightNp: fd.get('np') || null, rotation: providers().map(p => p.id).filter(id => rot.includes(id)) });
      save(); toast('On-call settings saved');
    }
  });
}

/** Home card for providers: their on-call shifts in the next 30 days. */
function myOnCallCard(u) {
  if (!isProvider(u)) return '';
  const mine = eachDay(today(), addDays(today(), 30)).filter(d => assignee(d) === u.id);
  return `<div class="card"><div class="row between"><h2>My on-call</h2><button class="link" data-act="oc-open">On-call calendar</button></div>
    ${mine.length ? mine.slice(0, 8).map(d => `<div class="shift small"><span>${fmtDay(d)}</span><span>${SHIFTS[shiftFor(d)].label} · ${SHIFTS[shiftFor(d)].time}</span></div>`).join('')
      + (mine.length > 8 ? `<p class="small muted">…and ${mine.length - 8} more.</p>` : '')
      : '<p class="muted small">No on-call shifts in the next 30 days.</p>'}</div>`;
}

/** On-call shifts a time-off request would collide with, for the approval screen. */
const oncallClashes = (userId, from, to) => eachDay(addDays(from, -1), to)
  .filter(d => assignee(d) === userId && shiftDays(d, shiftFor(d)).some(x => x >= from && x <= to));

/* ---------- sample data ---------- */
function addSeedOnCall() {
  if (!db.staff.some(u => u.id === ONCALL_NP_ID)) {
    // Hired today so the End of Day tracker doesn't count past days against her.
    db.staff.push({ id: ONCALL_NP_ID, name: 'Rachel Kim, NP', role: 'Nurse Practitioner', group: 'provider', hired: today(),
      managerId: db.staff.some(u => u.id === 'u1') ? 'u1' : null });
  }
  db.oncall = [];
  db.oncallSettings = { nightNp: ONCALL_NP_ID, rotation: providers().map(p => p.id).filter(id => id !== ONCALL_NP_ID) };
  draftMonth(monthStart(today()), true);
  draftMonth(addMonths(monthStart(today()), 1), true);
}

const oncallActions = {
  'cal-view': b => { ui.calView = b.dataset.v; },
  'oc-open': () => { ui.tab = 'calendar'; ui.calView = 'oncall'; },
  'oc-day': b => { onCallDayDialog(b.dataset.date); return false; },
  'oc-import': () => { $('#oc-file').click(); return false; },
  'oc-template': () => { downloadTemplate(); return false; },
  'oc-settings': () => { onCallSettingsDialog(); return false; },
  'oc-draft': () => {
    const first = ui.month;
    const has = eachDay(first, monthEnd(first)).some(d => entryFor(d));
    const overwrite = has && confirm(`${fmtMonth(first)} already has on-call assignments.\n\nOK: replace them all with a fresh draft.\nCancel: only fill the empty shifts.`);
    const n = draftMonth(first, overwrite);
    save(); toast(n ? `Drafted ${n} shifts for ${fmtMonth(first)}` : 'Every shift was already assigned');
  }
};
