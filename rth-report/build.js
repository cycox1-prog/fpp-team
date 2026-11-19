// Inlines src/*.js and src/styles.css into ONE self-contained HTML file.
//   node rth-report/build.js
// Output: rth-report/dist/FPP-Hospital-Send-Out-Report.html  (the file staff actually use)
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');

// A literal "</script" inside inlined JS would end the script tag early.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

let html = read('template.html');
html = html.replace('/*{{CSS}}*/', () => read('styles.css'));
html = html.replace('/*{{CORE}}*/', () => safe(read('core.js')));
html = html.replace('/*{{APP}}*/', () => safe(read('app.js')));

const outDir = path.join(__dirname, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'FPP-Hospital-Send-Out-Report.html');
fs.writeFileSync(out, html);

// Guard the privacy promise: the built file must contain no external URLs or network APIs.
const banned = [/https?:\/\/(?!www\.w3\.org)/i, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /<link[^>]+href/i, /<script[^>]+src=/i, /<img[^>]+src="http/i];
const hits = banned.filter((re) => re.test(html.replace(/<!--[\s\S]*?-->/g, '')));
if (hits.length) { console.error('Build refused: found network-capable code: ' + hits.join(', ')); fs.unlinkSync(out); process.exit(1); }
console.log('Built ' + path.relative(process.cwd(), out) + ' (' + (html.length / 1024).toFixed(0) + ' KB)');
