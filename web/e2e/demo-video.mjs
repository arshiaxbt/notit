/**
 * Records the demo video from the real app on a real contract, then cuts it.
 *
 * What it does
 *   record  Opens the served build in Testnet mode, signed in as an existing
 *           testnet account, and drives one real sequence:
 *             watch -> claim 1,000 NOTIT -> next round: "I'll do it" (you are It)
 *             -> the round after: nobody volunteers, everyone pays It
 *             -> hero wall and round history (or the lock, if the contract is locked)
 *             -> Lab: crowd-size slider -> end card.
 *           Captions, the "×16" marker and the end card are elements injected into
 *           the page, so they are crisp and in the app's own type. Every number on
 *           screen comes from the app; nothing is composited. Frames are taken
 *           with Chrome's screencast and written with their timestamps, and the
 *           script logs when each beat starts and ends. Clean screenshots for
 *           the README (captions hidden) are saved to WORK_DIR/shots on the way.
 *           Only one window polls the chain: public RPC endpoints rate-limit.
 *   build   Cuts the frames into a 1280x720 H.264 MP4 with no audio: key moments
 *           at real speed, waits at 16x (with the marker visible; that includes a
 *           transaction or a round close the chain is slow to confirm), long waits
 *           dropped with a short dissolve. Also writes a poster PNG.
 *
 * What it needs
 *   - The network, and the app served somewhere (npm run build -w web && npm run preview -w web).
 *   - Playwright with Chromium, and a full ffmpeg + ffprobe. None of these are
 *     dependencies of this package; point at them with the variables below.
 *   - A testnet account with a little NEAR that has NOT claimed on the contract
 *     yet, as a near-cli style credentials file ({ account_id, private_key }).
 *     The key is put into the browser's storage at run time and never written
 *     anywhere else. The claim can only be filmed once per account.
 *   - A quiet round to film "nobody volunteers": pass commands that pause and
 *     resume the bots. They are always resumed, also when the script fails.
 *
 * Usage (from the repo root)
 *   GUEST_CREDENTIALS=~/.near-credentials/testnet/<account>.json \
 *   BOTS_STOP='.scratch/bots.sh stop fast' BOTS_START='.scratch/bots.sh start fast' \
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs FFMPEG=/path/to/ffmpeg FFPROBE=/path/to/ffprobe \
 *   node web/e2e/demo-video.mjs            # record, then build
 *   node web/e2e/demo-video.mjs build      # cut again from the frames already recorded
 *
 * Variables
 *   BASE_URL           page to open                       (default http://127.0.0.1:4173/)
 *   GUEST_CREDENTIALS  credentials file of the account    (required for record)
 *   WORK_DIR           frames and timeline                (default web/.video/take, git-ignored)
 *   OUT_DIR            demo.mp4, poster and screenshots   (default docs/media)
 *   BOTS_STOP/START    shell commands to pause/resume bots (optional)
 *   REHEARSAL=1        do not wait for a bot to save the opening round, and skip the claim if already made
 *   PLAYWRIGHT_MODULE, FFMPEG, FFPROBE                    (defaults: "playwright", "ffmpeg", "ffprobe")
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const WORK_DIR = resolve(process.env.WORK_DIR ?? join(here, '../.video/take'));
const OUT_DIR = resolve(process.env.OUT_DIR ?? join(here, '../../docs/media'));
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const REHEARSAL = process.env.REHEARSAL === '1';
const W = 1280;
const H = 720;
const FPS = 30;
const FAST = 16;
const DISSOLVE = 0.4;
/** The page is drawn at 90% so the round, "Who is It" and "You" fit above the caption. */
const ZOOM = 0.9;

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

/* ------------------------------------------------------------------ record */

