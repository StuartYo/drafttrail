// Browser test: drives the real page in Chrome with real keyboard and clipboard events.
// Uses the Chrome already installed on the machine (playwright-core, channel "chrome").
// Writes measured numbers to results/browser-e2e.json.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';
import { verify, stats } from '../src/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = { ranAt: new Date().toISOString(), browser: browser.version(), scenarios: {} };
let failures = 0;

async function fresh() {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const outside = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol.startsWith('http')) outside.push(r.url()); });
  page.outside = outside;
  await page.goto(base);
  await page.click('#editor');
  return { ctx, page, errors };
}
const snap = page => page.evaluate(async () => window.__drafttrail.refreshSeal());
const paste = async (page, text) => {
  await page.evaluate(t => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+V');
};
async function scenario(name, fn) {
  const { ctx, page, errors } = await fresh();
  try {
    const doc = await fn(page);
    const v = await verify(doc, doc.seal);
    const s = stats(doc);
    const value = await page.inputValue('#editor');
    results.scenarios[name] = {
      events: s.events, kinds: doc.events.reduce((m, e) => (m[e.k] = (m[e.k] || 0) + 1, m), {}),
      pasteEvents: s.pasteEvents, pastedSharePct: Math.round(s.pastedShare * 1000) / 10,
      finalMatchesTextbox: v.text === value, verifies: v.ok, pageErrors: errors.length,
    };
    assert.equal(v.ok, true, `${name}: ${v.reason}`);
    assert.equal(v.text, value, `${name}: rebuilt text differs from the text box`);
    assert.equal(errors.length, 0, `${name}: page errors ${errors.join('; ')}`);
    return { doc, s, page };
  } finally { await ctx.close(); }
}
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); results.scenarios[name] = { ...(results.scenarios[name] || {}), failed: e.message }; }
}

const SENT_A = 'Every sentence is a small bet. ';
const SENT_B = 'I choose plain words on purpose.';

await check('typed with a correction', () => scenario('typed with a correction', async page => {
  await page.keyboard.type('The tram stops at six', { delay: 25 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('x in the morning.', { delay: 25 });
  const doc = await snap(page);
  assert.equal(doc.events.filter(e => e.k === 'paste').length, 0);
  assert.ok(doc.events.some(e => e.k === 'delete'), 'backspace recorded as delete');
  return doc;
}));

await check('one outside paste', () => scenario('one outside paste', async page => {
  await page.keyboard.type('Intro: ', { delay: 20 });
  await paste(page, 'This paragraph was copied from somewhere else and dropped in whole.');
  const doc = await snap(page);
  const s = stats(doc);
  assert.equal(s.pasteEvents, 1);
  assert.ok(s.pastedShare > 0.85, `pasted share ${s.pastedShare}`);
  return doc;
}));

await check('writer moves own sentence (cut, paste)', () => scenario('writer moves own sentence (cut, paste)', async page => {
  await page.keyboard.type(SENT_A + SENT_B, { delay: 10 });
  await page.evaluate(n => { const ed = document.getElementById('editor'); ed.setSelectionRange(0, n); }, SENT_A.length);
  await page.keyboard.press('Control+X');
  await page.evaluate(() => { const ed = document.getElementById('editor'); ed.setSelectionRange(ed.value.length, ed.value.length); });
  await page.keyboard.type(' ', { delay: 10 });
  await page.keyboard.press('Control+V');
  const doc = await snap(page);
  const s = stats(doc);
  results.scenarios['writer moves own sentence (cut, paste)'] = { pastedShareSeen: s.pastedShare };
  assert.equal(s.survivingPastedChars, 0, `own text moved inside the draft is shown as pasted (${Math.round(s.pastedShare * 100)}% of final text)`);
  return doc;
}));

await check('outside paste, then cut and moved', () => scenario('outside paste, then cut and moved', async page => {
  await page.keyboard.type('Mine. ', { delay: 10 });
  const outside = 'Text that came from outside the draft.';
  await paste(page, outside);
  await page.evaluate(n => { const ed = document.getElementById('editor'); ed.setSelectionRange(ed.value.length - n, ed.value.length); }, outside.length);
  await page.keyboard.press('Control+X');
  await page.evaluate(() => { const ed = document.getElementById('editor'); ed.setSelectionRange(0, 0); });
  await page.keyboard.press('Control+V');
  const doc = await snap(page);
  const s = stats(doc);
  assert.equal(s.survivingPastedChars, outside.length, 'moving pasted text must not hide that it was pasted');
  return doc;
}));

await check('save, then verify the downloaded file with its seal', async () => {
  const { ctx, page, errors } = await fresh();
  try {
    await page.keyboard.type('A short note typed for the save test.', { delay: 10 });
    await page.waitForFunction(() => document.getElementById('live-seal').textContent.includes('-'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    const file = path.join(root, 'results', 'e2e-download.json');
    mkdirSync(path.dirname(file), { recursive: true });
    await dl.saveAs(file);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    await page.click('#tab-verify');
    await page.setInputFiles('#file', file);
    await page.fill('#seal-in', doc.seal);
    await page.click('#verify-btn');
    await page.waitForSelector('#result.good');
    await page.fill('#seal-in', 'AAAAAAAAAAAA-1');
    await page.click('#verify-btn');
    await page.waitForSelector('#result.bad');
    await page.click('#tamper');
    await page.waitForSelector('#result.bad');
    const msg = await page.textContent('#result');
    assert.match(msg, /First bad event/);
    results.scenarios['save and verify'] = { downloaded: true, goodWithSeal: true, wrongSealRejected: true, tamperCaught: true, tamperMessage: msg.replace(/\s+/g, ' ').trim() };
    assert.equal(errors.length, 0, errors.join('; '));
  } finally { await ctx.close(); }
});

await check('samples load, replay plays, compare renders', async () => {
  const { ctx, page, errors } = await fresh();
  try {
    await page.click('.samples .sample[data-sample="sample-pasted.json"]');
    await page.waitForSelector('#replay-main:not([hidden])');
    assert.equal(await page.isVisible('#sim-banner'), true, 'simulated banner shown');
    assert.match(await page.textContent('#clock'), /Event 1 of .*paste: 1,459 characters/, 'replay opens on the first paste');
    assert.equal(await page.locator('#replay-text .hit').count(), 1, 'first paste outlined');
    await page.click('#next-paste');
    assert.match(await page.textContent('#clock'), /Event 1 of/); // next paste wraps to the first paste
    await page.click('#tab-compare');
    await page.waitForSelector('#compare-grid .pane:nth-child(3)');
    const fontsLoaded = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "IBM Plex Sans"') && [...document.fonts].some(f => f.family.includes('IBM Plex Sans') && f.status === 'loaded'); });
    results.scenarios['samples and compare'] = { simulatedBannerShown: true, compareCards: await page.locator('#compare-grid > .pane').count(), requestsToOtherHosts: page.outside.length, embeddedFontLoaded: fontsLoaded };
    assert.equal(page.outside.length, 0, 'requests left this machine: ' + page.outside.join(', '));
    assert.equal(fontsLoaded, true, 'embedded font not loaded');
    assert.equal(errors.length, 0, errors.join('; '));
  } finally { await ctx.close(); }
});

await browser.close();
server.close();
results.failures = failures;
mkdirSync(path.join(root, 'results'), { recursive: true });
writeFileSync(path.join(root, 'results', 'browser-e2e.json'), JSON.stringify(results, null, 2));
console.log(failures ? `${failures} failing` : 'all browser checks passed');
process.exit(failures ? 1 : 0);
