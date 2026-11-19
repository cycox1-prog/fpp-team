// Run with:  node rth-report/test/core.test.js
// All names below are fictional.
'use strict';
const assert = require('assert');
const C = require('../src/core.js');

let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; } }

const day = C.parseDate;

t('parseCsv handles quotes, commas, CRLF, BOM', () => {
  const rows = C.parseCsv('﻿a,b\r\n"Doe, Jane","say ""hi"""\r\n\r\nx,y\r\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['Doe, Jane', 'say "hi"'], ['x', 'y']]);
});

t('parseDate formats', () => {
  assert.strictEqual(C.dayToISO(day('09/30/2026')), '2026-09-30');
  assert.strictEqual(C.dayToISO(day('9/3/26')), '2026-09-03');
  assert.strictEqual(C.dayToISO(day('2026-09-30 14:22')), '2026-09-30');
  assert.strictEqual(C.dayToISO(day('09/30/2026 2:15 PM')), '2026-09-30');
  assert.strictEqual(day('02/31/2026'), null);
  assert.strictEqual(day('garbage'), null);
});

t('fmtPeriod', () => {
  assert.strictEqual(C.fmtPeriod(day('08/01/2026'), day('10/01/2026')), 'August 1 - October 1, 2026');
  assert.strictEqual(C.fmtPeriod(day('12/01/2025'), day('01/31/2026')), 'December 1, 2025 - January 31, 2026');
});

t('header row detection skips PCC title lines', () => {
  const rows = C.parseCsv('Facility: Demo Rehab\nRun date: 10/02/2026\nEvent Type,Event Date,Resident Name,Provider\nAdmission,08/02/2026,"Aaron, Ann",Rivera');
  const h = C.findHeaderRow(rows);
  assert.strictEqual(h, 2);
  const m = C.detectMapping(rows[h]);
  assert.deepStrictEqual([m.eventType, m.date, m.resident, m.provider], [0, 1, 2, 3]);
});

t('provider names merge across formats and get titles', () => {
  const a = C.parsePerson('WIELEBINSKI, PAUL MD');
  const b = C.parsePerson('Dr. Paul Wielebinski');
  const c = C.parsePerson('Ward, Tzirel NP');
  assert.strictEqual(a.key, b.key);
  assert.strictEqual(C.providerDisplay(a), 'Dr. Paul Wielebinski');
  assert.strictEqual(C.providerDisplay(c), 'Tzirel Ward');
  assert.strictEqual(C.providerDisplay(C.parsePerson('Emergency Transfer')), 'Emergency Transfer');
  assert.strictEqual(C.parsePerson('Gonzalez Quiles, Gian').last, 'Gonzalez Quiles');
});

t('classifiers', () => {
  assert.strictEqual(C.classifyStay('Post-Acute'), 'post-acute');
  assert.strictEqual(C.classifyStay('Long Term Care'), 'long-term');
  assert.strictEqual(C.classifyStay('Medicare A'), 'post-acute');
  assert.strictEqual(C.classifyStay('Hospice'), 'unclassified');
  assert.strictEqual(C.classifyStay('Hospice', { hospice: 'long-term' }), 'long-term');
  assert.strictEqual(C.classifyDisposition('Observation Stay'), 'Observation');
  assert.strictEqual(C.classifyDisposition('Admitted - Inpatient'), 'Inpatient');
  assert.strictEqual(C.classifyDisposition('Admitted'), 'Admitted; status uncertain');
  assert.strictEqual(C.classifyDisposition(''), 'Admitted; status uncertain'); // blank PCC outcome
  assert.strictEqual(C.classifyDisposition('Other'), 'Admitted; status uncertain');
  assert.strictEqual(C.classifyDisposition('ED Visit Only'), 'ED visit only (not admitted)');
  assert.strictEqual(C.classifyDisposition('Admitted, Inpatient'), 'Inpatient');
  assert.strictEqual(C.classifyDisposition('Something new'), 'Other / not recorded');
  assert.strictEqual(C.classifyEventType('Hospital Transfer'), 'sendout');
  assert.strictEqual(C.classifyEventType('Admission'), 'admission');
  assert.strictEqual(C.classifyEventType('Discharge Home'), null);
});

// ---- A small fixture with hand-counted answers ----------------------------------
const CSV = [
  'Event Type,Event Date,Resident Name,Resident ID,Provider,Stay Type,Reason,Disposition,Admit Date',
  // 6 admissions in range (4 Rivera: 3 PA + 1 LT; 2 Chen: 1 PA + 1 LT)
  'Admission,08/02/2026,"Aaron, Ann",1,"Rivera, Sam MD",Post-Acute,,,',
  'Admission,08/05/2026,"Baker, Bob",2,"Rivera, Sam MD",Post-Acute,,,',
  'Admission,08/20/2026,"Cole, Cy",3,"Rivera, Sam MD",Post-Acute,,,',
  'Admission,09/01/2026,"Dunn, Di",4,"Rivera, Sam MD",Long-Term,,,',
  'Admission,09/02/2026,"Eli, Ed",5,"Chen, Jo NP",Post-Acute,,,',
  'Admission,09/10/2026,"Fox, Flo",6,"Chen, Jo NP",Long-Term,,,',
  // outside range, must be ignored for counts (but used for lookback)
  'Admission,07/25/2026,"Gray, Gus",7,"Chen, Jo NP",Post-Acute,,,',
  'Admission,06/01/2026,"Hall, Hal",8,"Rivera, Sam MD",Long-Term,,,',
  // 7 send-outs
  'Send-out,08/10/2026,"Aaron, Ann",1,"Rivera, Sam MD",Post-Acute,Altered mental status,Inpatient,',      // 8 days after 8/2 -> within
  'Send-out,09/25/2026,"Aaron, Ann",1,"Chen, Jo NP",Post-Acute,Fall,Observation,',                        // 54 days -> after; repeat resident w/ Aaron
  'Send-out,09/20/2026,"Baker, Bob",2,"Rivera, Sam MD",Post-Acute,altered mental status,Admitted,',      // after 30
  'Send-out,09/15/2026,"Dunn, Di",4,"Rivera, Sam MD",,Other,Inpatient,',                                  // stay from admission (LT), 14 days -> within
  'Send-out,08/25/2026,"Gray, Gus",7,"Emergency Transfer",Post-Acute,GI bleeding,Inpatient,',             // 31 days after 7/25 -> after
  'Send-out,08/12/2026,"Hall, Hal",8,"Chen, Jo NP",Long-Term,Seizure,Inpatient,',                         // LT, 72 days -> after
  'Send-out,09/12/2026,"Fox, Flo",6,"Chen, Jo NP",Long-Term,Fall,,',                                      // LT, 2 days -> within; blank disposition
  // out of range send-out
  'Send-out,10/20/2026,"Fox, Flo",6,"Chen, Jo NP",Long-Term,Fall,Inpatient,',
  // junk
  'Discharge,09/01/2026,"Fox, Flo",6,"Chen, Jo NP",,,,',
  'Admission,not-a-date,"Zed, Zed",9,"Chen, Jo NP",Post-Acute,,,'
].join('\n');

function load(csv) {
  const rows = C.parseCsv(csv);
  const h = C.findHeaderRow(rows);
  const mapping = C.detectMapping(rows[h]);
  const out = C.rowsToEvents(rows.slice(h + 1), mapping, {});
  return out;
}
const range = { start: day('08/01/2026'), end: day('10/01/2026') };

t('rowsToEvents counts issues', () => {
  const { events, issues } = load(CSV);
  assert.strictEqual(issues.badDate, 1);
  assert.strictEqual(issues.unknownEventType, 1);
  assert.strictEqual(events.length, 8 + 8); // 8 admissions + 8 send-outs; discharge and bad date dropped
});

t('building metrics match hand count', () => {
  const { events } = load(CSV);
  const r = C.buildReport(events, Object.assign({ focusKey: null }, range));
  const b = r.building;
  assert.strictEqual(b.admissions, 6);
  assert.strictEqual(b.paAdm, 4);
  assert.strictEqual(b.ltAdm, 2);
  assert.strictEqual(b.sends, 7);
  assert.strictEqual(b.paSends, 4);
  assert.strictEqual(b.ltSends, 3);
  assert.strictEqual(b.paWithin, 1);   // Aaron 8/10
  assert.strictEqual(b.ltWithin, 2);   // Dunn, Fox
  assert.strictEqual(b.residents, 6);  // Aaron x2 counts once
  assert.strictEqual(C.fmtPct(b.sends, b.admissions), '116.7%'); // can exceed 100%: that's what the report does
  assert.strictEqual(C.fmtPct(b.paWithin, b.admissions), '16.7%');
});

t('focus provider metrics, attribution and shares', () => {
  const { events } = load(CSV);
  const key = C.parsePerson('Rivera, Sam MD').key;
  const r = C.buildReport(events, Object.assign({ focusKey: key }, range));
  assert.strictEqual(r.focus.name, 'Dr. Sam Rivera');
  assert.strictEqual(r.focusM.admissions, 4);
  assert.strictEqual(r.focusM.sends, 3);
  assert.strictEqual(r.focusM.paSends, 2);
  assert.strictEqual(r.focusM.ltSends, 1);
  assert.strictEqual(r.focusM.paWithin, 1);
  assert.strictEqual(r.shares.admissions, '66.7%');
  assert.strictEqual(r.shares.sends, '42.9%');
  const names = r.attribution.map(a => a.name + ':' + a.total);
  assert.deepStrictEqual(names, ['Dr. Sam Rivera:3', 'Jo Chen:3', 'Emergency Transfer:1']); // total desc, ties by name
  assert.strictEqual(r.attribution.reduce((a, x) => a + x.total, 0), 7);
  assert.ok(!r.providers.some(p => p.display === 'Emergency Transfer'), 'non-providers get no report');
});

t('reasons: case-insensitive merge, tie ordering, matrix columns', () => {
  const { events } = load(CSV);
  const key = C.parsePerson('Rivera, Sam MD').key;
  const r = C.buildReport(events, Object.assign({ focusKey: key }, range));
  const ams = r.reasons.rows.find(x => x.reason === 'Altered mental status');
  assert.strictEqual(ams.building, 2);
  assert.deepStrictEqual(r.reasons.cols.map(c => c.label), ['Rivera', 'Chen', 'Emergency Transfer']);
  assert.deepStrictEqual(ams.cells, [2, 0, 0]);
  // each row's cells must sum to its building count
  r.reasons.rows.forEach(row => assert.strictEqual(row.cells.reduce((a, b) => a + b, 0), row.building));
  assert.strictEqual(r.reasons.totals.building, 7);
});

t('repeat residents and sentence', () => {
  const { events } = load(CSV);
  const key = C.parsePerson('Rivera, Sam MD').key;
  const r = C.buildReport(events, Object.assign({ focusKey: key }, range));
  assert.strictEqual(r.repeats.count, 1);
  assert.strictEqual(r.repeats.rows[0].resident, 'Aaron, Ann');
  assert.ok(/One resident had two send-outs, accounting for 2 of 7 transfers \(28\.6%\)/.test(r.repeats.summary.text), r.repeats.summary.text);
  assert.ok(/different reported reasons/.test(r.repeats.summary.text));
  assert.ok(/Ann Aaron had one recorded under Dr\. Sam Rivera and one recorded as/.test(r.repeats.summary.notes[0]), r.repeats.summary.notes[0]);
});

t('disposition rows', () => {
  const { events } = load(CSV);
  const r = C.buildReport(events, Object.assign({ focusKey: null }, range));
  const d = Object.fromEntries(r.disposition.map(x => [x.label, x.building]));
  assert.strictEqual(d['Inpatient'], 4);
  assert.strictEqual(d['Observation'], 1);
  assert.strictEqual(d['Admitted; status uncertain'], 2); // 'Admitted' + the blank outcome
  assert.strictEqual(d['Other / not recorded'], undefined);
});

t('unclassified stay types are surfaced as an error warning', () => {
  const csv = 'Event Type,Event Date,Resident Name,Provider,Stay Type,Reason\nAdmission,08/02/2026,"A, A",X,Hospice,\nSend-out,08/03/2026,"A, A",X,Hospice,Fall';
  const { events } = load(csv);
  const r = C.buildReport(events, Object.assign({ focusKey: null }, range));
  assert.ok(r.warnings.some(w => w.level === 'error' && /stay type/.test(w.text)));
});

t('missing admit info is flagged, treated as after 30 days', () => {
  const csv = 'Event Type,Event Date,Resident Name,Provider,Stay Type,Reason\nAdmission,08/02/2026,"B, B",X,Long-Term,\nSend-out,08/03/2026,"Q, Q",X,Long-Term,Fall';
  const { events } = load(csv);
  const r = C.buildReport(events, Object.assign({ focusKey: null }, range));
  assert.strictEqual(r.building.ltWithin, 0);
  assert.ok(r.warnings.some(w => /no admit date/.test(w.text)));
});

t('two-file layout (admissions file + send-out file) with explicit kinds', () => {
  const adm = C.parseCsv('Admission Date,Resident,Provider,Stay Type\n08/02/2026,"A, A",X,Post-Acute');
  const snd = C.parseCsv('Transfer Date,Resident,Provider,Reason,Disposition\n08/09/2026,"A, A",X,Fall,Inpatient');
  const a = C.rowsToEvents(adm.slice(1), C.detectMapping(adm[0]), { fileKind: 'admission' });
  const s = C.rowsToEvents(snd.slice(1), C.detectMapping(snd[0]), { fileKind: 'sendout' });
  const r = C.buildReport(a.events.concat(s.events), Object.assign({ focusKey: null }, range));
  assert.strictEqual(r.building.admissions, 1);
  assert.strictEqual(r.building.paWithin, 1); // stay type + timing both derived from the admission
});

t('dedupe removes exact duplicates only', () => {
  const csv = 'Event Type,Event Date,Resident Name,Provider,Stay Type,Reason\nSend-out,08/03/2026,"A, A",X,Long-Term,Fall\nSend-out,08/03/2026,"A, A",X,Long-Term,Fall\nSend-out,08/03/2026,"A, A",X,Long-Term,Seizure';
  const { events } = load(csv);
  const d = C.dedupe(events);
  assert.strictEqual(d.removed, 1);
  assert.strictEqual(d.events.length, 2);
});

t('prose helpers: tie language and number words', () => {
  const { events } = load(CSV);
  const r = C.buildReport(events, Object.assign({ focusKey: null }, range));
  // Altered mental status (2) and Fall (2) tie for the top spot
  assert.ok(/^Altered mental status and falls were tied for the highest count: 2 send-outs each \(28\.6% each\)\./.test(r.reasons.sentences), r.reasons.sentences);
  assert.strictEqual(C.numberWord(7), 'seven');
  assert.strictEqual(C.numberWord(25), '25');
});

t('PCC admissionLog format: sep= line, 2-digit years, numeric ids, Include Rate', () => {
  const csv = [
    'sep=,',
    'MR#,Resident,Date of Admission,Day,Time of Day,Hospital Discharge Date,Admission Status,To/From Type,Admitted From,Payer (Type),Primary Physician,30-Day Message,Include Rate',
    '1001,1001,10/21/26 12:30 PM,Wednesday,Afternoon,10/21/2026,Post Acute,Hospital,12532,Medicare A (Medicare A),24682,At risk of re-hospitalization,Yes',
    '1002,1002,10/22/26 4:45 PM,Thursday,Afternoon,,Post Acute,Hospital,12532,Medicare A (Medicare A),42220,Transferred to Hospital,Yes',
    '1003,1003,10/29/26 2:05 PM,Thursday,Afternoon,,Chronic Long-Term,Hospital,12532,Medicaid Humana HMO (Medicaid),55636,Transferred to Hospital,Yes',
    '1001,1001,11/09/26 5:40 PM,Monday,Afternoon,,Post Acute,Hospital,606,Medicare A (Medicare A),24682,At risk of re-hospitalization,Yes',
    '1004,1004,11/10/26 2:00 AM,Tuesday,Night,11/10/2026,Post Acute,Hospital,606,Medicare A (Medicare A),24682,At risk of re-hospitalization,No',
    ''
  ].join('\n');
  const rows = C.parseCsv(csv);
  const h = C.findHeaderRow(rows);
  assert.strictEqual(h, 1);
  const m = C.detectMapping(rows[h]);
  assert.strictEqual(rows[h][m.date], 'Date of Admission');
  assert.strictEqual(rows[h][m.stayType], 'Admission Status');
  assert.strictEqual(rows[h][m.provider], 'Primary Physician');
  assert.strictEqual(rows[h][m.residentId], 'MR#');
  assert.strictEqual(m.disposition, undefined);
  assert.strictEqual(m.admitDate, undefined);
  const out = C.rowsToEvents(rows.slice(h + 1), m, {});
  assert.strictEqual(out.issues.excludedByRate, 1);
  assert.strictEqual(out.events.length, 4);
  assert.ok(out.events.every(e => e.type === 'admission'));
  assert.strictEqual(C.dayToISO(out.events[0].date), '2026-10-21');
  const r = C.buildReport(out.events, { start: day('10/01/2026'), end: day('11/30/2026'), focusKey: null });
  assert.strictEqual(r.building.admissions, 4);
  assert.strictEqual(r.building.paAdm, 3);
  assert.strictEqual(r.building.ltAdm, 1);
  assert.strictEqual(r.building.pccFlaggedPa, 1); // only the post-acute "Transferred to Hospital"
  assert.strictEqual(r.providers.length, 3, 'numeric provider ids must stay distinct');
  // switching the option off keeps the Include Rate = No row
  const all = C.rowsToEvents(rows.slice(h + 1), m, { respectIncludeRate: false });
  assert.strictEqual(all.events.length, 5);
});

t('PCC transferLog format + admission log together', () => {
  const adm = 'sep=,\nMR#,Resident,Date of Admission,Admission Status,Primary Physician,Include Rate\n' + [
    '1,1,10/28/26 2:40 PM,Post Acute,111,Yes', '2,2,11/06/26 4:45 PM,Post Acute,111,Yes', '3,3,11/02/26 9:00 AM,Chronic Long-Term,222,Yes'].join('\n');
  const tr = 'sep=,\nMR#,Resident,Date of Transfer,Purpose of Stay,Primary Physician,Ordered By,Reason,Other Reason for Transfer,Planned,Outcome,Original Admission Date,Last Admission Date,Length Of Stay,30-Day Message,Included in Rates\n' + [
    // duplicate pair on the same day: one blank outcome, one with outcome -> one event, outcome kept
    '1,1,11/19/26 11:42 AM,Post Acute,111,111,Gl bleeding,,No,,10/28/26 2:40 PM,10/28/26 2:40 PM,22,Transferred to Hospital,Yes',
    '1,1,11/19/26 3:16 PM,Post Acute,111,111,Gl bleeding,,No,"Admitted, Inpatient",10/28/26 2:40 PM,10/28/26 2:40 PM,22,Transferred to Hospital,Yes',
    '2,2,11/20/26 1:00 PM,Post Acute,111,ET,"Shortness of Breath (bronchitis, pneumonia)",,No,ED Visit Only,11/06/26 4:45 PM,11/06/26 4:45 PM,14,Transferred to Hospital,Yes',
    '3,3,11/21/26 1:00 PM,Chronic Long-Term,222,333,Other,could not remove foley,Yes,,3/8/25 12:12 PM,11/02/26 9:00 AM,50,,Yes',
    '4,4,11/22/26 1:00 PM,Chronic Long-Term,222,222,,,No,"Admitted, Observation",3/8/25 12:12 PM,5/02/26 9:00 AM,200,,Yes'].join('\n');
  const ld = (csv, opts) => { const r = C.parseCsv(csv), h = C.findHeaderRow(r), m = C.detectMapping(r[h]); return { m, h: r[h], out: C.rowsToEvents(r.slice(h + 1), m, opts || {}) }; };
  const A = ld(adm), T = ld(tr);
  assert.strictEqual(T.h[T.m.provider], 'Ordered By');          // send-out attribution beats Primary Physician
  assert.strictEqual(T.h[T.m.stayType], 'Purpose of Stay');
  assert.strictEqual(T.h[T.m.daysSinceAdmit], 'Length Of Stay');
  assert.strictEqual(T.h[T.m.admitDate], 'Last Admission Date');
  assert.strictEqual(T.h[T.m.date], 'Date of Transfer');
  assert.strictEqual(T.h[T.m.includeRate], 'Included in Rates');
  assert.ok(T.out.events.every(e => e.type === 'sendout'));
  const d = C.dedupe(A.out.events.concat(T.out.events));
  assert.strictEqual(d.removed, 1);
  const r = C.buildReport(d.events, { start: day('10/01/2026'), end: day('11/30/2026'), focusKey: null });
  const b = r.building;
  assert.strictEqual(b.admissions, 3);
  assert.strictEqual(b.sends, 4);
  assert.strictEqual(b.paSends, 2); assert.strictEqual(b.ltSends, 2);
  assert.strictEqual(b.paWithin, 2); assert.strictEqual(b.ltWithin, 0); // LOS 22, 14 within; 50, 200 not
  const names = r.attribution.map(a => a.name);
  assert.ok(names.includes('Emergency Transfer'), 'ET -> Emergency Transfer');
  const disp = Object.fromEntries(r.disposition.map(x => [x.label, x.building]));
  assert.strictEqual(disp['Inpatient'], 1);          // the duplicate's outcome was kept
  assert.strictEqual(disp['Observation'], 1);
  assert.strictEqual(disp['ED visit only (not admitted)'], 1);
  assert.strictEqual(disp['Admitted; status uncertain'], 1);
  assert.ok(r.reasons.rows.some(x => x.reason === 'GI bleeding'), 'typo "Gl bleeding" folded into GI bleeding');
  assert.ok(r.warnings.some(w => /Planned/.test(w.text)));
  assert.strictEqual(ld(tr, { skipPlanned: true }).out.events.length, T.out.events.length - 1);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