/** Runs in the page: caption bar, fast-forward marker and end card, in the app's own style. */
export function installOverlay({ zoom, speed }) {
  document.body.style.zoom = String(zoom);
  const style = document.createElement('style');
  style.textContent = `
    .vid { font-family: 'Bricolage Grotesque Variable', system-ui, sans-serif; position: fixed; z-index: 9999; pointer-events: none; }
    .vid-off .vid { visibility: hidden; }
    .vid-caption { left: 50%; bottom: 20px; transform: translateX(-50%); width: max-content; max-width: 1160px;
      padding: 13px 28px 15px; background: #16130c; color: #fff4d6; border: 3px solid #ffd60a; border-radius: 18px;
      font-weight: 800; font-size: 31px; line-height: 1.18; letter-spacing: -0.01em; text-align: center; text-wrap: balance;
      box-shadow: 0 7px 0 rgba(22,19,12,.35); opacity: 0; transition: opacity .18s ease; }
    .vid-caption.on { opacity: 1; }
    .vid-caption b { color: #ffd60a; }
    .vid-fast { right: 84px; bottom: 114px; padding: 5px 14px 6px; background: #16130c; color: #ffd60a; border: 3px solid #ffd60a;
      border-radius: 12px; font-weight: 800; font-size: 26px; letter-spacing: .02em; display: none; }
    .vid-fast.on { display: block; }
    .vid-end { inset: 0; display: grid; place-content: center; justify-items: center; gap: 22px; background: #16130c; color: #fff4d6;
      opacity: 0; transition: opacity .35s ease; text-align: center; }
    .vid-end.on { opacity: 1; }
    .vid-end__logo { display: flex; align-items: center; gap: 18px; font-weight: 800; font-size: 120px; line-height: 1; letter-spacing: -0.04em; }
    .vid-end__it { padding: 6px 30px 16px; background: #ffd60a; color: #16130c; border-radius: 28px; transform: rotate(-5deg); }
    .vid-end__name { font-weight: 800; font-size: 46px; letter-spacing: -0.02em; }
    .vid-end__name b { color: #ffd60a; }
    .vid-end__by { font-weight: 700; font-size: 34px; }
    .vid-end__small { margin-top: 6px; padding: 6px 18px; border: 2.5px solid #fff4d6; border-radius: 999px; font-weight: 700; font-size: 22px;
      letter-spacing: .09em; text-transform: uppercase; }
  `;
  document.documentElement.appendChild(style);
  const make = (cls) => {
    const el = document.createElement('div');
    el.className = `vid ${cls}`;
    document.documentElement.appendChild(el); // outside <body>, so the page zoom does not apply
    return el;
  };
  const caption = make('vid-caption');
  const fast = make('vid-fast');
  fast.textContent = `▶▶ ×${speed}`;
  const end = make('vid-end');
  end.innerHTML = `
    <div class="vid-end__logo"><span>Not</span><span class="vid-end__it">it!</span></div>
    <div class="vid-end__name">Not It <b>($NOTIT)</b></div>
    <div class="vid-end__by">built at NEAR HACKATHON</div>
    <div class="vid-end__small">testnet · test tokens · no value</div>`;
  window.__vid = {
    caption(html) {
      if (!html) {
        caption.classList.remove('on');
        return;
      }
      caption.innerHTML = html;
      caption.classList.add('on');
    },
    fast(on) {
      fast.classList.toggle('on', on);
    },
    end(on) {
      end.classList.toggle('on', on);
    },
  };
}

