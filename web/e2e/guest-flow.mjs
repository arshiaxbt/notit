/**
 * Optional manual check: the whole Testnet guest flow against a real deployment.
 *
 *   watch live state  ->  "Play as guest"  ->  1,000 NOTIT  ->  "I'll do it"  ->  you are It
 *
 * It needs the network, the public testnet faucet and Playwright, so it is not
 * part of `npm test` and Playwright is not a dependency of this package.
 *
 * Run it against a served build:
 *
 *   npm run build -w web && npm run preview -w web        # serves http://127.0.0.1:4173/
 *   npx playwright install chromium                        # once
 *   node web/e2e/guest-flow.mjs                            # from the repo root
 *
 * Options (environment variables):
 *   BASE_URL            page to open                 (default http://127.0.0.1:4173/)
 *   OUT_DIR             where screenshots go         (default web/screenshots)
 *   PLAYWRIGHT_MODULE   path to Playwright's entry   (default: the "playwright" package)
 *   MAX_ROUNDS          rounds to keep trying        (default 3)
 *
 * Every run creates one faucet-funded throwaway testnet account. Be gentle with it.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const OUT_DIR = resolve(process.env.OUT_DIR ?? resolve(here, '../screenshots'));
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 3);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
await mkdir(OUT_DIR, { recursive: true });

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args);
const problems = [];
const txLinks = new Set();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ''}`));

async function collectTx() {
  for (const href of await page.locator('.txlink a').evaluateAll((els) => els.map((a) => a.href))) txLinks.add(href);
}
const text = async (selector) => ((await page.locator(selector).first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();

try {
  // 1. Watch: live state with no account.
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stage .face', { timeout: 45_000 });
  await page.waitForSelector('.chainbar', { timeout: 10_000 });
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('.lock')?.textContent ?? ''), null, { timeout: 30_000 });
  log('live state:', await text('.clock .sr-only'), '|', await text('.stage__line'), '|', await text('.lock'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/testnet-watch-desktop.png`, fullPage: true });

  // 2. Play as guest: account from the faucet, then the claim.
  const started = Date.now();
  await page.getByRole('button', { name: /Play as guest|Continue as guest/ }).click();
  log('clicked "Play as guest"');
  await page.waitForFunction(
    () => /1,000\.00/.test(document.querySelector('.figs__item dd')?.textContent ?? '') || document.querySelector('.act__alert') !== null,
    null,
    { timeout: 150_000 },
  );
  if (await page.locator('.act__alert').count()) {
    throw new Error(`guest sign-up failed: ${await text('.guest')}`);
  }
  log(`guest ready in ${((Date.now() - started) / 1000).toFixed(1)}s:`, await text('.acct__id'), '| balance', await text('.figs__item dd .sr-only'));
  await collectTx();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT_DIR}/testnet-guest-desktop.png`, fullPage: true });

  // 3. Volunteer in a round where it is possible; keep trying if someone beats us to it.
  let done = false;
  const deadline = Date.now() + MAX_ROUNDS * 200_000;
  while (!done && Date.now() < deadline) {
    await page.waitForFunction(
      () => {
        const b = document.querySelector('.dock .act');
        return b && !b.disabled && /I'll do it/.test(b.textContent ?? '');
      },
      null,
      { timeout: 200_000 },
    );
    log('volunteering:', await text('.stage .face'), '|', await text('.dock .act'));
    const sent = Date.now();
    await page.locator('.dock .act').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.stamp') !== null ||
        document.querySelector('.act__alert') !== null,
      null,
      { timeout: 60_000 },
    );
    await collectTx();
    const result = await text('.dock');
    log(`answer after ${((Date.now() - sent) / 1000).toFixed(1)}s:`, result.slice(0, 200));
    if (/You did it/.test(result)) {
      await page.waitForFunction(() => document.querySelector('.face--it.face--you') !== null, null, { timeout: 30_000 });
      log('It:', await text('.face--it.face--you') === '' ? 'you' : '?', '|', await text('.stamp'));
      done = true;
    } else {
      log('not this round; waiting for the next one');
      await page.screenshot({ path: `${OUT_DIR}/testnet-beaten-desktop.png`, fullPage: true });
      await page.getByRole('button', { name: 'OK' }).click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT_DIR}/testnet-it-desktop.png`, fullPage: true });
  if (!done) problems.push('never managed to volunteer within MAX_ROUNDS');

  // 4. The same session on a phone-sized screen (the guest key is restored from storage).
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    storageState: await context.storageState(),
  });
  const mobile = await phone.newPage();
  await mobile.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('.acct__id', { timeout: 45_000 });
  await mobile.waitForSelector('.stage .face', { timeout: 45_000 });
  await mobile.waitForTimeout(1500);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`mobile horizontal overflow: ${overflow}px`);
  await mobile.screenshot({ path: `${OUT_DIR}/testnet-mobile.png`, fullPage: true });
  await phone.close();
} catch (e) {
  problems.push(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: `${OUT_DIR}/testnet-failure.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\nTransactions:');
for (const href of txLinks) console.log('  ' + href);
console.log(problems.length ? `\nProblems:\n  ${problems.join('\n  ')}` : '\nNo problems.');
process.exit(problems.some((p) => p.startsWith('FAILED') || p.startsWith('never')) ? 1 : 0);
