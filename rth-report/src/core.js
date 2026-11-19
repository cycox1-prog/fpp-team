/*
 * Hospital send-out report: core logic.
 *
 * Pure functions only: no DOM, no network, no storage. Everything here can be
 * tested in Node (see ../test/core.test.js) and is inlined into the single-file
 * tool by build.js.
 *
 * Flow:  CSV text -> parseCsv -> findHeader -> detectMapping -> normalizeRows
 *        -> events -> buildReport(events, options)
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const POST_ACUTE = 'post-acute';
  const LONG_TERM = 'long-term';
  const UNCLASSIFIED = 'unclassified';

  const DISP_INPATIENT = 'Inpatient';
  const DISP_OBSERVATION = 'Observation';
  const DISP_UNCERTAIN = 'Admitted; status uncertain';
  const DISP_ED = 'ED visit only (not admitted)';
  const DISP_OTHER = 'Other / not recorded';

  // Reason categories as they appear on the report. Incoming values are matched
  // case-insensitively so "ALTERED MENTAL STATUS" still lands on the right row.
  const CANONICAL_REASONS = [
    'Altered mental status', 'Other', 'Low hemoglobin / hematocrit', 'GI bleeding',
    'Fall', 'Shortness of breath (bronchitis, pneumonia)',
    'Abnormal vital signs (low/high BP, high respiratory rate)', 'Abdominal pain',
    'Respiratory infection', 'Decreased or inadequate food / fluid intake', 'Chest pain',
    'Abnormal X-ray', 'Other abnormal lab value or study',
    'Behavioral symptoms (e.g. agitation, psychosis)', 'High blood glucose',
    'Low blood glucose', 'High white blood cell count',
    'Gastrostomy tube blockage or displacement', 'Loss of consciousness (syncope)',
    'Uncontrolled pain', 'Respiratory arrest', 'Seizure', 'Skin wound or ulcer',
    'Stroke / TIA / CVA'
  ];

  // How a reason is written inside a sentence ("Falls, behavioral symptoms, ...").
  const PROSE_LABELS = {
    'Fall': 'falls',
    'Other': '“Other”',
    'GI bleeding': 'GI bleeding',
    'Abnormal X-ray': 'abnormal X-rays',
    'Other abnormal lab value or study': 'other abnormal lab values or studies',
    'Low hemoglobin / hematocrit': 'low hemoglobin / hematocrit'
  };

  // Entries on the send-out log that are not a provider. They stay in the
  // attribution table but never get their own report.
  const DEFAULT_NON_PROVIDERS = ['emergency transfer', 'unknown', 'unassigned', 'not recorded', 'none', 'n/a'];

  // Fields we look for in a CSV. `aliases` are compared after normHeader().
  const FIELD_DEFS = [
    { key: 'eventType', label: 'Event type', hint: 'Admission vs. send-out (only needed if both are in one file)',
      aliases: ['eventtype', 'event', 'recordtype', 'transactiontype', 'adtevent', 'adtaction', 'action', 'category'] },
    { key: 'date', label: 'Event date', required: true, hint: 'Date of the admission or the send-out',
      aliases: ['eventdate', 'date', 'admissiondate', 'admitdate', 'transferdate', 'senddate', 'sendoutdate',
        'dateoftransfer', 'effectivedate', 'effectivedatetime', 'transferdischargedate', 'datetime', 'eventdatetime',
        'dateofadmission'] },
    { key: 'resident', label: 'Resident name', required: true, hint: 'One column, "Last, First"',
      aliases: ['resident', 'residentname', 'patient', 'patientname', 'name', 'clientname', 'client'] },
    { key: 'lastName', label: 'Last name', hint: 'Only if first and last name are separate columns',
      aliases: ['lastname', 'residentlastname', 'patientlastname'] },
    { key: 'firstName', label: 'First name', hint: 'Only if first and last name are separate columns',
      aliases: ['firstname', 'residentfirstname', 'patientfirstname'] },
    { key: 'residentId', label: 'Resident ID', hint: 'Used to match a resident across rows; name is used if blank',
      aliases: ['residentid', 'patientid', 'clientid', 'mrn', 'medicalrecordnumber', 'pccid', 'residentnumber', 'mr', 'id'] },
    { key: 'provider', label: 'Provider', hint: 'Admitting provider on admissions; send-out log attribution on send-outs',
      aliases: ['provider', 'providername', 'attributedprovider', 'attendingphysician', 'attending', 'physician',
        'physicianname', 'admittingprovider', 'admittingphysician', 'sendoutprovider', 'recordedprovider',
        'orderingprovider', 'practitioner', 'orderedby', 'primaryphysician', 'primarycareprovider', 'pcp'] },
    { key: 'stayType', label: 'Stay type', hint: 'Post-acute vs. long-term',
      aliases: ['staytype', 'admissiontype', 'admittype', 'residenttype', 'patienttype', 'careType', 'type_of_stay',
        'admissionstatus', 'purposeofstay', 'postacutelongterm', 'paltc', 'stayclass', 'stayclassification', 'payertype', 'residentclass'].map(normHeader) },
    { key: 'reason', label: 'Send-out reason', hint: 'Reported reason for the hospital transfer',
      aliases: ['reason', 'reasonfortransfer', 'transferreason', 'reportedreason', 'sendoutreason',
        'reasonforsendout', 'primaryreason', 'reasonforhospitaltransfer', 'chiefcomplaint'] },
    { key: 'disposition', label: 'Hospital disposition', hint: 'Inpatient, observation, etc.',
      aliases: ['disposition', 'hospitaldisposition', 'hospitalstatus', 'outcome',
        'hospitaloutcome', 'inpatientobservation', 'status'] },
    { key: 'admitDate', label: 'Resident admit date', hint: 'Optional: lets us compute "within 30 days" directly',
      aliases: ['residentadmitdate', 'originaladmitdate', 'admitdateofstay', 'staystartdate', 'lastadmitdate',
        'lastadmissiondate', 'mostrecentadmissiondate', 'currentadmissiondate', 'dateofadmission', 'admissiondatestay'] },
    { key: 'daysSinceAdmit', label: 'Days since admission', hint: 'Optional alternative to the admit date',
      aliases: ['dayssinceadmission', 'dayssinceadmit', 'lengthofstay', 'los', 'daysinfacility', 'staydays', 'dayssinceadm'] },
    { key: 'includeRate', label: 'Include in rate', hint: 'PCC "Include Rate" Yes/No. Rows marked No are skipped',
      aliases: ['includerate', 'includeinrate', 'includedinrate', 'includedinrates', 'includeinrates'] },
    { key: 'planned', label: 'Planned transfer', hint: 'PCC "Planned" Yes/No (optional)',
      aliases: ['planned', 'plannedtransfer'] },
    { key: 'thirtyDayMsg', label: 'PCC 30-day message', hint: 'Optional; used only as a cross-check',
      aliases: ['30daymessage', 'thirtydaymessage', '30daystatus'] },
    { key: 'facility', label: 'Facility', hint: 'Optional; shown in the report header',
      aliases: ['facility', 'facilityname', 'building', 'buildingname', 'snf', 'location'] }
  ];

  function normHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // Normalise alias lists once (a couple were written with underscores / caps).
  FIELD_DEFS.forEach(function (f) { f.aliases = f.aliases.map(normHeader); });

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  /** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, BOM. Returns string[][]. */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = '', inQuotes = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
  }

  /**
   * PCC exports often start with title lines ("Facility: ...", "Run date: ...").
   * Pick the row among the first 25 whose cells match the most known aliases.
   */
  function findHeaderRow(rows) {
    const known = {};
    FIELD_DEFS.forEach(function (f) { f.aliases.forEach(function (a) { known[a] = true; }); });
    let best = 0, bestScore = -1;
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      let score = 0;
      rows[i].forEach(function (c) { if (known[normHeader(c)]) score++; });
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /** Map each field to the best-matching header (exact alias wins; earlier alias beats later). */
  function detectMapping(headers) {
    const norm = headers.map(normHeader);
    const mapping = {};
    const used = {};
    FIELD_DEFS.forEach(function (f) {
      for (let a = 0; a < f.aliases.length; a++) {
        const idx = norm.findIndex(function (h, i) { return h === f.aliases[a] && !used[i]; });
        if (idx !== -1) { mapping[f.key] = idx; used[idx] = true; return; }
      }
    });
    return mapping;
  }

  // ---------------------------------------------------------------------------
  // Dates (day numbers, so there are no time-zone surprises)
  // ---------------------------------------------------------------------------

  const MS_DAY = 86400000;

  /** Accepts M/D/YYYY, M/D/YY, YYYY-MM-DD, with optional time. Returns day number or null. */
  function parseDate(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    let y, m, d, mt;
    if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) {
      y = +mt[1]; m = +mt[2]; d = +mt[3];
    } else if ((mt = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})(?:[T\s,].*)?$/))) {
      m = +mt[1]; d = +mt[2]; y = +mt[3];
      if (mt[3].length === 2) y += y >= 70 ? 1900 : 2000;
    } else return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = Date.UTC(y, m - 1, d);
    const chk = new Date(t);
    if (chk.getUTCMonth() !== m - 1) return null; // e.g. 02/31
    return Math.round(t / MS_DAY);
  }
  function dayToDate(day) { return new Date(day * MS_DAY); }
  function dayToISO(day) { return dayToDate(day).toISOString().slice(0, 10); }
  function fmtMD(day) {
    const d = dayToDate(day);
    return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  /** "August 1 - October 1, 2026" (year shown once if both dates share it). */
  function fmtPeriod(start, end) {
    const a = dayToDate(start), b = dayToDate(end);
    const left = MONTHS[a.getUTCMonth()] + ' ' + a.getUTCDate() +
      (a.getUTCFullYear() !== b.getUTCFullYear() ? ', ' + a.getUTCFullYear() : '');
    return left + ' - ' + MONTHS[b.getUTCMonth()] + ' ' + b.getUTCDate() + ', ' + b.getUTCFullYear();
  }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------

  const TITLE_RE = /\b(dr|md|m\.d|do|d\.o|np|aprn|arnp|pa-c|pa|fnp|fnp-c|fnp-bc|anp|anp-c|agnp|dnp|phd)\b\.?/gi;

  /** "WIELEBINSKI, PAUL MD" -> { first, last, isMd, key } */
  function parsePerson(raw) {
    const original = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
    if (!original) return { raw: '', first: '', last: '', key: '', isMd: false };
    const isMd = /\b(dr\.?|md|m\.d\.?|do|d\.o\.?)\b/i.test(original);
    let s = original.replace(TITLE_RE, ' ').replace(/[,\s]+$/g, '').replace(/^[,\s]+/, '').replace(/\s+/g, ' ').trim();
    let first = '', last = '';
    if (s.indexOf(',') !== -1) {
      const parts = s.split(',');
      last = parts[0].trim();
      first = parts.slice(1).join(' ').trim();
    } else {
      const toks = s.split(' ');
      if (toks.length === 1) { last = toks[0]; } else {
        last = toks[toks.length - 1];
        first = toks.slice(0, -1).join(' ');
      }
    }
    const key = (first + ' ' + last).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    return { raw: original, first: titleCase(first), last: titleCase(last), key: key, isMd: isMd, comma: s.indexOf(',') !== -1 };
  }
  function titleCase(s) {
    return String(s).toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); })
      .replace(/\bMc([a-z])/g, function (_, c) { return 'Mc' + c.toUpperCase(); });
  }

  /** Display name for a provider: "Dr. Paul Wielebinski" or "Tzirel Ward". */
  function providerDisplay(p, overrides) {
    if (overrides && overrides[p.key]) return overrides[p.key];
    if (!p.key) return 'Not recorded';
    // Non-person entries such as "Emergency Transfer" have no comma and are kept verbatim.
    if (!p.comma && !p.first && !p.isMd) return p.raw;
    const name = (p.first ? p.first + ' ' : '') + p.last;
    return (p.isMd ? 'Dr. ' : '') + name;
  }
  /** "Last, First" -> "First Last" for prose. */
  function residentFirstLast(name) {
    const i = name.indexOf(',');
    if (i === -1) return name;
    return (name.slice(i + 1).trim() + ' ' + name.slice(0, i).trim()).trim();
  }

  // ---------------------------------------------------------------------------
  // Value normalisation
  // ---------------------------------------------------------------------------

  const CANON_LOOKUP = {};
  CANONICAL_REASONS.forEach(function (r) { CANON_LOOKUP[r.toLowerCase().replace(/\s+/g, ' ')] = r; });

  const REASON_ALIASES = { 'gl bleeding': 'GI bleeding', 'g.i. bleeding': 'GI bleeding', 'gi bleed': 'GI bleeding', 'gl bleed': 'GI bleeding' };
  function normReason(v) {
    const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
    if (!s) return 'Not recorded';
    const l = s.toLowerCase();
    return CANON_LOOKUP[l] || CANON_LOOKUP[REASON_ALIASES[l]] || (REASON_ALIASES[l] && REASON_ALIASES[l]) || s;
  }

  /** Default stay-type rules; user overrides (value -> category) win. */
  function classifyStay(v, overrides) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return UNCLASSIFIED;
    if (overrides && overrides[s.toLowerCase()]) return overrides[s.toLowerCase()];
    const l = s.toLowerCase();
    if (/long|ltc|custodial|permanent|\blt\b/.test(l)) return LONG_TERM;
    if (/post|short|skilled|snf|rehab|medicare\s*a|part\s*a|\bpa\b/.test(l)) return POST_ACUTE;
    return UNCLASSIFIED;
  }

  /**
   * PCC "Outcome" values: "Admitted, Inpatient", "Admitted, Observation", "ED Visit Only", "Other", blank.
   * A blank or "Other" outcome means the hospital result was not recorded, which the report calls
   * "Admitted; status uncertain".
   */
  function classifyDisposition(v, overrides) {
    const s = String(v == null ? '' : v).trim();
    if (overrides && s && overrides[s.toLowerCase()]) return overrides[s.toLowerCase()];
    const l = s.toLowerCase();
    if (/obs/.test(l)) return DISP_OBSERVATION;
    if (/in-?patient/.test(l)) return DISP_INPATIENT;
    if (/\bed\b|\ber\b|emergency|treat.*release|not admitted|visit only/.test(l)) return DISP_ED;
    if (!l || l === 'other' || /uncertain|unknown|unclear|admit/.test(l)) return DISP_UNCERTAIN;
    return DISP_OTHER;
  }

  function classifyEventType(v) {
    const l = String(v == null ? '' : v).toLowerCase();
    if (/send|transfer|hospital|acute|\bed\b|emergency|er visit/.test(l)) return 'sendout';
    if (/admi|readmi/.test(l)) return 'admission';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Rows -> events
  // ---------------------------------------------------------------------------

  /**
   * @param {string[][]} rows   data rows (header already removed)
   * @param {object} mapping    field key -> column index
   * @param {object} opts       { fileKind: 'admission'|'sendout'|'auto', stayOverrides, fileName }
   * @returns {{events:Array, issues:Object}}
   */
  function rowsToEvents(rows, mapping, opts) {
    opts = opts || {};
    const events = [];
    const issues = { badDate: 0, noResident: 0, unknownEventType: 0, unknownTypes: {} };
    const get = function (r, key) {
      const idx = mapping[key];
      return idx == null || idx < 0 ? '' : (r[idx] == null ? '' : String(r[idx]).trim());
    };
    rows.forEach(function (r) {
      let type = opts.fileKind === 'admission' || opts.fileKind === 'sendout' ? opts.fileKind : null;
      if (mapping.eventType != null) {
        const raw = get(r, 'eventType');
        type = classifyEventType(raw);
        if (!type) { issues.unknownEventType++; issues.unknownTypes[raw || '(blank)'] = (issues.unknownTypes[raw || '(blank)'] || 0) + 1; return; }
      }
      if (!type) type = mapping.reason != null ? 'sendout' : 'admission';

      const date = parseDate(get(r, 'date'));
      if (date == null) { issues.badDate++; return; }
      if (opts.respectIncludeRate !== false && mapping.includeRate != null && /^(no|n|false|0)$/i.test(get(r, 'includeRate'))) {
        issues.excludedByRate = (issues.excludedByRate || 0) + 1; return;
      }

      let resident = get(r, 'resident');
      if (!resident && (mapping.lastName != null || mapping.firstName != null)) {
        const ln = get(r, 'lastName'), fn = get(r, 'firstName');
        resident = ln && fn ? ln + ', ' + fn : ln || fn;
      }
      if (!resident) { issues.noResident++; return; }
      const rp = parsePerson(resident);
      const rid = get(r, 'residentId');
      let provRaw = get(r, 'provider');
      if (/^(et|e\.t\.|er transfer)$/i.test(provRaw)) provRaw = 'Emergency Transfer'; // PCC shorthand
      const person = parsePerson(provRaw);
      const planned = /^(yes|y|true|1)$/i.test(get(r, 'planned'));
      if (opts.skipPlanned && type === 'sendout' && planned) { issues.skippedPlanned = (issues.skippedPlanned || 0) + 1; return; }

      const ev = {
        type: type,
        date: date,
        resident: rp.comma ? rp.last + ', ' + rp.first : (rp.raw || resident),
        residentKey: rid ? 'id:' + rid.toLowerCase() : 'n:' + rp.key,
        providerKey: person.key,
        provider: person,
        stayRaw: get(r, 'stayType'),
        stay: classifyStay(get(r, 'stayType'), opts.stayOverrides),
        reason: type === 'sendout' ? normReason(get(r, 'reason')) : '',
        dispositionRaw: get(r, 'disposition'),
        admitDate: parseDate(get(r, 'admitDate')),
        pccMsg: get(r, 'thirtyDayMsg'),
        planned: planned,
        daysSince: (function () { const v = get(r, 'daysSinceAdmit'); return /^\d+$/.test(v) ? +v : null; })(),
        facility: get(r, 'facility')
      };
      events.push(ev);
    });
    return { events: events, issues: issues };
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  function count(arr, fn) { let n = 0; arr.forEach(function (x) { if (fn(x)) n++; }); return n; }
  function pct(n, d) { return d ? (n / d * 100) : 0; }
  function fmtPct(n, d) { return d ? (Math.round(n / d * 1000) / 10).toFixed(1) + '%' : '0.0%'; }

  /**
   * PCC can log the same transfer twice (e.g. once when sent, again when the outcome is entered).
   * Rows with the same type/date/resident/provider/reason are one event; keep the one with an outcome.
   */
  function dedupe(events) {
    const seen = {};
    const out = [];
    events.forEach(function (e) {
      const k = [e.type, e.date, e.residentKey, e.providerKey, e.reason].join('|');
      const i = seen[k];
      if (i === undefined) { seen[k] = out.length; out.push(e); return; }
      if (!out[i].dispositionRaw && e.dispositionRaw) out[i] = e;
    });
    return { events: out, removed: events.length - out.length };
  }

  /**
   * Build every number and sentence the report needs.
   *
   * @param {Array}  events
   * @param {object} o  { start, end (day numbers, inclusive), focusKey (provider key or null),
   *                      windowDays (default 30), dispOverrides, providerNames, nonProviders }
   */
  function buildReport(events, o) {
    const windowDays = o.windowDays == null ? 30 : o.windowDays;
    const nonProv = (o.nonProviders || DEFAULT_NON_PROVIDERS).map(function (s) { return s.toLowerCase(); });
    const warnings = [];

    const inRange = function (e) { return e.date >= o.start && e.date <= o.end; };
    const admissionsAll = events.filter(function (e) { return e.type === 'admission'; });
    const admissions = admissionsAll.filter(inRange);
    const sendouts = events.filter(function (e) { return e.type === 'sendout' && inRange(e); });

    // Index admissions by resident, newest first, for stay-type / timing lookups.
    const admitsByResident = {};
    admissionsAll.forEach(function (a) { (admitsByResident[a.residentKey] = admitsByResident[a.residentKey] || []).push(a); });
    Object.keys(admitsByResident).forEach(function (k) { admitsByResident[k].sort(function (a, b) { return b.date - a.date; }); });

    let assumedAfter30 = 0, unclassifiedStay = 0, stayFromAdmission = 0;
    sendouts.forEach(function (s) {
      const prior = (admitsByResident[s.residentKey] || []).find(function (a) { return a.date <= s.date; });
      // stay type
      s.stayFinal = s.stay;
      if (s.stayFinal === UNCLASSIFIED && prior && prior.stay !== UNCLASSIFIED) { s.stayFinal = prior.stay; stayFromAdmission++; }
      if (s.stayFinal === UNCLASSIFIED) unclassifiedStay++;
      // days since admission
      let days = null;
      if (s.daysSince != null) days = s.daysSince;
      else if (s.admitDate != null) days = s.date - s.admitDate;
      else if (prior) days = s.date - prior.date;
      if (days == null) { assumedAfter30++; s.within = false; s.timingAssumed = true; }
      else s.within = days <= windowDays;
      s.disposition = classifyDisposition(s.dispositionRaw, o.dispOverrides);
    });
    if (unclassifiedStay) warnings.push({ level: 'error', text: unclassifiedStay + ' send-out(s) have no post-acute / long-term stay type, so they are counted in totals but in neither stay-type column. Map the stay-type values below, or include a stay-type column.' });
    if (assumedAfter30) warnings.push({ level: 'warn', text: assumedAfter30 + ' send-out(s) had no admit date and no matching admission in the file; they were treated as "after 30 days". Include admissions from at least ' + windowDays + ' days before the start date, or add a resident admit-date column.' });
    const admUnclass = count(admissions, function (a) { return a.stay === UNCLASSIFIED; });
    if (admUnclass) warnings.push({ level: 'error', text: admUnclass + ' admission(s) have no post-acute / long-term stay type and are counted only in total admissions.' });
    if (!admissions.length) warnings.push({ level: 'error', text: 'No admissions were found in the selected dates, so return-to-hospital rates cannot be calculated.' });
    if (!sendouts.length) warnings.push({ level: 'warn', text: 'No send-outs were found in the selected dates.' });

    // Provider registry (built from both admissions and send-outs in the period).
    const registry = {};
    admissions.concat(sendouts).forEach(function (e) {
      const k = e.providerKey;
      if (!registry[k]) registry[k] = { key: k, person: e.provider, display: providerDisplay(e.provider, o.providerNames), isProvider: nonProv.indexOf((e.provider.raw || '').toLowerCase()) === -1 && nonProv.indexOf((e.provider.key || '')) === -1 && !!k };
      else if (e.provider.isMd && !registry[k].person.isMd) { registry[k].person = e.provider; registry[k].display = providerDisplay(e.provider, o.providerNames); }
    });
    const shortName = function (reg) { return reg.isProvider && reg.person.last ? reg.person.last : reg.display; };

    const metrics = function (scopeAdm, scopeSend) {
      const pa = function (s) { return s.stayFinal === POST_ACUTE; };
      const lt = function (s) { return s.stayFinal === LONG_TERM; };
      const m = {
        admissions: scopeAdm.length,
        paAdm: count(scopeAdm, function (a) { return a.stay === POST_ACUTE; }),
        ltAdm: count(scopeAdm, function (a) { return a.stay === LONG_TERM; }),
        sends: scopeSend.length,
        paSends: count(scopeSend, pa),
        ltSends: count(scopeSend, lt),
        paWithin: count(scopeSend, function (s) { return pa(s) && s.within; }),
        ltWithin: count(scopeSend, function (s) { return lt(s) && s.within; }),
        anyWithin: count(scopeSend, function (s) { return s.within; }),
        residents: Object.keys(scopeSend.reduce(function (acc, s) { acc[s.residentKey] = 1; return acc; }, {})).length
      };
      m.rthTotal = pct(m.sends, m.admissions);
      m.rthPa = pct(m.paSends, m.admissions);
      m.rthPaWithin = pct(m.paWithin, m.admissions);
      return m;
    };

    const building = metrics(admissions, sendouts);
    building.pccFlaggedPa = count(admissions, function (a) { return a.stay === POST_ACUTE && /transferred/i.test(a.pccMsg || ''); });
    building.hasPccMsg = admissions.some(function (a) { return a.pccMsg; });

    const focusReg = o.focusKey != null ? registry[o.focusKey] : null;
    const focusAdm = focusReg ? admissions.filter(function (a) { return a.providerKey === o.focusKey; }) : [];
    const focusSend = focusReg ? sendouts.filter(function (s) { return s.providerKey === o.focusKey; }) : [];
    const focus = focusReg ? metrics(focusAdm, focusSend) : null;

    // --- Section 3: attribution ---------------------------------------------
    const attribution = Object.keys(registry).map(function (k) {
      const mine = sendouts.filter(function (s) { return s.providerKey === k; });
      const m = metrics([], mine);
      return { key: k, name: registry[k].display, isProvider: registry[k].isProvider, total: m.sends, postAcute: m.paSends, longTerm: m.ltSends, paWithin: m.paWithin };
    }).filter(function (r) { return r.total > 0; })
      .sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });

    // --- Section 4: focus provider lists ------------------------------------
    let focusLists = null;
    if (focusReg) {
      const row = function (s) { return { date: s.date, dateLabel: fmtMD(s.date), resident: s.resident, timing: s.within ? 'Within ' + windowDays + ' days' : 'After ' + windowDays + ' days', reason: s.reason, assumed: !!s.timingAssumed }; };
      const sortDesc = function (a, b) { return b.date - a.date || a.resident.localeCompare(b.resident); };
      const mk = function (stay) { return focusSend.filter(function (s) { return s.stayFinal === stay; }).map(row).sort(sortDesc); };
      const reasonCounts = tally(focusSend.map(function (s) { return s.reason; }));
      focusLists = {
        postAcute: mk(POST_ACUTE), longTerm: mk(LONG_TERM),
        unclassified: focusSend.filter(function (s) { return s.stayFinal === UNCLASSIFIED; }).map(row).sort(sortDesc),
        within: focus.anyWithin, after: focus.sends - focus.anyWithin,
        reasonSentence: focusReasonSentence(reasonCounts, focus.sends, focusReg.display)
      };
    }

    // --- Section 5: reasons matrix ------------------------------------------
    const buildingReasons = tally(sendouts.map(function (s) { return s.reason; }));
    const otherCols = attribution.filter(function (a) { return a.key !== o.focusKey; });
    const cols = (focusReg ? [{ key: o.focusKey, label: shortName(focusReg) }] : [])
      .concat(otherCols.map(function (a) { return { key: a.key, label: shortName(registry[a.key]) }; }));
    const reasonRows = buildingReasons.map(function (r) {
      return { reason: r.label, building: r.n, cells: cols.map(function (c) { return count(sendouts, function (s) { return s.reason === r.label && s.providerKey === c.key; }); }) };
    });
    const reasonTotals = { building: sendouts.length, cells: cols.map(function (c) { return count(sendouts, function (s) { return s.providerKey === c.key; }); }) };
    const top6 = buildingReasons.slice(0, 6).reduce(function (a, r) { return a + r.n; }, 0);
    const reasonSentences = reasonTierSentences(buildingReasons, sendouts.length);
    const top6Sentence = sendouts.length ? 'The ' + numberWord(Math.min(6, buildingReasons.length)) + ' most frequent reported categories accounted for ' + top6 + ' of ' + sendouts.length + ' send-outs (' + fmtPct(top6, sendouts.length) + ').' : '';

    // --- Section 6: repeat send-outs ----------------------------------------
    const byRes = {};
    sendouts.forEach(function (s) { (byRes[s.residentKey] = byRes[s.residentKey] || []).push(s); });
    const repeats = Object.keys(byRes).filter(function (k) { return byRes[k].length >= 2; }).map(function (k) {
      const list = byRes[k].slice().sort(function (a, b) { return a.date - b.date; });
      return { resident: list[0].resident, sends: list.map(function (s) { return { dateLabel: fmtMD(s.date), reason: s.reason, provider: registry[s.providerKey].display, providerKey: s.providerKey }; }) };
    }).sort(function (a, b) { return a.resident.localeCompare(b.resident); });
    const repeatSends = repeats.reduce(function (a, r) { return a + r.sends.length; }, 0);
    const repeatSummary = repeatSentences(repeats, repeatSends, sendouts.length, focusReg, o.focusKey);

    // --- Section 7: disposition ---------------------------------------------
    const dispRows = [DISP_INPATIENT, DISP_OBSERVATION, DISP_UNCERTAIN].concat(
      sendouts.some(function (s) { return s.disposition === DISP_ED; }) ? [DISP_ED] : [],
      sendouts.some(function (s) { return s.disposition === DISP_OTHER; }) ? [DISP_OTHER] : []);
    const disposition = dispRows.map(function (d) {
      return { label: d, building: count(sendouts, function (s) { return s.disposition === d; }), focus: focusReg ? count(focusSend, function (s) { return s.disposition === d; }) : null };
    });
    const blankOutcome = count(sendouts, function (s) { return !s.dispositionRaw || /^other$/i.test(s.dispositionRaw); });
    if (blankOutcome) warnings.push({ level: 'warn', text: blankOutcome + ' send-out(s) have a blank or "Other" outcome in PCC; they are shown as "Admitted; status uncertain".' });
    const edOnly = count(sendouts, function (s) { return s.disposition === DISP_ED; });
    if (edOnly) warnings.push({ level: 'warn', text: edOnly + ' send-out(s) were ED visits only. They are counted as send-outs and listed on their own disposition row.' });
    const otherDisp = count(sendouts, function (s) { return s.disposition === DISP_OTHER; });
    if (otherDisp) warnings.push({ level: 'warn', text: otherDisp + ' send-out(s) have an unrecognised outcome (shown as "Other / not recorded"). Map the values below.' });
    const noReason = count(sendouts, function (s) { return s.reason === 'Not recorded'; });
    if (noReason) warnings.push({ level: 'warn', text: noReason + ' send-out(s) have no reason recorded in PCC; they appear as "Not recorded" in the reasons table.' });
    const plannedN = count(sendouts, function (s) { return s.planned; });
    if (plannedN) warnings.push({ level: 'warn', text: plannedN + ' send-out(s) are marked Planned in PCC and are counted. Use the checkbox in step 2 to skip planned transfers.' });

    return {
      windowDays: windowDays, period: { start: o.start, end: o.end, label: fmtPeriod(o.start, o.end) },
      focus: focusReg ? { key: focusReg.key, name: focusReg.display, short: shortName(focusReg) } : null,
      building: building, focusM: focus,
      shares: focus ? { admissions: fmtPct(focus.admissions, building.admissions), sends: fmtPct(focus.sends, building.sends) } : null,
      attribution: attribution,
      focusLists: focusLists,
      reasons: { cols: cols, rows: reasonRows, totals: reasonTotals, sentences: reasonSentences, top6: top6Sentence },
      repeats: { rows: repeats, summary: repeatSummary, count: repeats.length, sends: repeatSends },
      disposition: disposition,
      providers: Object.keys(registry).map(function (k) { return registry[k]; }).filter(function (r) { return r.isProvider; })
        .sort(function (a, b) { return a.display.localeCompare(b.display); }),
      warnings: warnings
    };
  }

  // --- sentence helpers --------------------------------------------------------

  function tally(labels) {
    const m = {};
    labels.forEach(function (l) { m[l] = (m[l] || 0) + 1; });
    return Object.keys(m).map(function (l) { return { label: l, n: m[l] }; })
      .sort(function (a, b) { return b.n - a.n || a.label.localeCompare(b.label); });
  }
  const NUMS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  function numberWord(n) { return n <= 20 ? NUMS[n] : String(n); }
  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function prose(label) {
    if (PROSE_LABELS[label]) return PROSE_LABELS[label];
    const base = label.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return base.charAt(0).toLowerCase() + base.slice(1);
  }
  function joinList(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
  }
  function groupByCount(tallied) {
    const tiers = [];
    tallied.forEach(function (t) {
      const last = tiers[tiers.length - 1];
      if (last && last.n === t.n) last.labels.push(t.label); else tiers.push({ n: t.n, labels: [t.label] });
    });
    return tiers;
  }

  /** Sentence under the focus provider's list of send-outs. */
  function focusReasonSentence(reasonCounts, total, who) {
    if (!total) return '';
    const tiers = groupByCount(reasonCounts);
    const top = tiers[0];
    let s;
    if (top.labels.length === 1) {
      s = who + '’s most frequent reported reason was ' + prose(top.labels[0]) + ': ' + top.n + ' of ' + total + ' send-outs (' + fmtPct(top.n, total) + ').';
    } else {
      s = cap1(joinList(top.labels.map(prose))) + ' were tied as ' + who + '’s most frequent reported reasons: ' + top.n + ' of ' + total + ' send-outs each (' + fmtPct(top.n, total) + ' each).';
    }
    if (tiers[1]) {
      const t = tiers[1], many = t.labels.length > 1;
      s += ' ' + cap1(joinList(t.labels.map(prose))) + (many ? ' each' : '') + ' accounted for ' + t.n + ' send-out' + (t.n === 1 ? '' : 's') + ' (' + fmtPct(t.n, total) + (many ? ' each' : '') + ').';
    }
    return s;
  }

  /** "X and Y were tied for the highest count..." for the building table. */
  function reasonTierSentences(tallied, total) {
    if (!total) return '';
    const tiers = groupByCount(tallied).slice(0, 3);
    return tiers.map(function (t, i) {
      const names = joinList(t.labels.map(prose));
      if (i === 0) {
        return t.labels.length === 1
          ? 'The most frequent reported reason was ' + names + ': ' + t.n + ' send-outs (' + fmtPct(t.n, total) + ').'
          : cap1(names) + ' were tied for the highest count: ' + t.n + ' send-outs each (' + fmtPct(t.n, total) + ' each).';
      }
      return t.labels.length === 1
        ? cap1(names) + ' accounted for ' + t.n + ' (' + fmtPct(t.n, total) + ').'
        : cap1(names) + ' each accounted for ' + t.n + ' (' + fmtPct(t.n, total) + ' each).';
    }).join(' ');
  }

  function repeatSentences(repeats, repeatSends, total, focusReg, focusKey) {
    if (!repeats.length) return 'No resident had more than one send-out in this period.';
    const byN = {};
    repeats.forEach(function (r) { byN[r.sends.length] = (byN[r.sends.length] || 0) + 1; });
    const parts = Object.keys(byN).sort(function (a, b) { return a - b; }).map(function (n) {
      return numberWord(byN[n]) + ' ' + (byN[n] === 1 ? 'resident' : 'residents') + ' ' + (byN[n] === 1 ? 'had' : 'had') + ' ' + numberWord(+n) + ' send-outs';
    });
    let s;
    if (parts.length === 1) {
      const n = Object.keys(byN)[0];
      s = cap1(numberWord(byN[n])) + ' ' + (byN[n] === 1 ? 'resident' : 'residents') + ' had ' + numberWord(+n) + ' send-outs' + (byN[n] === 1 ? '' : ' each');
    } else {
      s = cap1(joinList(parts));
    }
    s += ', accounting for ' + repeatSends + ' of ' + total + ' transfers (' + fmtPct(repeatSends, total) + ').';
    const allDistinct = repeats.filter(function (r) { return new Set(r.sends.map(function (x) { return x.reason; })).size === r.sends.length; }).length;
    if (allDistinct === repeats.length) s += ' Each resident’s transfers had different reported reasons.';
    else if (allDistinct === 0) s += ' In every case the transfers shared at least one reported reason.';
    else s += ' ' + cap1(numberWord(repeats.length - allDistinct)) + ' of these ' + (repeats.length - allDistinct === 1 ? 'residents' : 'residents') + ' had the same reported reason more than once.';
    const notes = [];
    if (focusReg) {
      repeats.forEach(function (r) {
        const mine = r.sends.filter(function (x) { return x.providerKey === focusKey; });
        if (!mine.length) return;
        const nm = residentFirstLast(r.resident);
        if (mine.length === r.sends.length) {
          notes.push(nm + ' had ' + numberWord(mine.length) + ' transfers recorded under ' + focusReg.display + '.');
        } else {
          const others = r.sends.filter(function (x) { return x.providerKey !== focusKey; });
          notes.push(nm + ' had ' + numberWord(mine.length) + ' recorded under ' + focusReg.display + ' and ' + joinList(others.map(function (x) { return numberWord(1) + ' recorded as “' + x.provider + '”'; })).replace(/one recorded as/g, 'one recorded as') + '.');
        }
      });
    }
    return { text: s, notes: notes };
  }

  // ---------------------------------------------------------------------------
  // Value inventory (for the "check your data" panel)
  // ---------------------------------------------------------------------------

  function distinct(events, getter) {
    const m = {};
    events.forEach(function (e) { const v = getter(e); m[v] = (m[v] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { value: k, n: m[k] }; }).sort(function (a, b) { return b.n - a.n; });
  }

  const api = {
    POST_ACUTE: POST_ACUTE, LONG_TERM: LONG_TERM, UNCLASSIFIED: UNCLASSIFIED,
    DISP_INPATIENT: DISP_INPATIENT, DISP_OBSERVATION: DISP_OBSERVATION, DISP_UNCERTAIN: DISP_UNCERTAIN, DISP_ED: DISP_ED, DISP_OTHER: DISP_OTHER,
    FIELD_DEFS: FIELD_DEFS, CANONICAL_REASONS: CANONICAL_REASONS,
    parseCsv: parseCsv, findHeaderRow: findHeaderRow, detectMapping: detectMapping,
    parseDate: parseDate, dayToISO: dayToISO, fmtMD: fmtMD, fmtPeriod: fmtPeriod,
    parsePerson: parsePerson, providerDisplay: providerDisplay, residentFirstLast: residentFirstLast,
    classifyStay: classifyStay, classifyDisposition: classifyDisposition, classifyEventType: classifyEventType,
    rowsToEvents: rowsToEvents, dedupe: dedupe, buildReport: buildReport, distinct: distinct,
    numberWord: numberWord, fmtPct: fmtPct
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RTH = api;
})(typeof window !== 'undefined' ? window : this);