async function record() {
  const credPath = process.env.GUEST_CREDENTIALS;
  if (!credPath) throw new Error('GUEST_CREDENTIALS is required: a credentials file { account_id, private_key }');
  const cred = JSON.parse(await readFile(resolve(credPath.replace(/^~/, process.env.HOME ?? '~')), 'utf8'));
  const guest = { accountId: cred.account_id, secretKey: cred.private_key };
  if (!guest.accountId || !/^ed25519:/.test(guest.secretKey ?? '')) throw new Error('credentials file needs account_id and private_key');

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(join(WORK_DIR, 'frames'), { recursive: true });
  await mkdir(join(WORK_DIR, 'shots'), { recursive: true });

  const browser = await chromium.launch();
  // The account is restored exactly as the app restores a returning guest: from localStorage.
  const signIn = ({ accountId, secretKey }) => {
    localStorage.setItem('notit-guest:testnet', JSON.stringify({ accountId, secretKey }));
    localStorage.setItem('notit-signer', 'guest');
    localStorage.setItem('notit-theme', 'light');
  };
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.addInitScript(signIn, guest);
  const page = await context.newPage();
  const problems = [];
  // A public RPC endpoint that rate-limits answers without CORS headers; the app fails over
  // to the next one. Count those instead of listing each.
  let rpcErrors = 0;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/CORS policy|net::ERR_FAILED|429/.test(m.text())) rpcErrors += 1;
    else problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // ---- helpers over the page ----
  // Reads text straight from the DOM: an element that is not there is an empty string, at once.
  const text = async (sel) => (await page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel)).replace(/\s+/g, ' ').trim();
  const round = async () => Number((await text('#round-heading span')).replace(/\D/g, ''));
  const secondsLeft = async () => {
    const parts = (await text('.countdown .sr-only')).split(':').map(Number);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  };
  const saved = async () => (await page.locator('.slab--saved').count()) > 0;
  const caption = (html) => page.evaluate((h) => window.__vid.caption(h), html);
  const marker = (on) => page.evaluate((v) => window.__vid.fast(v), on);
  const scrollTo = async (sel, offset = 12, smooth = false) => {
    await page.evaluate(
      ({ sel, offset, smooth }) => {
        const el = document.querySelector(sel);
        const top = el ? el.getBoundingClientRect().top + window.scrollY - offset : 0;
        window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'instant' });
      },
      { sel, offset, smooth },
    );
  };
  // README screenshots come from the filmed page itself: frame capture pauses, the
  // captions are hidden for one screenshot, and everything is put back. (A second
  // window polling the chain would double the load on the public RPC endpoint.)
  let paused = false;
  const shot = async (name) => {
    paused = true;
    try {
      await page.evaluate(() => document.documentElement.classList.add('vid-off'));
      await page.screenshot({ path: join(WORK_DIR, 'shots', name) });
      log(`screenshot ${name}`);
    } catch (e) {
      problems.push(`screenshot ${name} failed: ${e.message.split('\n')[0]}`);
    } finally {
      await page.evaluate(() => document.documentElement.classList.remove('vid-off')).catch(() => {});
      await sleep(60);
      paused = false;
    }
  };

  // ---- frame capture: Chrome screencast, thinned to what each segment needs ----
  const frames = [];
  const segments = [];
  const events = [];
  let minGap = Infinity; // seconds between kept frames; Infinity = keep nothing
  let lastKept = 0;
  let counter = 0;
  const writes = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    const ts = f.metadata.timestamp ?? now();
    if (paused || ts - lastKept < minGap) return;
    lastKept = ts;
    const file = `f${String(++counter).padStart(6, '0')}.jpg`;
    frames.push({ file, ts });
    writes.push(writeFile(join(WORK_DIR, 'frames', file), Buffer.from(f.data, 'base64')));
  });
  /** Starts a segment of the cut. speed 0 = leave out, 1 = real time, FAST = fast-forward. */
  const segment = (name, speed, extra = {}) => {
    const t = now();
    const prev = segments[segments.length - 1];
    if (prev && prev.end === null) prev.end = t;
    segments.push({ name, speed, start: t, end: null, ...extra });
    minGap = speed === 0 ? Infinity : speed === 1 ? 1 / FPS - 0.004 : (speed / FPS) * 0.45;
    lastKept = 0;
    log(`--- ${name}${speed === 0 ? ' (not in the cut)' : speed === 1 ? '' : ` (x${speed})`}`);
  };
  const event = (name, detail = {}) => {
    events.push({ name, t: now(), ...detail });
    log(`event ${name}`, JSON.stringify(detail));
  };

  /**
   * Waits for the chain's answer to show on the page (a confirmed transaction, a closed
   * round). Testnet usually answers in two or three seconds; when it takes longer, the
   * extra wait is fast-forwarded with the marker showing, and real time resumes at the answer.
   */
  const settle = async (name, done, patience = 6500) => {
    const quick = await Promise.race([done.then(() => true), sleep(patience).then(() => false)]);
    if (quick) return;
    segment(`${name}-pending`, FAST);
    await marker(true);
    await done;
    await marker(false);
    segment(`${name}-confirmed`, 1);
  };

  let botsStopped = false;
  const bots = (which) => {
    const cmd = which === 'stop' ? process.env.BOTS_STOP : process.env.BOTS_START;
    if (!cmd) return;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    botsStopped = which === 'stop';
    event(`bots ${which}`, { out });
  };

  const facts = { account: guest.accountId, base: BASE_URL, txs: [] };
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#round-heading', { timeout: 45_000 });
    await page.waitForSelector('.acct__id', { timeout: 45_000 });
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('.lock')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(installOverlay, { zoom: ZOOM, speed: FAST });
    facts.contract = await text('.chainbar code');
    facts.locked = (await page.locator('.lock--locked').count()) > 0;
    log(`signed in as ${await text('.acct__id')} on ${facts.contract}; locked: ${facts.locked}`);
    const canClaim = /Claim/.test(await text('.slab__act .cta'));
    if (!canClaim && !REHEARSAL) throw new Error(`expected a "Claim" button, found: ${await text('.slab__act')}`);

    // ---- pre-roll (not filmed): open on a round a bot has already saved, with time to claim in it ----
    for (;;) {
      const left = await secondsLeft();
      const isSaved = await saved();
      if ((REHEARSAL || isSaved) && left >= 20 && left <= 60) break;
      if (Date.now() - t0 > 20 * 60_000) throw new Error('no suitable opening round within 20 minutes');
      await sleep(700);
    }
    const r0 = await round();
    bots('stop');
    log(`opening in round ${r0} with ${await secondsLeft()}s left`);

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, everyNthFrame: 1 });

    // ---- beat 1: the pitch over the live page ----
    await page.evaluate(() => window.scrollTo(0, 0));
    segment('beat1', 1);
    await caption('Somebody has to do it. <b>If nobody does, everybody pays the last person who did.</b>');
    await sleep(5200);

    // ---- beat 2: the guest claims ----
    segment('beat2', 1);
    await scrollTo('.slab');
    await caption('A guest account claims <b>1,000 NOTIT</b> from the contract’s faucet.');
    await sleep(1800);
    if (canClaim) {
      await page.locator('.slab__act .cta').click();
      event('claim clicked', { round: await round() });
      await settle(
        'beat2',
        page.waitForFunction(() => /1,000\.00/.test(document.querySelector('.you__balance .sr-only')?.textContent ?? ''), null, { timeout: 90_000 }),
      );
      event('claim confirmed', { balance: await text('.you__balance .sr-only') });
    } else {
      log('rehearsal: this account has already claimed here, so the claim is skipped');
      await sleep(3000);
    }
    await caption('The balance shows <b>1,000 NOTIT</b>. A real transaction on NEAR testnet.');
    await sleep(900);
    for (const href of await page.locator('.txlink a').evaluateAll((els) => els.map((a) => a.href))) facts.txs.push({ what: 'claim', href });
    await sleep(1400);
    await shot('play-testnet.png');
    await sleep(900);

    // ---- wait for the next round, fast ----
    segment('ff1', FAST);
    await marker(true);
    await caption('The next round opens. <b>The cost to step up starts high and falls.</b>');
    for (;;) {
      if ((await round()) > r0 && (await secondsLeft()) <= 162 && !(await saved())) break;
      if ((await round()) > r0 + 1) throw new Error('missed the round after the claim');
      await sleep(300);
    }
    const r1 = await round();

    // ---- beat 3: "I'll do it" ----
    await marker(false);
    segment('beat3', 1);
    await sleep(3600);
    if (!/I'll do it/.test(await text('.slab__act .cta'))) throw new Error(`cannot volunteer: ${await text('.slab__act')}`);
    const shown = await text('.cost__value .sr-only');
    await page.locator('.slab__act .cta').click();
    event('volunteer clicked', { round: r1, costShown: shown, secondsLeft: await secondsLeft() });
    await settle(
      'beat3',
      page.waitForFunction(
        () =>
          (/You did it/.test(document.querySelector('.slab__act .cta')?.textContent ?? '') && /are It/.test(document.querySelector('.throne')?.textContent ?? '')) ||
          document.querySelector('.cta__hint--note, .cta__hint--warn') !== null,
        null,
        { timeout: 90_000 },
      ),
    );
    if (!/You did it/.test(await text('.slab__act .cta'))) throw new Error(`volunteer was refused: ${await text('.slab__act')}`);
    const burned = await text('.cost__value .sr-only');
    event('volunteer confirmed', { burned, state: await text('.slab__state') });
    await caption(`The guest burns <b>${burned} NOTIT</b> and is now <b>It</b>. A real transaction on NEAR testnet.`);
    await sleep(1200);
    for (const href of await page.locator('.txlink a').evaluateAll((els) => els.map((a) => a.href))) facts.txs.push({ what: 'volunteer', href });
    await sleep(2200);
    await shot('you-are-it.png');
    await sleep(1900);
    facts.burned = burned;

    // ---- the rest of this round and most of the next: left out ----
    segment('wait', 0);
    await caption('The next round. <b>Nobody steps up.</b>');
    for (;;) {
      const r = await round();
      if (r > r1 + 1) throw new Error('missed the quiet round');
      if (r === r1 + 1 && (await secondsLeft()) <= 56) break;
      await sleep(400);
    }
    const r2 = await round();
    if (await saved()) throw new Error(`round ${r2} was saved by someone, so there is no collapse to film`);

    // ---- the last minute of the quiet round, fast, then its last seconds for real ----
    segment('ff2', FAST, { dissolve: true });
    await marker(true);
    while ((await secondsLeft()) > 4 && (await round()) === r2) await sleep(150);
    await marker(false);
    segment('beat4', 1);
    const flashed = () => document.querySelector('.slab__ticker--live.slab__ticker--collapsed') !== null;
    const before = await text('.you__balance .sr-only');
    const collectedBefore = await text('.you .kv div:nth-child(3) dd');
    const collapse = page.waitForFunction(flashed, null, { timeout: 60_000 });
    collapse.catch(() => {});
    // Run the clock out, then give the chain a moment; a longer wait is fast-forwarded.
    while ((await secondsLeft()) > 0 && (await round()) === r2) await sleep(150);
    await settle('beat4', collapse, 3500);
    event('collapse seen', { round: r2, ticker: await text('.slab__ticker') });
    await caption('Nobody stepped up. <b>Everyone paid 15% to It.</b>');
    await sleep(1300);
    // The app's own "+…" chip next to the balance is the amount that just arrived.
    const gained = (await text('.you .delta')).replace(/^\+/, '');
    await shot('collapse.png');
    await sleep(1600);
    const collected = await text('.you .kv div:nth-child(3) dd');
    const after = await text('.you__balance .sr-only');
    event('collapse settled', { balanceBefore: before, balanceAfter: after, gained, collected });
    facts.collapse = { round: r2, balanceBefore: before, balanceAfter: after, gained, collected };
    // If the chip was missed, use the rise of the app's own "You collected" figure, so the
    // caption never differs from the panel by a rounding unit.
    const num = (v) => Number(v.replace(/,/g, ''));
    const rise = (num(collected) - num(collectedBefore)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    facts.collapse.shown = gained || rise;
    await caption(`Nobody stepped up. <b>Everyone paid 15% to It:</b> +${facts.collapse.shown} NOTIT.`);
    await sleep(3600);
    bots('start');

    // ---- beat 5: the lock if there is one, otherwise the record of every round ----
    segment('beat5', 1);
    if (facts.locked) {
      await scrollTo('.chainbar', 110, true);
      await caption('No admin. <b>The contract account has no access keys.</b>');
      await sleep(4200);
      await page.getByRole('tab', { name: 'Rules' }).click();
      await sleep(600);
      await scrollTo('.rules', 12, true);
      await sleep(4600);
      await page.getByRole('tab', { name: 'Play' }).click();
    } else {
      await caption('Every round is on chain: <b>who did it, what they burned, what they collected.</b>');
      await scrollTo('.stats', 14, true);
      await sleep(8200);
    }

    // ---- beat 6: the Lab ----
    segment('beat6', 1);
    await page.getByRole('tab', { name: 'Lab' }).click();
    await caption('More people who could act → <b>less likely anyone does.</b> Simulated against the theory.');
    await page.waitForSelector('#by-n');
    await scrollTo('.lab__grid', 12);
    await page.waitForFunction(() => /Done/.test(document.querySelector('.controls__status')?.textContent ?? ''), null, { timeout: 60_000 });
    await sleep(1500);
    // Three pushes of the slider, pausing so the simulated point for each size appears.
    await page.locator('#by-n').focus();
    for (let push = 0; push < 3; push++) {
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press('ArrowRight');
        await sleep(60);
      }
      await page.waitForFunction(() => /Done/.test(document.querySelector('.controls__status')?.textContent ?? ''), null, { timeout: 60_000 });
      await sleep(400);
    }
    event('lab', { reading: (await text('.reading')).slice(0, 160) });
    await sleep(2200);
    await shot('lab.png');

    // ---- beat 7: end card ----
    segment('end', 1);
    await caption('');
    await page.evaluate(() => window.__vid.end(true));
    await sleep(5000);
    segment('stop', 0);
  } catch (e) {
    problems.push(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: join(WORK_DIR, 'failure.png') }).catch(() => {});
  } finally {
    if (botsStopped) {
      try {
        bots('start');
      } catch (e) {
        problems.push(`COULD NOT RESTART THE BOTS: ${e.message}`);
      }
    }
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    const last = segments[segments.length - 1];
    if (last && last.end === null) last.end = now();
    facts.rpcErrors = rpcErrors;
    await writeFile(join(WORK_DIR, 'timeline.json'), JSON.stringify({ facts, segments, events, frames, problems }, null, 1));
    await browser.close();
  }
  log(`${frames.length} frames kept; ${rpcErrors} RPC requests were refused and retried on another endpoint`);
  console.log('\nTransactions:', facts.txs.map((t) => `\n  ${t.what}: ${t.href}`).join('') || ' none');
  console.log(problems.length ? `\nProblems:\n  ${problems.join('\n  ')}` : '\nNo problems while recording.');
  if (problems.some((p) => p.startsWith('FAILED') || p.startsWith('COULD NOT'))) process.exit(1);
}

