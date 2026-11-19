/* UI for the Hospital Send-Out Report Builder. Depends on RTH (core.js). No network access. */
(function () {
  'use strict';
  const C = window.RTH;
  const $ = function (id) { return document.getElementById(id); };
  const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };

  // ---- saved preferences (column mappings & value choices only; never resident data) ----
  const LS_KEY = 'fpp-rth-prefs-v1';
  let prefs = { mappings: {}, stay: {}, disp: {}, names: {}, facility: '', windowDays: 30 };
  try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* storage blocked: fine */ }
  function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }

  // ---- state ----------------------------------------------------------------------------
  let files = [];            // { name, headers, rows, mapping, kind, sig }
  let events = [];
  let ingestIssues = [];
  let dupesRemoved = 0;
  const settings = { start: null, end: null, focus: '__all__' };

  // ---- loading ----------------------------------------------------------------------------
  const fileInput = $('file'), drop = $('drop');
  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

  function addFiles(list) {
    Array.prototype.forEach.call(list, function (f) {
      const reader = new FileReader();
      reader.onload = function () { ingest(f.name, String(reader.result)); };
      reader.readAsText(f);
    });
  }

  function ingest(name, text) {
    const all = C.parseCsv(text);
    if (all.length < 2) { alert(name + ' does not look like a CSV with a header row and data.'); return; }
    const hi = C.findHeaderRow(all);
    const headers = all[hi].map(function (h) { return h.trim(); });
    const sig = headers.join('|').toLowerCase();
    const mapping = prefs.mappings[sig] ? JSON.parse(JSON.stringify(prefs.mappings[sig])) : C.detectMapping(headers);
    files = files.filter(function (x) { return x.name !== name; });
    files.push({ name: name, headers: headers, rows: all.slice(hi + 1), mapping: mapping, kind: 'auto', sig: sig });
    firstRange = true;
    refresh(true);
  }

  // ---- pipeline ---------------------------------------------------------------------------
  let firstRange = true;
  function recompute() {
    let ev = [];
    ingestIssues = [];
    files.forEach(function (f) {
      const out = C.rowsToEvents(f.rows, f.mapping, { fileKind: f.kind === 'auto' ? null : f.kind, stayOverrides: prefs.stay, respectIncludeRate: prefs.respectRate !== false, skipPlanned: !!prefs.skipPlanned });
      ev = ev.concat(out.events);
      ingestIssues.push({ file: f.name, issues: out.issues, rows: f.rows.length, kept: out.events.length });
    });
    const d = C.dedupe(ev);
    events = d.events; dupesRemoved = d.removed;
  }

  // Default period = the span of everything in the files (admissions and send-outs together),
  // so an admissions export that starts before the first send-out is not trimmed.
  function eventDateRange() {
    if (!events.length) return null;
    let lo = Infinity, hi = -Infinity;
    events.forEach(function (e) { if (e.date < lo) lo = e.date; if (e.date > hi) hi = e.date; });
    return { lo: lo, hi: hi };
  }

  function readSettings() {
    prefs.facility = $('facility').value.trim();
    prefs.windowDays = Math.max(1, parseInt($('window').value, 10) || 30);
    prefs.respectRate = $('respectRate').checked;
    prefs.skipPlanned = $('skipPlanned').checked;
    settings.start = C.parseDate($('start').value);
    settings.end = C.parseDate($('end').value);
    settings.focus = $('focus').value || '__all__';
    savePrefs();
  }

  function reportOptions(focusKey) {
    return { start: settings.start, end: settings.end, focusKey: focusKey, windowDays: prefs.windowDays, dispOverrides: prefs.disp, providerNames: prefs.names };
  }

  // ---- UI refresh ---------------------------------------------------------------------------
  function refresh(initial) {
    if (!files.length) { ['step-settings', 'step-check', 'step-print'].forEach(function (id) { $(id).classList.add('hidden'); }); $('report-root').innerHTML = ''; $('files').innerHTML = ''; return; }
    recompute();
    renderFiles();
    $('rateWrap').classList.toggle('hidden', !files.some(function (f) { return f.mapping.includeRate != null; }));
    $('plannedWrap').classList.toggle('hidden', !files.some(function (f) { return f.mapping.planned != null; }));
    ['step-settings', 'step-check', 'step-print'].forEach(function (id) { $(id).classList.remove('hidden'); });

    if (initial) {
      $('facility').value = prefs.facility || (events.find(function (e) { return e.facility; }) || {}).facility || '';
      $('window').value = prefs.windowDays;
      $('respectRate').checked = prefs.respectRate !== false;
      $('skipPlanned').checked = !!prefs.skipPlanned;
    }
    if (firstRange || settings.start == null) {
      const r = eventDateRange();
      if (r) { $('start').value = C.dayToISO(r.lo); $('end').value = C.dayToISO(r.hi); }
      firstRange = false;
    }
    readSettings();
    if (settings.start == null || settings.end == null) { $('report-root').innerHTML = ''; $('warnings').innerHTML = '<div class="banner error">Enter a start and end date.</div>'; return; }

    // provider drop-down
    const probe = C.buildReport(events, reportOptions(null));
    const sel = $('focus'), keep = settings.focus;
    sel.innerHTML = '<option value="__all__">Every provider (one report each) + building</option>' +
      '<option value="__none__">Building only (no provider)</option>' +
      probe.providers.map(function (p) { return '<option value="' + esc(p.key) + '">' + esc(p.display) + '</option>'; }).join('');
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : '__all__';
    readSettings();

    $('counts').innerHTML = '<strong>' + probe.building.admissions + '</strong> admissions and <strong>' + probe.building.sends + '</strong> send-outs fall inside these dates.' +
      (dupesRemoved ? ' <span class="muted">(' + dupesRemoved + ' exact duplicate row' + (dupesRemoved === 1 ? '' : 's') + ' ignored.)</span>' : '');

    renderWarnings(probe);
    renderReview(probe);
    renderReports();
  }

  function renderFiles() {
    $('files').innerHTML = files.map(function (f, i) {
      const info = ingestIssues[i];
      const missing = C.FIELD_DEFS.filter(function (d) { return d.required && f.mapping[d.key] == null && !(d.key === 'resident' && (f.mapping.lastName != null)); });
      const opts = '<option value="-1">— not in this file —</option>' + f.headers.map(function (h, hi) { return '<option value="' + hi + '">' + esc(h || '(blank header)') + '</option>'; }).join('');
      const rows = C.FIELD_DEFS.map(function (d) {
        const cur = f.mapping[d.key] == null ? -1 : f.mapping[d.key];
        return '<tr><td>' + esc(d.label) + (d.required ? ' <span class="req">*</span>' : '') + '<div class="muted" style="font-size:12px">' + esc(d.hint) + '</div></td>' +
          '<td><select data-file="' + i + '" data-field="' + d.key + '">' + opts.replace('value="' + cur + '"', 'value="' + cur + '" selected') + '</select></td></tr>';
      }).join('');
      const parts = [];
      if (info.issues.badDate) parts.push(info.issues.badDate + ' row(s) skipped: unreadable date');
      if (info.issues.excludedByRate) parts.push(info.issues.excludedByRate + ' row(s) skipped: PCC marks Include Rate = No');
      if (info.issues.skippedPlanned) parts.push(info.issues.skippedPlanned + ' send-out row(s) skipped: marked Planned');
      if (info.issues.noResident) parts.push(info.issues.noResident + ' row(s) skipped: no resident');
      if (info.issues.unknownEventType) parts.push(info.issues.unknownEventType + ' row(s) skipped: event type is neither an admission nor a send-out (' + Object.keys(info.issues.unknownTypes).slice(0, 4).map(function (k) { return '"' + esc(k) + '"'; }).join(', ') + ')');
      return '<div class="file"><div class="file-head"><span class="name">' + esc(f.name) + ' <span class="muted">· ' + info.kept + ' of ' + info.rows + ' rows used</span></span>' +
        '<span><select data-kind="' + i + '"><option value="auto"' + (f.kind === 'auto' ? ' selected' : '') + '>Detect admissions / send-outs</option><option value="admission"' + (f.kind === 'admission' ? ' selected' : '') + '>This file is admissions only</option><option value="sendout"' + (f.kind === 'sendout' ? ' selected' : '') + '>This file is send-outs only</option></select> ' +
        '<button type="button" class="link" data-remove="' + i + '">Remove</button></span></div>' +
        (parts.length ? '<div class="banner warn">' + parts.join('<br>') + '</div>' : '') +
        (missing.length ? '<div class="banner error">Could not find a column for: ' + missing.map(function (m) { return esc(m.label); }).join(', ') + '. Pick it below.</div>' : '') +
        '<details' + (missing.length ? ' open' : '') + '><summary>Column mapping (' + Object.keys(f.mapping).length + ' columns recognised)</summary><table class="map">' + rows + '</table></details></div>';
    }).join('');
  }

  function renderWarnings(r) {
    const w = r.warnings.map(function (x) { return '<div class="banner ' + x.level + '">' + esc(x.text) + '</div>'; }).join('');
    let note = '';
    if (r.building.hasPccMsg) note = '<div class="banner ok">Cross-check: PCC\u2019s 30-day message flags <strong>' + r.building.pccFlaggedPa + '</strong> post-acute admissions as \u201cTransferred to Hospital.\u201d This report counts <strong>' + r.building.paWithin + '</strong> post-acute send-outs within ' + r.windowDays + ' days. They are not always equal (one flag per admission vs. one row per send-out), but a large gap is worth a look.</div>';
    $('warnings').innerHTML = note + w || '<div class="banner ok">No data problems detected. Spot-check a few numbers against PCC before sending the report.</div>';
  }

  function renderReview(r) {
    const stayVals = C.distinct(events.filter(function (e) { return e.stayRaw; }), function (e) { return e.stayRaw; });
    const dispVals = C.distinct(events.filter(function (e) { return e.type === 'sendout' && e.dispositionRaw; }), function (e) { return e.dispositionRaw; });
    const staySel = function (v) {
      const cur = C.classifyStay(v, prefs.stay);
      return '<select data-stay="' + esc(v) + '">' + [['post-acute', 'Post-acute'], ['long-term', 'Long-term'], ['unclassified', 'Not classified']].map(function (o) { return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    };
    const dispSel = function (v) {
      const cur = C.classifyDisposition(v, prefs.disp);
      return '<select data-disp="' + esc(v) + '">' + [C.DISP_INPATIENT, C.DISP_OBSERVATION, C.DISP_UNCERTAIN, C.DISP_ED, C.DISP_OTHER].map(function (o) { return '<option' + (cur === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    };
    let html = '';
    html += '<div class="review-block"><h3>Stay type values in the file</h3><div class="muted" style="font-size:13px">How each value is counted. Change it once and it is remembered.</div><table class="review">' +
      (stayVals.length ? stayVals.map(function (s) { return '<tr><td>' + esc(s.value) + ' <span class="muted">(' + s.n + ')</span></td><td>' + staySel(s.value) + '</td></tr>'; }).join('') : '<tr><td class="muted">No stay type column found. Post-acute / long-term cannot be separated.</td></tr>') + '</table></div>';
    html += '<div class="review-block"><h3>Hospital disposition values</h3><table class="review">' +
      (dispVals.length ? dispVals.map(function (s) { return '<tr><td>' + esc(s.value) + ' <span class="muted">(' + s.n + ')</span></td><td>' + dispSel(s.value) + '</td></tr>'; }).join('') : '<tr><td class="muted">No disposition column found.</td></tr>') + '</table></div>';
    html += '<div class="review-block"><h3>Provider names on the report</h3><div class="muted" style="font-size:13px">Add &ldquo;Dr.&rdquo; or fix spelling here. Remembered for next month.</div><table class="review">' +
      r.providers.map(function (p) { return '<tr><td>' + esc(p.person.raw) + '</td><td><input type="text" data-name="' + esc(p.key) + '" value="' + esc(p.display) + '"></td></tr>'; }).join('') + '</table></div>';
    $('review').innerHTML = html;
  }

  // ---- change handling (delegated) ---------------------------------------------------------
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (t.dataset.field != null) {
      const f = files[+t.dataset.file]; const v = parseInt(t.value, 10);
      if (v < 0) delete f.mapping[t.dataset.field]; else f.mapping[t.dataset.field] = v;
      prefs.mappings[f.sig] = f.mapping; savePrefs(); firstRange = true; refresh(false);
    } else if (t.dataset.kind != null) { files[+t.dataset.kind].kind = t.value; firstRange = true; refresh(false); }
    else if (t.dataset.stay != null) { prefs.stay[t.dataset.stay.toLowerCase()] = t.value; savePrefs(); refresh(false); }
    else if (t.dataset.disp != null) { prefs.disp[t.dataset.disp.toLowerCase()] = t.value; savePrefs(); refresh(false); }
    else if (t.dataset.name != null) { const v = t.value.trim(); if (v) prefs.names[t.dataset.name] = v; else delete prefs.names[t.dataset.name]; savePrefs(); renderReports(); }
    else if (['facility', 'start', 'end', 'window', 'focus', 'respectRate', 'skipPlanned'].indexOf(t.id) !== -1) { readSettings(); if (t.id === 'start' || t.id === 'end' || t.id === 'window' || t.id === 'respectRate' || t.id === 'skipPlanned') refresh(false); else renderReports(); }
  });
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.dataset && t.dataset.remove != null) { files.splice(+t.dataset.remove, 1); firstRange = true; refresh(false); }
  });
  $('prevMonth').addEventListener('click', function () {
    const n = new Date(); const first = Date.UTC(n.getFullYear(), n.getMonth() - 1, 1), last = Date.UTC(n.getFullYear(), n.getMonth(), 0);
    $('start').value = new Date(first).toISOString().slice(0, 10); $('end').value = new Date(last).toISOString().slice(0, 10); refresh(false);
  });
  $('fullRange').addEventListener('click', function () { firstRange = true; refresh(false); });
  $('print').addEventListener('click', function () {
    const blocking = C.buildReport(events, reportOptions(null)).warnings.filter(function (w) { return w.level === 'error'; });
    if (blocking.length && !confirm('The data check shows ' + blocking.length + ' problem(s) that make the numbers incomplete. Print anyway?')) return;
    const prev = document.title;
    document.title = 'Hospital Send-Out Report - ' + (prefs.facility || 'Facility') + ' - ' + C.dayToISO(settings.start) + ' to ' + C.dayToISO(settings.end);
    window.print();
    setTimeout(function () { document.title = prev; }, 500);
  });

  // ---- report rendering -------------------------------------------------------------------
  function renderReports() {
    if (settings.start == null || settings.end == null) return;
    let keys;
    if (settings.focus === '__all__') keys = C.buildReport(events, reportOptions(null)).providers.map(function (p) { return p.key; });
    else if (settings.focus === '__none__') keys = [null];
    else keys = [settings.focus];
    if (settings.focus === '__all__') keys.push(null); // building-only report last
    $('report-root').innerHTML = keys.map(function (k) { return renderReport(C.buildReport(events, reportOptions(k))); }).join('');
  }

  function tbl(head, rows, cls) {
    return '<table' + (cls ? ' class="' + cls + '"' : '') + '><thead><tr>' + head.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + h.t + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }
  function tr(cells, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map(function (c) { return typeof c === 'object' ? '<td class="' + c.cls + '">' + c.t + '</td>' : '<td>' + c + '</td>'; }).join('') + '</tr>'; }
  function foot(n, total) { return '<div class="foot"><span>CONFIDENTIAL | Resident-level information</span><span>' + n + (total ? ' of ' + total : '') + '</span></div>'; }
  function fr(n, d) { return n + ' / ' + d + ' = ' + C.fmtPct(n, d); }

  function renderReport(r) {
    const f = r.focus, B = r.building, F = r.focusM, w = r.windowDays;
    const eyebrow = 'ADMISSIONS &amp; HOSPITAL SEND-OUTS' + (prefs.facility ? ' · ' + esc(prefs.facility.toUpperCase()) : '');
    const hdr = function (title, sub) { return '<div class="eyebrow">' + eyebrow + '</div><h1>' + title + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : ''); };
    const pagesTotal = f ? 4 : 3;
    let pageNo = 0;
    let n = 0; const sec = function (t) { n++; return '<h2>' + n + '. ' + t + '</h2>'; };
    const pages = [];

    // Page 1
    let p1 = hdr('Admissions and Hospital<br>Send-Out Report', esc(r.period.label) + ' | ' + (f ? esc(f.name) + ' vs. Building' : 'Building'));
    p1 += '<p class="lede">' + (f ? 'Building totals include ' + esc(f.name) + '. ' : '') + 'Counts represent admission and send-out events.' + (f ? ' Provider comparisons use the attribution recorded on the send-out log.' : '') + '</p>';
    p1 += sec('Admissions and send-out volume');
    const vol = [
      ['Total admissions', B.admissions, F && F.admissions], ['Post-acute admissions', B.paAdm, F && F.paAdm], ['Long-term admissions', B.ltAdm, F && F.ltAdm],
      ['Total send-outs', B.sends, F && F.sends], ['Post-acute send-outs', B.paSends, F && F.paSends], ['Long-term send-outs', B.ltSends, F && F.ltSends],
      ['Post-acute send-outs within ' + w + ' days', B.paWithin, F && F.paWithin], ['Long-term send-outs within ' + w + ' days', B.ltWithin, F && F.ltWithin],
      ['Residents with at least one send-out', B.residents, F && F.residents]];
    p1 += tbl([{ t: 'Metric' }, { t: 'Building', cls: 'r' }].concat(f ? [{ t: esc(f.name), cls: 'r' }] : []),
      vol.map(function (v) { return tr([v[0], { cls: 'r', t: v[1] }].concat(f ? [{ cls: 'r', t: v[2] }] : [])); }));
    if (f) p1 += '<p>' + esc(f.name) + ' accounted for ' + r.shares.admissions + ' of admissions and ' + r.shares.sends + ' of send-outs.</p>';
    p1 += sec('Return-to-hospital comparison');
    p1 += '<p class="note">RTH = selected send-outs ÷ total admissions. The admission denominator remains ' + B.admissions + ' for the building' + (f ? ' and ' + F.admissions + ' for ' + esc(f.name) : '') + ' in all three measures.</p>';
    p1 += tbl([{ t: 'Measure' }, { t: 'Building', cls: 'r' }].concat(f ? [{ t: esc(f.name), cls: 'r' }] : []), [
      ['Total RTH', B.sends, B.admissions, F && F.sends, F && F.admissions],
      ['Post-acute RTH: all stay lengths', B.paSends, B.admissions, F && F.paSends, F && F.admissions],
      ['Post-acute RTH: within ' + w + ' days', B.paWithin, B.admissions, F && F.paWithin, F && F.admissions]
    ].map(function (m) { return tr([m[0], { cls: 'r', t: fr(m[1], m[2]) }].concat(f ? [{ cls: 'r', t: fr(m[3], m[4]) }] : [])); }));
    p1 += sec('Recorded send-out attribution');
    p1 += tbl([{ t: 'Provider / recorded entry' }, { t: 'Total', cls: 'r' }, { t: 'Post-acute', cls: 'r' }, { t: 'Long-term', cls: 'r' }, { t: 'Post-acute within ' + w + ' days', cls: 'r' }],
      r.attribution.map(function (a) { return tr([esc(a.name), { cls: 'r', t: a.total }, { cls: 'r', t: a.postAcute }, { cls: 'r', t: a.longTerm }, { cls: 'r', t: a.paWithin }]); })
        .concat([tr(['Building total', { cls: 'r', t: B.sends }, { cls: 'r', t: B.paSends }, { cls: 'r', t: B.ltSends }, { cls: 'r', t: B.paWithin }], 'total')]));
    pages.push(p1);

    // Page 2: focus provider list
    if (f) {
      const L = r.focusLists;
      let p2 = hdr(esc(f.name) + ':<br>All Send-Outs', '');
      p2 += '<p class="stat">' + F.sends + ' send-outs | ' + F.residents + ' residents | ' + L.within + ' within ' + w + ' days | ' + L.after + ' after ' + w + ' days</p>';
      const list = function (rows) {
        if (!rows.length) return '<p class="note">None in this period.</p>';
        return tbl([{ t: 'Date' }, { t: 'Resident' }, { t: 'Stay timing' }, { t: 'Reported reason' }], rows.map(function (x) { return tr([x.dateLabel, esc(x.resident), esc(x.timing) + (x.assumed ? ' <span class="flag">*</span>' : ''), esc(x.reason)]); }));
      };
      p2 += sec('Post-acute: ' + F.paSends + ' send-outs') + list(L.postAcute);
      p2 += '<h3>Long-term: ' + F.ltSends + ' send-outs</h3>' + list(L.longTerm);
      if (L.unclassified.length) p2 += '<h3>No stay type recorded: ' + L.unclassified.length + ' send-outs</h3>' + list(L.unclassified);
      if (L.postAcute.concat(L.longTerm, L.unclassified).some(function (x) { return x.assumed; })) p2 += '<p class="flag">* No admit date was available; counted as after ' + w + ' days.</p>';
      p2 += '<p>' + esc(L.reasonSentence) + '</p>';
      pages.push(p2);
    }

    // Reasons page
    let p3 = hdr('Building-Wide Reported Reasons', '');
    p3 += '<p class="stat">' + B.sends + ' send-outs | Reason frequency and recorded attribution</p>';
    p3 += sec('Most frequent reasons');
    p3 += '<p>' + esc(r.reasons.sentences) + '</p>';
    const cols = r.reasons.cols;
    p3 += tbl([{ t: 'Reported reason' }, { t: 'Building', cls: 'c' }].concat(cols.map(function (c) { return { t: esc(c.label), cls: 'c' }; })),
      r.reasons.rows.map(function (row) { return tr([esc(row.reason), { cls: 'c', t: row.building }].concat(row.cells.map(function (v) { return { cls: v ? 'c' : 'c z', t: v }; }))); })
        .concat([tr(['Total', { cls: 'c', t: r.reasons.totals.building }].concat(r.reasons.totals.cells.map(function (v) { return { cls: 'c', t: v }; })), 'total')]), 'matrix');
    p3 += '<p>' + esc(r.reasons.top6) + '</p>';
    pages.push(p3);

    // Repeat + disposition page
    let p4 = hdr('Repeat Send-Outs and Disposition', '');
    p4 += '<p class="stat">Resident-level recurrence during ' + esc(r.period.label) + '</p>';
    p4 += sec('Residents with repeat send-outs');
    const rs = r.repeats.summary;
    if (typeof rs === 'string') p4 += '<p>' + esc(rs) + '</p>';
    else {
      p4 += '<p>' + esc(rs.text) + '</p>';
      const maxN = r.repeats.rows.reduce(function (a, x) { return Math.max(a, x.sends.length); }, 2);
      const ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
      const head = [{ t: 'Resident' }]; for (let i = 0; i < maxN; i++) head.push({ t: (ord[i] || (i + 1) + 'th') + ' send-out' });
      p4 += tbl(head, r.repeats.rows.map(function (x) {
        const cells = [esc(x.resident)];
        for (let i = 0; i < maxN; i++) { const s = x.sends[i]; cells.push(s ? s.dateLabel + ' | ' + esc(s.reason) + '<div class="prov">' + esc(s.provider) + '</div>' : ''); }
        return tr(cells);
      }));
      rs.notes.forEach(function (t) { p4 += '<p>' + esc(t) + '</p>'; });
    }
    p4 += sec('Hospital disposition');
    p4 += tbl([{ t: 'Recorded hospital disposition' }, { t: 'Building', cls: 'r' }].concat(f ? [{ t: esc(f.name), cls: 'r' }] : []),
      r.disposition.map(function (d) { return tr([esc(d.label), { cls: 'r', t: d.building }].concat(f ? [{ cls: 'r', t: d.focus }] : [])); })
        .concat([tr(['Total', { cls: 'r', t: B.sends }].concat(f ? [{ cls: 'r', t: F.sends }] : []), 'total')]));
    pages.push(p4);

    return '<div class="report">' + pages.map(function (html, i) { return '<section class="page">' + html + foot(i + 1, pages.length) + '</section>'; }).join('') + '</div>';
  }

  // initial dark-mode + empty state
  refresh(false);
})();
