// Screenshots of every tab at several widths. Usage: node scripts/shots.mjs <outDir>
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';

const out = process.argv[2] || 'shots';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const sizes = [[1440, 900], [390, 844], [1920, 945], [1366, 768]];
for (const [w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, `${w}_1write-empty.png`), fullPage: true });
  await page.click('#editor');
  await page.keyboard.type('The tram stops outside the fish market at six in the morning. ', { delay: 5 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${w}_2write-typing.png`), fullPage: true });
  await page.click('#tab-replay');
  await page.screenshot({ path: path.join(out, `${w}_3replay-own.png`), fullPage: true });
  await page.click('#tab-write');
  await page.click('.samples .sample[data-sample="sample-pasted-edited.json"]');
  await page.waitForSelector('#replay-main:not([hidden])');
  await page.click('#next-paste');
  await page.fill('#scrub', '40'); await page.dispatchEvent('#scrub', 'input');
  await page.screenshot({ path: path.join(out, `${w}_4replay-sample.png`), fullPage: true });
  await page.click('#tab-compare');
  await page.waitForSelector('#compare-grid .pane:nth-child(3)');
  await page.screenshot({ path: path.join(out, `${w}_5compare.png`), fullPage: true });
  await page.click('#tab-verify');
  await page.screenshot({ path: path.join(out, `${w}_6verify-empty.png`), fullPage: true });
  await page.click('#tamper');
  await page.waitForSelector('#result.bad');
  await page.screenshot({ path: path.join(out, `${w}_7verify-tampered.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
server.close();
console.log('saved to', out);
