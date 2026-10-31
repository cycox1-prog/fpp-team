'use strict';
/* Regions: SNFs grouped into regions 1–6, shown as a regional chart with live provider coverage.
   Loaded before app.js; everything here runs at call time, so app.js globals (db, ui, esc, …) are available. */

const REGIONS = [1, 2, 3, 4, 5, 6];

/* ---------- sample data ---------- */
const SEED_REGIONS = { s1: 1, s2: 2, s3: 3 };
const EXTRA_SNFS = [
  { id: 's4', name: 'Seminole Gardens Rehab', address: 'Sanford, FL', region: 1, staff: ['u2', 'u4'] },
  { id: 's5', name: 'Gulfview Care Center', address: 'Clearwater, FL', region: 2, staff: ['u3'] },
  { id: 's6', name: 'St. Johns River Health & Rehab', address: 'St. Augustine, FL', region: 3, staff: ['u1', 'u3'] },
  { id: 's7', name: 'Sarasota Bay Nursing Center', address: 'Sarasota, FL', region: 4, staff: ['u4'] },
  { id: 's8', name: 'Treasure Coast Rehab', address: 'Port St. Lucie, FL', region: 5, staff: ['u2'] },
  { id: 's9', name: 'Everglades Health & Rehab', address: 'Fort Myers, FL', region: 6, staff: [] },
  { id: 's10', name: 'Naples Shores Care Center', address: 'Naples, FL', region: 6, staff: ['u1'] }
];

/** Gives the demo SNFs regions and adds sample SNFs so every region has something in it. */
function addSeedRegions(snfs, staffIds) {
  snfs.forEach(s => { if (!('region' in s)) s.region = SEED_REGIONS[s.id] ?? null; });
  EXTRA_SNFS.filter(x => !snfs.some(s => s.id === x.id))
    .forEach(x => snfs.push({ ...x, staff: x.staff.filter(id => staffIds.includes(id)) }));
}

/* ---------- coverage status ---------- */
/** One provider at one SNF on a date: in, out and covered, or out with nobody (available) covering. */
function providerStatus(p, snfId, d) {
  const off = approvedOff(p.id, d, d)[0];
  if (!off) return { state: 'in' };
  const c = off.coverage.find(x => x.snfId === snfId);
  const cover = c?.coverId ? userOf(c.coverId) : null;
  if (cover && !approvedOff(cover.id, d, d).length) return { state: 'covered', off, cover };
  return { state: 'gap', off, cover };
}

function snfStatus(s, d) {
  const ps = s.staff.map(userOf).filter(isProvider).sort(byName).map(p => ({ p, ...providerStatus(p, s.id, d) }));
  const state = !ps.length ? 'none' : ps.some(x => x.state === 'gap') ? 'gap' : ps.some(x => x.state === 'covered') ? 'covered' : 'ok';
  return { state, ps };
}

const SNF_STATE = {
  ok: ['All providers in', 'ok'],
  covered: ['Covered', 'warn'],
  gap: ['Coverage needed', 'bad'],
  none: ['No provider assigned', 'bad']
};
const needsAttention = state => state === 'gap' || state === 'none';

/* ---------- regional chart ---------- */
function snfNode(s, st) {
  const [label, cls] = SNF_STATE[st.state];
  const out = st.ps.filter(x => x.state !== 'in').length;
  return `<button class="snf-node st-${st.state}" data-act="snf-detail" data-id="${s.id}">
    <span class="snf-name">${esc(s.name)}</span>
    <span class="small muted">${st.ps.length} provider${st.ps.length === 1 ? '' : 's'}${out ? ` · ${out} out` : ''}</span>
    ${st.state !== 'ok' ? `<span class="badge ${cls}">${label}</span>` : ''}</button>`;
}

