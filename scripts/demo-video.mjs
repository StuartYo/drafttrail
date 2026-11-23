// Records the demo video by driving the real page in Chrome. Captions are drawn into the page
// and also written to an .srt file. Usage: node scripts/demo-video.mjs <outDir>
// Then: ffmpeg converts the .webm to .mp4 (see README).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';

const out = path.resolve(process.argv[2] || 'video');
mkdirSync(out, { recursive: true });
const W = 1440, H = 810, ZOOM = 1.2;
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const t0 = Date.now();
const page = await ctx.newPage();
await page.goto(base);
await page.evaluate(z => {
  document.body.style.zoom = z;
  document.body.style.paddingBottom = '90px';
  const c = document.createElement('div');
  c.id = 'demo-caption';
  c.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:14px 40px 16px;background:rgba(22,33,29,.94);color:#fff;font:500 21px/1.4 "IBM Plex Sans",sans-serif;text-align:center;min-height:84px;display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(c);
}, ZOOM);
await page.evaluate(() => document.fonts.ready);
const startAt = (Date.now() - t0) / 1000;
const cues = [];
const wait = ms => page.waitForTimeout(ms);
async function say(text, ms) {
  const at = (Date.now() - t0) / 1000 - startAt;
  if (cues.length) cues[cues.length - 1].end = at;
  cues.push({ start: at, end: at + ms / 1000, text });
  await page.evaluate(t => { document.getElementById('demo-caption').textContent = t; }, text);
  await wait(ms);
}

// 1. The result only a recording can give
await page.click('#tab-compare');
await page.waitForSelector('#compare-grid .pane:nth-child(3)');
await say('On average, seven AI detectors labelled 61% of human-written TOEFL essays as AI-generated (Liang et al., 2023).', 4600);
await page.evaluate(() => { for (const tr of document.querySelectorAll('#compare-grid tr')) if (tr.textContent.includes('fingerprint')) { tr.style.cssText = 'background:#fbe3c0;outline:2px solid #a84a08'; for (const td of tr.cells) td.style.padding = '6px 8px'; } });
await page.evaluate(() => { const g = document.getElementById('compare-grid'); window.scrollTo({ top: g.getBoundingClientRect().top + window.scrollY - 16, behavior: 'instant' }); });
await say('Here are three simulated recordings of one essay. The finished text is byte-for-byte identical in all three.', 4200);
await say('So any checker that reads only the final text, AI detector or person, must judge all three the same way.', 4800);
await say('Drafttrail records how the text arrived: typed over 5 minutes, pasted in one go, or pasted and then lightly edited.', 5200);

await page.evaluate(() => window.scrollTo(0, 0));
// 2. Replay a pasted sample
await page.click('#compare-grid .pane:nth-child(3) [data-open]');
await page.waitForSelector('#replay-main:not([hidden])');
await page.evaluate(() => { document.getElementById('speed').value = '5'; });
await page.click('#play');
await say('Replay shows the draft growing. Pasted text is shaded; words typed afterwards are not. (Simulated sample.)', 5600);
await page.click('#next-paste');
await say('"Next paste" jumps straight to each paste event and shows its size.', 3800);

// 3. Write for real
await page.click('#tab-write');
await page.click('#editor');
await say('Writing is just a text box. Every keystroke, deletion, pause and paste is logged with a time.', 1200);
await page.keyboard.type('Every sentence is a small bet. ', { delay: 70 });
await page.keyboard.type('I choose plain words on purpos', { delay: 70 });
await page.keyboard.press('Backspace'); await wait(200);
await page.keyboard.type('se.', { delay: 90 });
await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
await page.keyboard.type('se.', { delay: 90 });
await wait(800);
await page.evaluate(t => navigator.clipboard.writeText(t), ' This line was copied from another window.');
await say('A paste from outside the draft is counted on the right.', 800);
await page.keyboard.press('Control+V');
await wait(2400);

// 4. Moving your own sentence is not a paste (the fix from testing)
await page.evaluate(() => { const ed = document.getElementById('editor'); ed.setSelectionRange(0, 31); });
await say('First test round: cutting my own sentence and pasting it elsewhere was counted as "pasted". Now it is a move.', 2200);
await page.keyboard.press('Control+X');
await page.evaluate(() => { const ed = document.getElementById('editor'); ed.setSelectionRange(ed.value.length, ed.value.length); });
await page.keyboard.type(' ', { delay: 50 });
await page.keyboard.press('Control+V');
await wait(3000);
await page.click('#open-replay');
await say('Moved text keeps its colour: my sentence stays "typed", the copied line stays "pasted".', 5200);

// 5. Verify and tamper
await page.click('#tab-verify');
await say('The teacher opens the saved file here. Each event carries a fingerprint of the one before it.', 3600);
await page.click('#tamper');
await page.waitForSelector('#result.bad');
await say('Change one character of one event, and verification fails at that exact event.', 5200);
await say('In 300 random single edits to a sample, all 300 were caught at the edited event.', 4600);

// 6. Limits
await page.click('#tab-write');
await say('Limits: it cannot show who typed, and AI text retyped by hand looks like typing. It is evidence of process, not proof.', 6200);
await say('Runs in the browser. No account, nothing uploaded.', 3600);
cues[cues.length - 1].end = (Date.now() - t0) / 1000 - startAt;

await ctx.close();
await browser.close();
server.close();
const webm = readdirSync(out).filter(f => f.endsWith('.webm')).map(f => path.join(out, f)).pop();
renameSync(webm, path.join(out, 'raw.webm'));
const ts = s => { const ms = Math.max(0, Math.round(s * 1000)); const h = String(Math.floor(ms / 3600000)).padStart(2, '0'); const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0'); const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0'); return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`; };
writeFileSync(path.join(out, 'captions.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
writeFileSync(path.join(out, 'trim.json'), JSON.stringify({ startAt, cues }, null, 2));
console.log('video', path.join(out, 'raw.webm'), 'trim start', startAt.toFixed(2), 's, length', cues[cues.length - 1].end.toFixed(1), 's');
