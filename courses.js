'use strict';
/* Courses: slide-based training with an end-of-course quiz, assigned by role and tracked per person.
   Loaded before app.js; everything here runs at call time, so app.js globals (db, ui, esc, …) are available. */

/* ---------- content format ----------
   Slides: separated by a line with just ---. First "# Heading" line is the slide title.
     Supports ## subheadings, - bullets, > callouts, **bold**, *italic*,
     ![alt](https://image-url) and @video https://youtube/vimeo/mp4-url on their own lines.
   Quiz:  Q: question text
          - wrong option
          * correct option (exactly one)
          > optional explanation shown after the attempt                                   */

function inlineMd(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

const embedFrame = src => `<div class="media video"><iframe src="${src}" title="Course video" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;

function videoHtml(url) {
  let m;
  if ((m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/))) return embedFrame(`https://www.youtube-nocookie.com/embed/${m[1]}`);
  if ((m = url.match(/vimeo\.com\/(\d+)/))) return embedFrame(`https://player.vimeo.com/video/${m[1]}`);
  if (/\.(mp4|webm)(\?|$)/i.test(url)) return `<video class="media" src="${esc(url)}" controls preload="metadata"></video>`;
  return `<p><a href="${esc(url)}" target="_blank" rel="noopener">Open video</a></p>`;
}

function md(src) {
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) out.push(`<p>${para.map(inlineMd).join(' ')}</p>`); para = []; };
  const flushL = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const addItem = (tag, text) => { flushP(); if (list?.tag !== tag) { flushL(); list = { tag, items: [] }; } list.items.push(text); };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flushP(); flushL(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flushP(); flushL(); const h = m[1].length + 1; out.push(`<h${h}>${inlineMd(m[2])}</h${h}>`); }
    else if ((m = line.match(/^[-*]\s+(.*)/))) addItem('ul', m[1]);
    else if ((m = line.match(/^\d+[.)]\s+(.*)/))) addItem('ol', m[1]);
    else if ((m = line.match(/^>\s?(.*)/))) { flushP(); flushL(); out.push(`<div class="callout">${inlineMd(m[1])}</div>`); }
    else if ((m = line.match(/^!\[(.*?)\]\((https:\/\/[^\s)]+)\)$/))) { flushP(); flushL(); out.push(`<img class="media" src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy">`); }
    else if ((m = line.match(/^@video\s+(https:\/\/\S+)$/))) { flushP(); flushL(); out.push(videoHtml(m[1])); }
    else { flushL(); para.push(line); }
  }
  flushP(); flushL();
  return out.join('');
}

function parseSlides(text) {
  return String(text || '').split(/^\s*---\s*$/m).map(s => s.trim()).filter(Boolean).map((s, i) => {
    const m = s.match(/^#\s+(.+)$/m);
    return { title: m ? m[1].trim() : `Slide ${i + 1}`, html: md(m ? s.replace(m[0], '') : s) };
  });
}

function parseQuiz(text) {
  const qs = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) continue;
    if ((m = line.match(/^Q:\s*(.+)/i))) qs.push(cur = { q: m[1], options: [], explain: '' });
    else if (!cur) continue;
    else if ((m = line.match(/^([-*])\s+(.+)/))) cur.options.push({ text: m[2], correct: m[1] === '*' });
    else if ((m = line.match(/^>\s?(.+)/))) cur.explain += (cur.explain ? ' ' : '') + m[1];
    else cur.q += ' ' + line;
  }
  return qs;
}

function quizErrors(qs) {
  return qs.flatMap((q, i) => {
    const n = q.options.filter(o => o.correct).length;
    return [
      q.options.length < 2 ? `Question ${i + 1} needs at least two options.` : null,
      n !== 1 ? `Question ${i + 1} needs exactly one correct option (marked with *), found ${n}.` : null
    ].filter(Boolean);
  });
}

/* ---------- assignment & status ---------- */
const course = id => db.courses.find(c => c.id === id);
/** A published course applies to everyone in its groups, or to everyone when it has no groups. */
const isAssigned = (c, u) => c.status === 'published' && !!u && (!c.groups.length || c.groups.includes(u.group));
const groupsText = c => c.groups.length ? c.groups.map(g => GROUPS[g]).join(', ') : 'everyone';
const byGroup = (a, b) => Object.keys(GROUPS).indexOf(a.group) - Object.keys(GROUPS).indexOf(b.group) || a.name.localeCompare(b.name);
const recordsOf = (c, userId) => db.progress.filter(p => p.courseId === c.id && p.userId === userId && p.version === c.version && !p.void)
  .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