function viewRegions() {
  const d = ui.regionDate;
  const status = new Map(db.snfs.map(s => [s.id, snfStatus(s, d)]));
  const soon = coverageGaps().filter(g => g.req.from <= addDays(today(), 30)).sort((a, b) => a.req.from.localeCompare(b.req.from));
  const region = n => {
    const list = db.snfs.filter(s => s.region === n).sort(byName);
    const need = list.filter(s => needsAttention(status.get(s.id).state)).length;
    return `<li><div class="region-card${need ? ' has-gap' : ''}">
      <div class="region-head"><strong>Region ${n}</strong><span class="small muted">${list.length} SNF${list.length === 1 ? '' : 's'}</span>
        ${need ? `<span class="badge bad">${need} need${need === 1 ? 's' : ''} attention</span>` : ''}</div>
      <div class="snf-list">${list.length ? list.map(s => snfNode(s, status.get(s.id))).join('') : '<p class="small muted" style="margin:.3rem 0">No SNFs yet.</p>'}</div>
    </div></li>`;
  };
  const unassigned = db.snfs.filter(s => !REGIONS.includes(s.region)).sort(byName);
  return `
    <div class="row" style="margin-bottom:8px">
      <label for="region-date" style="margin:0">Coverage on</label>
      <input type="date" id="region-date" value="${d}" style="width:auto">
      ${d !== today() ? '<button data-act="region-today">Today</button>' : ''}
    </div>
    <p class="small muted legend"><span class="key st-ok">All providers in</span> <span class="key st-covered">Provider out, covered</span>
      <span class="key st-gap">Coverage needed</span> Select an SNF to see its providers.</p>
    ${soon.length ? `<div class="card"><h2>Coverage needed in the next 30 days</h2>
      ${soon.map(g => `<div class="shift"><div><strong>${esc(snfName(g.snfId))}</strong> · Region ${db.snfs.find(s => s.id === g.snfId)?.region ?? '—'}<br>
        <span class="small">${esc(userName(g.req.userId))} is out ${fmtRange(g.req.from, g.req.to)}</span></div>
        ${isAdmin() ? `<button class="primary" data-act="fix-cover" data-id="${g.req.id}" data-snf="${g.snfId}">Assign</button>` : '<span class="badge bad">Needs coverage</span>'}</div>`).join('')}</div>` : ''}
    <div class="card"><div class="org regions" role="tree" aria-label="Regional chart"><ul><li>
      <div class="org-card root"><img src="assets/icon.svg" alt="" width="40" height="40"><strong>Florida Physician Partners</strong>
        <span class="small muted">${db.snfs.length} SNFs in ${REGIONS.length} regions</span></div>
      <ul>${REGIONS.map(region).join('')}</ul>
    </li></ul></div></div>
    ${unassigned.length ? `<div class="card"><h2>Not in a region</h2>
      ${isAdmin() ? '<p class="small muted">Edit these SNFs to choose their region.</p>' : ''}
      <div class="snf-list">${unassigned.map(s => snfNode(s, status.get(s.id))).join('')}</div></div>` : ''}`;
}

function snfDetailDialog(s) {
  const d = ui.regionDate;
  const st = snfStatus(s, d);
  const [label, cls] = SNF_STATE[st.state];
  const admin = isAdmin();
  const others = s.staff.map(userOf).filter(u => u && !isProvider(u)).sort(byName);
  const gaps = coverageGaps().filter(g => g.snfId === s.id);
  const upcoming = db.requests.filter(r => r.status === 'approved' && r.to >= today() && r.from <= addDays(today(), 30) &&
    s.staff.includes(r.userId) && isProvider(userOf(r.userId))).sort((a, b) => a.from.localeCompare(b.from));
  const assign = req => admin ? ` <button value="cover:${req.id}" formnovalidate>Assign</button>` : '';
  const line = x => x.state === 'in' ? '<span class="badge ok">In</span>'
    : x.state === 'covered' ? `Out ${fmtRange(x.off.from, x.off.to)}<br><strong>${esc(x.cover.name)}</strong> sees patients`
    : `Out ${fmtRange(x.off.from, x.off.to)}<br><span class="badge bad">Coverage needed</span>${x.cover ? ` <span class="muted">(${esc(x.cover.name)} is also out)</span>` : ''}${assign(x.off)}`;
  openDialog(s.name, `
    <p class="small muted" style="margin-top:-.3rem">Region ${s.region ?? 'not set'}${s.address ? ` · ${esc(s.address)}` : ''}</p>
    <p><span class="badge ${cls}">${label}</span> <span class="small">on ${fmtDay(d)}</span></p>
    <h3>Providers</h3>
    ${st.ps.length ? st.ps.map(x => `<div class="shift"><div><strong>${esc(x.p.name)}</strong>${x.p.id === ui.userId ? ' <span class="badge">You</span>' : ''}<br>
        <span class="small muted">${esc(x.p.role)}</span></div><div class="small" style="text-align:right">${line(x)}</div></div>`).join('')
      : '<p class="muted">No providers are assigned to this SNF.</p>'}
    ${upcoming.length ? `<h3 style="margin-top:1rem">Provider time off, next 30 days</h3>
      ${upcoming.map(r => {
        const gap = gaps.some(g => g.req.id === r.id);
        const c = r.coverage.find(x => x.snfId === s.id);
        return `<p class="small" style="margin:0 0 .4rem">${esc(userName(r.userId))} · ${fmtRange(r.from, r.to)} → ${gap
          ? `<span class="badge bad">needs coverage</span>${assign(r)}` : `${esc(userName(c.coverId))} covering`}</p>`;
      }).join('')}` : ''}
    ${others.length ? `<h3 style="margin-top:1rem">Other staff</h3><p class="small">${others.map(u => `${esc(u.name)} (${esc(u.role)})`).join(', ')}</p>` : ''}`, {
    extra: admin ? '<button value="edit" formnovalidate>Edit SNF</button>' : '',
    onClose: rv => {
      if (rv === 'edit') setTimeout(() => snfDialog(s));
      if (rv.startsWith('cover:')) setTimeout(() => fixCoverDialog(reqById(rv.slice(6)), s.id));
    }
  });
}

document.addEventListener('change', e => {
  if (e.target.id === 'region-date' && e.target.value) { ui.regionDate = e.target.value; render(); }
});

const regionActions = {
  'snf-view': b => { ui.snfView = b.dataset.v; },
  'snf-detail': b => { snfDetailDialog(db.snfs.find(s => s.id === b.dataset.id)); return false; },
  'region-today': () => { ui.regionDate = today(); }
};