/* ------------------------------------------------------------------- build */

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function probeDuration(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return Number(out.trim());
}

async function build() {
  const timeline = JSON.parse(await readFile(join(WORK_DIR, 'timeline.json'), 'utf8'));
  const { frames, segments } = timeline;
  await mkdir(OUT_DIR, { recursive: true });
  const parts = join(WORK_DIR, 'parts');
  await rm(parts, { recursive: true, force: true });
  await mkdir(parts, { recursive: true });

  // 1. One clip per segment: each frame is held until the next one, divided by the segment's speed.
  const clips = [];
  for (const [i, seg] of segments.entries()) {
    if (seg.speed === 0) continue;
    const own = frames.filter((f) => f.ts >= seg.start && f.ts < seg.end);
    if (own.length < 2) {
      console.log(`segment ${seg.name}: only ${own.length} frames, skipped`);
      continue;
    }
    let list = '';
    for (const [k, f] of own.entries()) {
      const until = k + 1 < own.length ? own[k + 1].ts : seg.end;
      list += `file '${join(WORK_DIR, 'frames', f.file)}'\nduration ${(Math.max(0.001, until - f.ts) / seg.speed).toFixed(5)}\n`;
    }
    list += `file '${join(WORK_DIR, 'frames', own[own.length - 1].file)}'\n`;
    const listFile = join(parts, `${i}-${seg.name}.txt`);
    const clip = join(parts, `${i}-${seg.name}.mp4`);
    await writeFile(listFile, list);
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-an', clip]);
    clips.push({ ...seg, clip, duration: probeDuration(clip) });
  }

  // 2. Join. Clips play back to back; where time was dropped, a short dissolve says so.
  const groups = [];
  for (const c of clips) {
    if (groups.length === 0 || c.dissolve) groups.push([c]);
    else groups[groups.length - 1].push(c);
  }
  const groupFiles = [];
  for (const [g, members] of groups.entries()) {
    const file = join(parts, `group-${g}.mp4`);
    const listFile = join(parts, `group-${g}.txt`);
    await writeFile(listFile, members.map((m) => `file '${m.clip}'`).join('\n') + '\n');
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', file]);
    groupFiles.push({ file, duration: probeDuration(file) });
  }
  const out = join(OUT_DIR, 'demo.mp4');
  const encode = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', '-an', out];
  if (groupFiles.length === 1) {
    ffmpeg(['-i', groupFiles[0].file, ...encode]);
  } else {
    const inputs = groupFiles.flatMap((g) => ['-i', g.file]);
    let filter = '';
    let prev = '[0:v]';
    let length = groupFiles[0].duration;
    for (let g = 1; g < groupFiles.length; g++) {
      const label = g === groupFiles.length - 1 ? '[v]' : `[x${g}]`;
      filter += `${prev}[${g}:v]xfade=transition=fade:duration=${DISSOLVE}:offset=${(length - DISSOLVE).toFixed(3)}${label};`;
      length += groupFiles[g].duration - DISSOLVE;
      prev = label;
    }
    ffmpeg([...inputs, '-filter_complex', filter.replace(/;$/, ''), '-map', '[v]', ...encode]);
  }

  // 3. Where each beat lands in the finished video.
  let t = 0;
  const beats = [];
  for (const [g, members] of groups.entries()) {
    if (g > 0) t -= DISSOLVE;
    for (const m of members) {
      beats.push({ name: m.name, speed: m.speed, from: Number(t.toFixed(2)), to: Number((t + m.duration).toFixed(2)) });
      t += m.duration;
    }
  }
  const total = probeDuration(out);
  const at = (name, frac) => {
    const b = beats.find((x) => x.name === name);
    return b ? b.from + (b.to - b.from) * frac : total / 2;
  };
  // Poster: the moment after the volunteer is confirmed ("you are It").
  const posterAt = beats.some((b) => b.name === 'beat3-confirmed') ? at('beat3-confirmed', 0.6) : at('beat3', 0.85);
  ffmpeg(['-ss', posterAt.toFixed(2), '-i', out, '-frames:v', '1', join(OUT_DIR, 'demo-poster.png')]);
  await writeFile(join(WORK_DIR, 'beats.json'), JSON.stringify({ total, beats, facts: timeline.facts, events: timeline.events }, null, 1));
  console.log(`\n${out}: ${total.toFixed(1)} s`);
  for (const b of beats) console.log(`  ${String(b.from.toFixed(1)).padStart(5)} – ${String(b.to.toFixed(1)).padStart(5)}  ${b.name}${b.speed !== 1 ? ` (x${b.speed})` : ''}`);
  if (existsSync(join(WORK_DIR, 'shots'))) console.log(`\nScreenshots for the README are in ${join(WORK_DIR, 'shots')}`);
}

// Only when run directly (the overlay can be imported on its own to check the layout).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'all';
  if (mode === 'record' || mode === 'all') await record();
  if (mode === 'build' || mode === 'all') await build();
}