const STATE_LABEL = { done: 'Complete', expiring: 'Renew soon', expired: 'Expired', overdue: 'Overdue', progress: 'In progress', new: 'Not started' };
const STATE_CLASS = { done: 'ok', expiring: 'warn', expired: 'bad', overdue: 'bad', progress: 'warn', new: '' };
const STATE_RANK = { overdue: 0, expired: 1, expiring: 2, progress: 3, new: 4, done: 5 };

/** Where a person stands on a course: state, due/expiry dates and percent through it. */
function courseState(c, userId) {
  const recs = recordsOf(c, userId);
  const p = recs[0];
  const lastDone = recs.find(r => r.completedAt);
  const steps = parseSlides(c.slides).length + (parseQuiz(c.quiz).length ? 1 : 0);
  let due = addDays(c.assignedAt, c.dueDays);
  let expires = null;
  if (lastDone && c.recertMonths) due = expires = addMonths(ymd(new Date(lastDone.completedAt)), c.recertMonths);
  if (p?.completedAt) {
    const done = ymd(new Date(p.completedAt));
    if (expires && today() >= expires) return { state: 'expired', p, done, due, expires, pct: 0 };
    if (expires && addDays(today(), 30) >= expires) return { state: 'expiring', p, done, due, expires, pct: 100 };
    return { state: 'done', p, done, expires, pct: 100 };
  }
  const pct = p ? Math.round(100 * Math.min(p.viewed, steps) / Math.max(steps, 1)) : 0;
  if (today() > due) return { state: lastDone ? 'expired' : 'overdue', p, due, pct };
  return { state: p ? 'progress' : 'new', p, due, pct };
}

function stateText(st) {
  switch (st.state) {
    case 'done': return `Completed ${fmtDay(st.done)}${st.expires ? ` · renews ${fmtDay(st.expires)}` : ''}`;
    case 'expiring': return `Completed ${fmtDay(st.done)} · renew by ${fmtDay(st.expires)}`;
    case 'expired': return `Expired ${fmtDay(st.due)}, retake required`;
    case 'overdue': return `Was due ${fmtDay(st.due)}`;
    default: return `Due ${fmtDay(st.due)}`;
  }
}

const courseMeta = c => {
  const s = parseSlides(c.slides).length, q = parseQuiz(c.quiz).length;
  return `${s} slide${s === 1 ? '' : 's'} · ${q ? `${q}-question quiz` : 'no quiz'} · about ${Math.max(5, Math.round(s * 1.5 + q * 0.5))} min`;
};
const bar = pct => `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;

/* ---------- staff views ---------- */
function myCourses(u) {
  return db.courses.filter(c => isAssigned(c, u)).map(c => ({ c, st: courseState(c, u.id) }))
    .sort((a, b) => STATE_RANK[a.st.state] - STATE_RANK[b.st.state] || (a.st.due ?? '').localeCompare(b.st.due ?? ''));
}

function courseButton(c, st) {
  const label = { done: 'Review', expiring: 'Review', expired: 'Retake', overdue: st.p ? 'Continue' : 'Start', progress: 'Continue', new: 'Start' }[st.state];
  return `<button class="${st.state === 'done' || st.state === 'expiring' ? '' : 'primary'}" data-act="open-course" data-id="${c.id}">${label}</button>`;
}

function trainingCard(u) {
  const todo = myCourses(u).filter(x => x.st.state !== 'done');
  return `<div class="card"><div class="row between"><h2>${isAdmin() ? 'My required training' : 'Required training'}</h2>${isAdmin() ? '' : '<button class="link" data-act="tab" data-id="courses">All courses</button>'}</div>
    ${todo.length ? todo.map(({ c, st }) => `<div class="shift"><div><strong>${esc(c.title)}</strong><br>
      <span class="small">${stateText(st)}</span> <span class="badge ${STATE_CLASS[st.state]}">${STATE_LABEL[st.state]}</span></div>${courseButton(c, st)}</div>`).join('')
      : '<p class="muted">All required training is complete. ✅</p>'}</div>`;
}

function viewCourses() {
  if (isAdmin()) return viewCoursesAdmin() + (myCourses(me()).length ? trainingCard(me()) : '');
  const list = myCourses(me());
  const done = list.filter(x => x.st.state === 'done' || x.st.state === 'expiring').length;
  return `<div class="row between" style="margin-bottom:12px"><h1 style="margin:0">Courses</h1>
      <span class="badge ${done === list.length ? 'ok' : ''}">${done} of ${list.length} complete</span></div>
    ${list.length ? list.map(({ c, st }) => `<div class="card">
      <div class="row between"><h2 style="margin:0">${esc(c.title)}</h2><span class="badge ${STATE_CLASS[st.state]}">${STATE_LABEL[st.state]}</span></div>
      ${c.summary ? `<p class="muted" style="margin:.4rem 0">${esc(c.summary)}</p>` : ''}
      <p class="small" style="margin:.2rem 0 .5rem">${courseMeta(c)} · pass with ${c.passPct}%</p>
      ${st.state === 'progress' || (st.state === 'overdue' && st.p) ? bar(st.pct) : ''}
      <div class="row between" style="margin-top:.5rem"><span class="small">${stateText(st)}</span>
        ${courseButton(c, st)}</div>
    </div>`).join('') : '<div class="card"><p class="muted">No courses are assigned to you yet.</p></div>'}`;
}

/* ---------- player ---------- */
function startCourse(id, preview) {
  const c = course(id);
  preview = preview || !isAssigned(c, me());
  const n = parseSlides(c.slides).length;
  let idx = 0;
  if (!preview) {
    const st = courseState(c, ui.userId);
    let p = st.p;
    if (!p || (st.state === 'expired' && p.completedAt)) {
      p = { id: uid(), courseId: c.id, userId: ui.userId, version: c.version, startedAt: new Date().toISOString(), viewed: 1, at: 0, attempts: [] };
      db.progress.push(p);
      save();
    }
    if (!p.completedAt) idx = Math.min(p.at, n - 1);
  }
  ui.play = { courseId: id, mode: 'slides', idx, preview };
  ui.resetScroll = true;
}

const playRecord = () => ui.play.preview ? null : recordsOf(course(ui.play.courseId), ui.userId)[0];

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

function beginQuiz() {
  const qs = parseQuiz(course(ui.play.courseId).quiz);
  Object.assign(ui.play, { mode: 'quiz', order: shuffle(qs.map((_, i) => i)), optOrder: qs.map(q => shuffle(q.options.map((_, i) => i))) });
  ui.resetScroll = true;
}

function finish(result) {
  const p = playRecord();
  if (p && result.passed && !p.completedAt) {
    p.completedAt = new Date().toISOString();
    p.score = result.pct;
    p.viewed = Math.max(p.viewed, parseSlides(course(p.courseId).slides).length + 1);
  }
  save();
  Object.assign(ui.play, { mode: 'result', result });
  ui.resetScroll = true;
}

function viewPlayer() {
  const c = course(ui.play.courseId);
  if (!c) { ui.play = null; return viewCourses(); }
  const slides = parseSlides(c.slides);
  const qs = parseQuiz(c.quiz);
  const pl = ui.play;
  const steps = slides.length + (qs.length ? 1 : 0);
  const head = `<div class="row between player-head">
      <button data-act="exit-course">‹ Courses</button>
      <span class="small muted">${pl.mode === 'slides' ? `Slide ${pl.idx + 1} of ${slides.length}` : pl.mode === 'quiz' ? 'Quiz' : 'Results'}</span></div>
    <h1 class="course-title">${esc(c.title)}</h1>
    ${bar(pl.mode === 'slides' ? Math.round(100 * (pl.idx + 1) / steps) : 100)}
    ${pl.preview ? '<div class="banner" style="margin-top:10px">Preview: nothing is recorded.</div>' : ''}`;

  if (pl.mode === 'slides') {
    const s = slides[pl.idx];
    const last = pl.idx === slides.length - 1;
    return `<div class="player">${head}
      <article class="card slide" aria-labelledby="slide-title"><h2 id="slide-title">${esc(s.title)}</h2>${s.html}</article>
      <div class="row between">
        <button data-act="slide-prev" ${pl.idx === 0 ? 'disabled' : ''}>Back</button>
        <button class="primary" data-act="slide-next">${last ? (qs.length ? 'Start quiz' : 'Finish course') : 'Next'}</button>
      </div></div>`;
  }

  if (pl.mode === 'quiz') {
    return `<div class="player">${head}
      <form id="quiz-form" class="card quiz">
        <p class="muted small">Answer all ${qs.length} questions. You need ${c.passPct}% to pass, and you can retake the quiz.</p>
        ${pl.order.map((qi, n) => {
          const q = qs[qi];
          return `<fieldset><legend>${n + 1}. ${inlineMd(q.q)}</legend>
            ${pl.optOrder[qi].map(oi => `<label class="opt"><input type="radio" name="q${qi}" value="${oi}" required> <span>${inlineMd(q.options[oi].text)}</span></label>`).join('')}</fieldset>`;
        }).join('')}
        <div class="row between"><button type="button" data-act="slide-review">Review slides</button><button class="primary" type="submit">Submit answers</button></div>
      </form></div>`;
  }

  const r = pl.result;
  return `<div class="player">${head}
    <div class="card result">
      ${r.pct != null ? `<div class="score ${r.passed ? 'pass' : 'fail'}">${r.pct}%</div><p>${r.right} of ${r.total} correct. Passing score is ${c.passPct}%.</p>` : ''}
      <h2>${r.passed ? '🎉 Course complete' : 'Not passed yet'}</h2>
      <p>${r.passed ? (pl.preview ? 'This was a preview, so nothing was recorded.' : 'Your completion has been recorded.') : 'Review the explanations below, then retake the quiz.'}</p>
      ${r.missed?.length ? `<h3>${r.passed ? 'Questions you missed' : 'Review these'}</h3>${r.missed.map(m => `<div class="missed">
        <strong>${inlineMd(m.q)}</strong><br><span class="small">Your answer: ${inlineMd(m.picked ?? '')}</span><br>
        <span class="small">Correct answer: <strong>${inlineMd(m.correct ?? '')}</strong></span>${m.explain ? `<br><span class="small muted">${inlineMd(m.explain)}</span>` : ''}</div>`).join('')}` : ''}
      <div class="row" style="margin-top:1rem;justify-content:flex-end">
        ${r.passed ? '<button class="primary" data-act="exit-course">Back to courses</button>'
          : '<button data-act="slide-review">Review slides</button><button class="primary" data-act="quiz-retake">Retake quiz</button>'}
      </div></div></div>`;
}

document.addEventListener('submit', e => {
  if (e.target.id !== 'quiz-form') return;
  e.preventDefault();
  const c = course(ui.play.courseId);
  const qs = parseQuiz(c.quiz);
  const fd = new FormData(e.target);
  const missed = [];
  let right = 0;
  qs.forEach((q, i) => {
    const pick = q.options[+fd.get('q' + i)];
    if (pick?.correct) right++;
    else missed.push({ q: q.q, picked: pick?.text, correct: q.options.find(o => o.correct)?.text, explain: q.explain });
  });
  const pct = Math.round(100 * right / qs.length);
  const passed = pct >= c.passPct;
  const p = playRecord();
  if (p) p.attempts.push({ at: new Date().toISOString(), score: pct, passed });
  finish({ pct, passed, right, total: qs.length, missed });
  render();
});

document.addEventListener('keydown', e => {
  if (ui.play?.mode !== 'slides' || $('#dlg').open || e.target.closest('input, textarea, select')) return;
  const b = e.key === 'ArrowRight' ? $('[data-act=slide-next]') : e.key === 'ArrowLeft' ? $('[data-act=slide-prev]') : null;
  if (b && !b.disabled) b.click();
});

/* ---------- admin ---------- */
function viewCoursesAdmin() {
  const staff = db.staff.slice().sort(byGroup);
  const pubs = db.courses.filter(c => c.status === 'published');
  const cell = (c, u) => {
    if (!isAssigned(c, u)) return '<td class="na">—</td>';
    const st = courseState(c, u.id);
    const text = {
      done: () => `✓ ${fmtDay(st.done)}`, expiring: () => `✓ renew ${fmtDay(st.expires)}`, expired: () => 'Expired',
      overdue: () => st.p ? `Overdue · ${st.pct}%` : 'Overdue', progress: () => `${st.pct}%`, new: () => 'Not started'
    }[st.state]();
    return `<td><button class="cell ${STATE_CLASS[st.state]}" data-act="training-detail" data-id="${c.id}" data-user="${u.id}">${text}</button></td>`;
  };
  return `<div class="row between" style="margin-bottom:12px"><h1 style="margin:0">Courses</h1>
      <div class="row"><button data-act="export-training">Export CSV</button><button class="primary" data-act="new-course">New course</button></div></div>
    ${db.courses.map(c => {
      const assigned = staff.filter(u => isAssigned(c, u));
      const states = assigned.map(u => courseState(c, u.id).state);
      const done = states.filter(s => s === 'done' || s === 'expiring').length;
      const late = states.filter(s => s === 'overdue' || s === 'expired').length;
      const pct = assigned.length ? Math.round(100 * done / assigned.length) : 0;
      return `<div class="card">
        <div class="row between"><h2 style="margin:0">${esc(c.title)}</h2><span class="badge ${c.status === 'published' ? 'ok' : ''}">${c.status}</span></div>
        <p class="small" style="margin:.4rem 0">${courseMeta(c)} · pass ${c.passPct}% · due ${c.dueDays} days after assignment${c.recertMonths ? ` · renew every ${c.recertMonths} months` : ''}<br>
          <span class="muted">Assigned to: ${groupsText(c)} · version ${c.version}</span></p>
        ${c.status === 'published' ? `${bar(pct)}<p class="small" style="margin:.4rem 0 0">${done} of ${assigned.length} complete${late ? ` · <span class="badge bad">${late} overdue</span>` : ''}</p>` : ''}
        <div class="row" style="margin-top:.6rem;justify-content:flex-end"><button data-act="preview-course" data-id="${c.id}">Preview</button><button data-act="edit-course" data-id="${c.id}">Edit</button></div>
      </div>`;
    }).join('')}
    ${pubs.length ? `<div class="card"><h2>Compliance by person</h2>
      <div class="scroll-x"><table class="matrix"><thead><tr><th class="name">Staff</th>${pubs.map(c => `<th>${esc(c.title)}</th>`).join('')}</tr></thead>
      <tbody>${staff.map(u => `<tr><th class="name" scope="row">${esc(u.name)}<br><span class="muted small">${GROUPS[u.group]}</span></th>${pubs.map(c => cell(c, u)).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="margin:.6rem 0 0">Select a status to see attempts or reset someone's completion.</p></div>` : ''}`;
}

function trainingDetailDialog(c, userId) {
  const st = courseState(c, userId);
  const all = db.progress.filter(p => p.courseId === c.id && p.userId === userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const body = `<p><strong>${esc(userName(userId))}</strong> · ${esc(c.title)}<br>
      <span class="badge ${STATE_CLASS[st.state]}">${STATE_LABEL[st.state]}</span> <span class="small">${stateText(st)}</span></p>
    <h3>History</h3>
    ${all.length ? all.map(p => `<div class="shift"><div><span class="small">Version ${p.version} · started ${fmtDay(ymd(new Date(p.startedAt)))}
        ${p.void ? ' · <span class="badge">reset</span>' : ''}${p.completedAt ? ` · completed ${fmtDay(ymd(new Date(p.completedAt)))}` : ''}</span>
        ${p.attempts.length ? `<br><span class="small muted">Quiz attempts: ${p.attempts.map(a => `${a.score}%${a.passed ? ' ✓' : ''}`).join(', ')}</span>` : ''}</div></div>`).join('')
      : '<p class="muted">Not started.</p>'}`;
  openDialog('Training record', body, {
    extra: st.p ? '<button class="danger" value="reset" formnovalidate>Reset</button>' : '',
    onClose: rv => {
      if (rv === 'reset' && confirm(`Reset ${userName(userId)}'s progress on "${c.title}"? They will need to complete it again.`)) {
        recordsOf(c, userId).forEach(p => { p.void = true; });
        save(); toast('Progress reset');
      }
    }
  });
}

const SLIDE_HELP = `<details class="small"><summary>Slide format</summary><p>Separate slides with a line containing only <code>---</code>.
  Start each slide with <code># Title</code>. Use <code>- </code> for bullets, <code>&gt; </code> for a highlighted key point, <code>**bold**</code>,
  <code>![description](https://…image)</code> for an image and <code>@video https://…</code> for a YouTube, Vimeo or MP4 video.
  Text pasted from PowerPoint's outline view works well.</p></details>`;
const QUIZ_HELP = `<details class="small"><summary>Quiz format</summary><p>Start each question with <code>Q:</code>, list options with <code>- </code>,
  and mark the one correct option with <code>* </code>. An optional <code>&gt; </code> line explains the answer after the attempt. Questions and options are shuffled for each attempt.</p></details>`;

function courseDialog(c) {
  const isNew = !c;
  const v = c ?? { title: '', summary: '', groups: [], dueDays: 30, passPct: 80, recertMonths: 0, status: 'draft', slides: '# First slide\nYour content here.', quiz: '' };
  const body = `
    <div class="field"><label for="c-title">Title</label><input id="c-title" name="title" value="${esc(v.title)}" required></div>
    <div class="field"><label for="c-sum">Short description</label><input id="c-sum" name="summary" value="${esc(v.summary)}"></div>
    <fieldset><legend>Assign to groups (none checked = everyone)</legend>
      ${Object.entries(GROUPS).map(([g, label]) => `<div class="check"><input type="checkbox" id="g-${g}" name="group" value="${g}" ${v.groups.includes(g) ? 'checked' : ''}>
        <label for="g-${g}">${label} <span class="muted small">(${db.staff.filter(u => u.group === g).length} people)</span></label></div>`).join('')}</fieldset>
    <div class="grid3">
      <div class="field"><label for="c-due">Due within (days)</label><input id="c-due" name="dueDays" type="number" min="1" value="${v.dueDays}" required></div>
      <div class="field"><label for="c-pass">Pass score (%)</label><input id="c-pass" name="passPct" type="number" min="1" max="100" value="${v.passPct}" required></div>
      <div class="field"><label for="c-rec">Renew every (months, 0 = never)</label><input id="c-rec" name="recertMonths" type="number" min="0" value="${v.recertMonths}" required></div>
    </div>
    <div class="field"><label for="c-slides">Slides</label>${SLIDE_HELP}<textarea id="c-slides" class="code" name="slides" required>${esc(v.slides)}</textarea></div>
    <div class="field"><label for="c-quiz">Quiz (optional)</label>${QUIZ_HELP}<textarea id="c-quiz" class="code" name="quiz">${esc(v.quiz)}</textarea></div>
    <div class="field"><label for="c-status">Status</label><select id="c-status" name="status">
      <option value="draft" ${v.status === 'draft' ? 'selected' : ''}>Draft (hidden from staff)</option>
      <option value="published" ${v.status === 'published' ? 'selected' : ''}>Published (assigned and tracked)</option></select></div>
    ${!isNew && c.status === 'published' ? `<div class="check"><input type="checkbox" id="c-bump" name="bump">
      <label for="c-bump">Content changed significantly: everyone must complete it again (new version, due ${v.dueDays} days from today)</label></div>` : ''}`;
  openDialog(isNew ? 'New course' : 'Edit course', body, {
    wide: true, sticky: true,
    extra: isNew ? '' : '<button class="danger" value="delete" formnovalidate>Delete</button><button value="preview" formnovalidate>Preview saved</button>',
    onSubmit: fd => {
      const slides = parseSlides(fd.get('slides'));
      const qs = parseQuiz(fd.get('quiz'));
      const errs = [...(slides.length ? [] : ['Add at least one slide.']), ...quizErrors(qs)];
      if (errs.length) { alert(errs.join('\n')); return false; }
      const patch = {
        title: String(fd.get('title')).trim(), summary: String(fd.get('summary') || '').trim(), groups: fd.getAll('group'),
        dueDays: +fd.get('dueDays'), passPct: +fd.get('passPct'), recertMonths: +fd.get('recertMonths'),
        slides: String(fd.get('slides')), quiz: String(fd.get('quiz') || ''), status: fd.get('status')
      };
      if (isNew) {
        db.courses.push({ id: uid(), version: 1, assignedAt: today(), ...patch });
      } else {
        if (patch.status === 'published' && c.status !== 'published') patch.assignedAt = today();
        if (fd.get('bump') === 'on') { patch.version = c.version + 1; patch.assignedAt = today(); }
        Object.assign(c, patch);
      }
      save(); toast(patch.status === 'published' ? 'Course saved and assigned' : 'Draft saved');
    },
    onClose: rv => {
      if (rv === 'preview') startCourse(c.id, true);
      if (rv === 'delete' && confirm(`Delete "${c.title}" and all of its completion records?`)) {
        db.courses = db.courses.filter(x => x.id !== c.id);
        db.progress = db.progress.filter(p => p.courseId !== c.id);
        save(); toast('Course deleted');
      }
    }
  });
}

function exportTraining() {
  const lines = [['Staff', 'Group', 'Job title', 'Course', 'Version', 'Status', 'Due', 'Completed', 'Score', 'Renews']];
  db.staff.slice().sort(byGroup).forEach(u => db.courses.filter(c => isAssigned(c, u)).forEach(c => {
    const st = courseState(c, u.id);
    lines.push([u.name, GROUPS[u.group], u.role, c.title, c.version, STATE_LABEL[st.state], st.due ?? '', st.done ?? '', st.p?.score ?? '', st.expires ?? '']);
  }));
  const csv = lines.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `training-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- actions ---------- */
const courseActions = {
  'open-course': b => startCourse(b.dataset.id, false),
  'preview-course': b => startCourse(b.dataset.id, true),
  'exit-course': () => { ui.play = null; ui.tab = 'courses'; },
  'slide-prev': () => { ui.play.idx--; ui.resetScroll = true; },
  'slide-next': () => {
    const c = course(ui.play.courseId);
    const n = parseSlides(c.slides).length;
    const p = playRecord();
    if (ui.play.idx < n - 1) {
      ui.play.idx++;
      if (p) { p.at = ui.play.idx; p.viewed = Math.max(p.viewed, ui.play.idx + 1); save(); }
      ui.resetScroll = true;
    } else if (parseQuiz(c.quiz).length) {
      if (p) { p.viewed = Math.max(p.viewed, n); save(); }
      beginQuiz();
    } else {
      finish({ pct: null, passed: true, missed: [] });
    }
  },
  'slide-review': () => { Object.assign(ui.play, { mode: 'slides', idx: 0 }); ui.resetScroll = true; },
  'quiz-retake': () => beginQuiz(),

  'new-course': () => { courseDialog(null); return false; },
  'edit-course': b => { courseDialog(course(b.dataset.id)); return false; },
  'training-detail': b => { trainingDetailDialog(course(b.dataset.id), b.dataset.user); return false; },
  'export-training': () => { exportTraining(); return false; }
};

/* ---------- sample courses ---------- */
function seedCourses() {
  const t = today();
  const courses = [
    {
      id: 'c1', title: 'HIPAA Privacy & Security Basics', version: 1, status: 'published', groups: [],
      summary: 'What counts as PHI, the minimum necessary rule, and how to report a possible breach.',
      dueDays: 30, passPct: 80, recertMonths: 12, assignedAt: addDays(t, -20),
      slides: `# Why HIPAA matters
HIPAA is the federal law that protects patients' health information. FPP staff handle that information every day, at the SNFs and in the office.
> FPP Team is not a place for patient information. Never enter patient names or health details in this app.
---
# What counts as PHI
**Protected Health Information (PHI)** is health information that can identify a patient, such as:
- Names, addresses, phone numbers and email addresses
- Dates tied to a patient, like birth, admission or discharge
- Medical record numbers and insurance IDs
- Photos of patients
- Diagnoses, medications and results linked to a person
---
# Minimum necessary
Use or share only the PHI you need to do your job.
- Look up only patients you are caring for or working on
- Curiosity is never a reason to open a chart, including for family, coworkers or public figures
---
# Protecting PHI day to day
- Lock your screen when you step away
- Don't discuss patients where others can overhear: hallways, elevators, dining areas
- Send PHI only through approved, secure systems, never personal email or regular texts
- Shred paper with PHI; never put it in the regular trash
---
# Passwords and phishing
- Never share your password or sign in for someone else
- Be suspicious of unexpected emails asking you to click a link, open an attachment or "verify" your account
- Report anything suspicious to the office manager right away
---
# Reporting a possible breach
If PHI may have been seen, sent to or lost by the wrong person:
- Report it right away to your supervisor or privacy officer
- Don't try to investigate or fix it on your own
> Speed matters: the practice has legal deadlines for responding to breaches.`,
      quiz: `Q: Which of these is PHI?
- A blank intake form
* A list of patient names with their SNF room numbers
- The SNF's public phone number
> Names linked to where someone is receiving care identify the patient, so they are PHI.

Q: You can access a coworker's chart and you're curious about their recent hospital stay. What should you do?
- Look, but don't tell anyone
* Don't open it; you have no work reason to
- Ask a colleague to look it up for you
> Access PHI only when you need it for your job (minimum necessary).

Q: How should you dispose of paper that contains PHI?
- Regular trash
- Recycling bin
* A locked shred bin

Q: An email asks you to "verify your password" through a link. What should you do?
* Don't click it; report it to the office manager
- Click it to see if it's real
- Forward it to coworkers to warn them

Q: You faxed patient records to the wrong number by mistake. What do you do first?
- Nothing, since it was an accident
- Call the recipient and handle it yourself
* Report it to your supervisor or privacy officer right away
> Possible breaches must be reported promptly so the practice can respond within legal deadlines.`
    },
    {
      id: 'c2', title: 'Bloodborne Pathogens & Infection Control', version: 1, status: 'published', groups: ['provider', 'staff'],
      summary: 'Standard precautions, PPE, sharps safety and what to do after an exposure.',
      dueDays: 30, passPct: 80, recertMonths: 12, assignedAt: addDays(t, -40),
      slides: `# Bloodborne pathogens
Bloodborne pathogens are germs in blood and certain body fluids that can cause disease. The main concerns are:
- Hepatitis B (HBV)
- Hepatitis C (HCV)
- HIV
> The hepatitis B vaccine is available to you at no cost. Ask the office manager.
---
# Standard precautions
Treat all blood and potentially infectious body fluids as if they are infectious, for every patient, every time.
---
# Personal protective equipment
- Wear gloves whenever you may touch blood, body fluids or contaminated surfaces
- Add a gown, mask and eye protection when splashes or sprays are possible
- Remove PPE carefully, dispose of it properly, and clean your hands afterward
---
# Sharps safety
- Never recap a used needle by hand
- Use safety-engineered devices when they are available
- Drop sharps into a sharps container immediately after use
- Replace containers when they are about three-quarters full; never overfill
---
# Hand hygiene
- Use alcohol-based hand rub unless your hands are visibly soiled
- Use soap and water when hands are visibly soiled
- Clean hands before and after patient contact and after removing gloves
---
# If you are exposed
1. Wash needlesticks and cuts with soap and water
2. Flush splashes to the nose, mouth or skin with water
3. Irrigate eyes with clean water or saline
4. Report it to your supervisor **immediately**
> Post-exposure treatment works best when started quickly, so report right away, even during a busy day.`,
      quiz: `Q: Which patients should standard precautions be used with?
- Only patients known to have an infection
* Every patient, every time
- Only patients with open wounds

Q: What should you do with a used needle?
- Recap it carefully, then dispose of it
* Put it straight into a sharps container without recapping
- Place it on the tray for later disposal

Q: When should you use soap and water instead of alcohol hand rub?
* When your hands are visibly soiled
- Never; hand rub is always better
- Only at the end of the day

Q: You get a needlestick. After washing the area, what's next?
- Finish your shift, then mention it tomorrow
* Report it to your supervisor immediately
- Watch for symptoms for a week
> Post-exposure treatment is time-sensitive, so report it right away.`
    },
    {
      id: 'c3', title: 'Getting Started with FPP Team', version: 1, status: 'published', groups: [],
      summary: 'How to request time off, clock in and complete training in this app.',
      dueDays: 14, passPct: 100, recertMonths: 0, assignedAt: t,
      slides: `# Welcome to FPP Team
FPP Team is where you request time off, see SNF assignments, clock in (hourly staff) and complete required training.
---
# Requesting time off
- Go to **Time off** and select **Request time off**
- Providers: suggest who could see your patients at your SNFs. The office confirms coverage when approving
- You'll see your request's status and any note from the office
---
# Clocking in
Medical assistants, front desk and billing staff clock in and out from the **Home** screen. Forgot to clock out? Tell the office manager so they can fix the punch.
---
# No patient information
> Never enter patient names, dates of birth, MRNs or health details anywhere in this app.`,
      quiz: `Q: Who confirms coverage for a provider's time off?
- The provider who is covering
* The office, when approving the request
- Nobody; coverage is automatic

Q: Is it OK to put a patient's name in an incident report in this app?
- Yes, if it's important
* No, never enter patient information in this app`
    }
  ];
  const prog = (courseId, userId, startedDaysAgo, extra) => ({
    id: uid(), courseId, userId, version: 1, startedAt: parseYmd(addDays(t, -startedDaysAgo)).toISOString(), viewed: 1, at: 0, attempts: [], ...extra
  });
  const doneAt = d => parseYmd(d).toISOString();
  const progress = [
    prog('c1', 'u6', 6, { viewed: 7, at: 5, completedAt: doneAt(addDays(t, -5)), score: 100, attempts: [{ at: doneAt(addDays(t, -5)), score: 100, passed: true }] }),
    prog('c1', 'u1', 360, { viewed: 7, at: 5, completedAt: doneAt(addDays(addMonths(t, -12), 10)), score: 80,
      attempts: [{ at: doneAt(addDays(t, -356)), score: 60, passed: false }, { at: doneAt(addDays(addMonths(t, -12), 10)), score: 80, passed: true }] }),
    prog('c2', 'u5', 3, { viewed: 3, at: 2 })
  ];
  return { courses, progress };
}
