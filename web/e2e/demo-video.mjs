/**
 * Records the demo video from the real app on a real contract, then cuts it.
 *
 * What it does
 *   record  Opens the served build in Testnet mode, signed in as an existing
 *           testnet account, and drives one real sequence:
 *             watch -> claim 1,000 NOTIT -> next round: "I'll do it" (you are It)
 *             -> the round after: nobody volunteers, everyone pays It
 *             -> the lock line and rule five if the contract is locked (hero wall and history if not)
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
 *   FORCE_LOCK_BEAT=1  with REHEARSAL: film the lock beat's scrolling on a contract that is not locked
 *   SITE               address shown on the end card       (default arshiaxbt.github.io/notit)
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
/** `lab` mode: film only the Lab beat (it does not touch the chain), to splice into a take with BEAT6_FROM. */
let LAB_ONLY = false;
/** Shown on the end card. */
const SITE = process.env.SITE ?? 'arshiaxbt.github.io/notit';
/** Rehearse the lock beat's scrolling on a contract that is not locked (never for a real take). */
const FORCE_LOCK_BEAT = REHEARSAL && process.env.FORCE_LOCK_BEAT === '1';
const W = 1280;
const H = 720;
const FPS = 30;
const FAST = 16;
const DISSOLVE = 0.4;
/** The page is filmed at its real size: the stage fills the frame under the caption band. */
const ZOOM = 1;
/** The caption band sits over the header, at the very top of the frame, and is exactly as tall. */
const BAND = 97;

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

/* ------------------------------------------------------------------ record */

/** Runs in the page: caption bar, fast-forward marker and end card, in the app's own style. */
export function installOverlay({ zoom, speed, url = '', band = 97 }) {
  document.body.style.zoom = String(zoom);
  const style = document.createElement('style');
  style.textContent = `
    .vid { font-family: 'Bricolage Grotesque Variable', system-ui, sans-serif; position: fixed; z-index: 9999; pointer-events: none; }
    .vid-off .vid { visibility: hidden; }
    .vid-caption { left: 0; right: 0; top: 0; height: ${band}px; display: grid; place-content: center; padding: 0 60px;
      background: #16130c; color: #fff4d6; font-weight: 800; font-size: 28px; line-height: 1.16; letter-spacing: -0.01em;
      text-align: center; text-wrap: balance; opacity: 0; transition: opacity .18s ease; }
    .vid-caption.on { opacity: 1; }
    .vid-caption b { color: #ffd60a; }
    .vid-fast { right: 28px; top: ${band + 16}px; padding: 4px 13px 5px; background: #16130c; color: #ffd60a;
      border-radius: 10px; font-weight: 800; font-size: 24px; letter-spacing: .02em; display: none; }
    .vid-fast.on { display: block; }
    .vid-end { inset: 0; display: grid; place-content: center; justify-items: center; gap: 20px; background: #ffd60a; color: #16130c;
      opacity: 0; transition: opacity .35s ease; text-align: center; }
    .vid-end.on { opacity: 1; }
    .vid-end__logo { display: flex; align-items: center; gap: 18px; font-weight: 800; font-size: 120px; line-height: 1; letter-spacing: -0.04em; }
    .vid-end__it { padding: 6px 30px 16px; background: #ffd60a; color: #16130c; border: 8px solid #16130c; border-radius: 30px; transform: rotate(-5deg); }
    .vid-end__name { font-weight: 800; font-size: 46px; letter-spacing: -0.02em; }
    .vid-end__name b { color: inherit; }
    .vid-end__by { font-weight: 700; font-size: 34px; }
    .vid-end__url { font-weight: 800; font-size: 34px; text-decoration: underline; text-decoration-thickness: 3px; text-underline-offset: 6px; }
    .vid-end__url:empty { display: none; }
    .vid-end__small { margin-top: 4px; font-weight: 700; font-size: 26px; }
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
    <div class="vid-end__url">${url}</div>
    <div class="vid-end__small">testnet, no value</div>`;
  window.__vid = {
    caption(html) {
      if (!html) {
        caption.classList.remove('on');
        return;
      }
      caption.innerHTML = `<span>${html}</span>`; // one flow of text, centred in the band
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
  if (!credPath && !LAB_ONLY) throw new Error('GUEST_CREDENTIALS is required: a credentials file { account_id, private_key }');
  const cred = LAB_ONLY ? { account_id: '', private_key: '' } : JSON.parse(await readFile(resolve(credPath.replace(/^~/, process.env.HOME ?? '~')), 'utf8'));
  const guest = { accountId: cred.account_id, secretKey: cred.private_key };
  if (!LAB_ONLY && (!guest.accountId || !/^ed25519:/.test(guest.secretKey ?? ''))) throw new Error('credentials file needs account_id and private_key');

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(join(WORK_DIR, 'frames'), { recursive: true });
  await mkdir(join(WORK_DIR, 'shots'), { recursive: true });

  const browser = await chromium.launch();
  // The account is restored exactly as the app restores a returning guest: from localStorage.
  // A take: the account is put in storage as if the faucet had just made it, so the film shows the
  // whole sign-up after that: a claim on each contract, then the key swapped for one that can only
  // volunteer. A rehearsal: an account that has done all that is restored as a returning guest.
  const signIn = ({ accountId, secretKey, fresh }) => {
    if (!localStorage.getItem('notit-guest:testnet')) {
      localStorage.setItem('notit-guest:testnet', JSON.stringify(fresh ? { accountId, secretKey, setup: 'pending' } : { accountId, secretKey }));
      if (!fresh) localStorage.setItem('notit-signer', 'guest');
    }
    localStorage.setItem('notit-theme', 'light');
  };
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light' });
  if (LAB_ONLY) await context.addInitScript(() => localStorage.setItem('notit-theme', 'light'));
  else await context.addInitScript(signIn, { ...guest, fresh: !REHEARSAL });
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
  const round = async () => Number((await text('#strip-title')).replace(/\D/g, ''));
  const secondsLeft = async () => {
    const parts = (await text('.clock .sr-only')).split(':').map(Number);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  };
  const saved = async () => (await page.locator('.stage--saved').count()) > 0;
  const caption = (html) => page.evaluate((h) => window.__vid.caption(h), html);
  const marker = (on) => page.evaluate((v) => window.__vid.fast(v), on);
  /** The balance the figures under the stage show ("keep"). */
  const balance = () => text('.figs__item dd .sr-only');
  /** A row of the volunteer table for the signed-in account: 2 = burned, 3 = collected. */
  const mine = (col) => text(`.wall tr.is-me td:nth-of-type(${col})`);
  const num = (v) => Number(v.replace(/[^0-9.]/g, ''));
  const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const keep = (data, ts) => {
    lastKept = ts;
    const file = `f${String(++counter).padStart(6, '0')}.jpg`;
    frames.push({ file, ts });
    writes.push(writeFile(join(WORK_DIR, 'frames', file), Buffer.from(data, 'base64')));
  };
  // Chrome only sends a frame when the picture changes. A frame that arrives too soon
  // after the last kept one is held back, and kept after all if nothing newer follows:
  // otherwise the last frame of a scroll or a fade could be lost and a stale one shown.
  let held = null;
  let heldTimer = null;
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    const ts = f.metadata.timestamp ?? now();
    clearTimeout(heldTimer);
    if (paused || minGap === Infinity) {
      held = null;
      return;
    }
    if (ts - lastKept < minGap) {
      held = { data: f.data, ts };
      heldTimer = setTimeout(() => {
        if (held && !paused && minGap !== Infinity) keep(held.data, held.ts);
        held = null;
      }, Math.min(400, Math.max(40, minGap * 1000)));
      return;
    }
    held = null;
    keep(f.data, ts);
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

  /** How many holders the crowd-size slider is set to. */
  const crowdSize = () => page.evaluate(() => Number((document.querySelector('#by-n')?.getAttribute('aria-valuetext') ?? '0').replace(/\D/g, '')));
  const labDone = () => page.waitForFunction(() => /Done/.test(document.querySelector('.controls__status')?.textContent ?? ''), null, { timeout: 60_000 });
  /** Puts the slider at about `target` holders with the arrow keys (the scale is logarithmic). */
  const slideTo = async (target, pause) => {
    await page.locator('#by-n').focus();
    const position = () => page.evaluate(() => Number(document.querySelector('#by-n')?.value ?? 0));
    for (let i = 0; i < 260; i++) {
      const n = await crowdSize();
      if (n === target) break;
      const before = await position();
      await page.keyboard.press(n < target ? 'ArrowRight' : 'ArrowLeft');
      await sleep(pause || 20);
      // Several positions of the slider can mean the same size; only an unmoved slider is the end of the scale.
      if ((await position()) === before) break;
      const m = await crowdSize();
      if ((n < target && m >= target) || (n > target && m <= target)) break;
    }
  };
  /**
   * The Lab beat: the crowd grows from about 10 to about 60 holders and the simulated point
   * climbs the equilibrium curve, with the dashed textbook line above it.
   */
  const labBeat = async () => {
    await page.mouse.move(16, 420); // in the margin: over the chart it would raise a tooltip
    await caption('More holders who could act, <b>less chance anyone does.</b> Simulated against the equilibrium.');
    await page.waitForSelector('#by-n');
    await scrollTo('.lab__grid', BAND + 14);
    await labDone();
    await sleep(1600);
    for (const target of [20, 35, 60]) {
      await slideTo(target, 30);
      await labDone();
      await sleep(550);
    }
    event('lab', { holders: await crowdSize(), reading: (await text('.reading')).slice(0, 160) });
    await sleep(2300);
    await shot('lab.png');
  };

  try {
    take: {
      if (LAB_ONLY) {
        // Only the Lab: open it, start small, film the crowd growing.
        await page.goto(`${BASE_URL}#lab`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#by-n', { timeout: 45_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(installOverlay, { zoom: ZOOM, speed: FAST, url: SITE, band: BAND });
        await labDone();
        await slideTo(10, 0);
        await labDone();
        await scrollTo('.lab__grid', BAND + 14);
        await page.mouse.move(16, 420); // in the margin: over the chart it would raise a tooltip
        await caption('More holders who could act, <b>less chance anyone does.</b> Simulated against the equilibrium.');
        await sleep(500);
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, everyNthFrame: 1 });
        segment('beat6', 1);
        await labBeat();
        segment('stop', 0);
        break take;
      }
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stage .face', { timeout: 45_000 });
    if (REHEARSAL) await page.waitForSelector('.acct__id', { timeout: 45_000 });
    else await page.waitForFunction(() => /Continue as guest/.test(document.querySelector('.dock .act')?.textContent ?? ''), null, { timeout: 45_000 });
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('.lock')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(installOverlay, { zoom: ZOOM, speed: FAST, url: SITE, band: BAND });
    facts.contract = await text('.chainbar code');
    facts.locked = (await page.locator('.lock--locked').count()) > 0;
    log(`${REHEARSAL ? `signed in as ${await text('.acct__id')}` : `guest ${guest.accountId} ready to set up`} on ${facts.contract}; locked: ${facts.locked}`);
    const canClaim = /Claim|Continue as guest/.test(await text('.dock .act'));
    if (!canClaim && !REHEARSAL) throw new Error(`expected a "Claim" button, found: ${await text('.dock')}`);

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
    await caption('Not It ($NOTIT): <b>a volunteer’s dilemma as a token</b>, live on NEAR testnet.'); // the pitch itself is on the stage
    await sleep(5200);

    // ---- beat 2: the guest claims ----
    segment('beat2', 1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await caption('A guest account claims <b>1,000 NOTIT</b>, then swaps its key for one that <b>can only volunteer</b>.');
    await sleep(1800);
    if (canClaim) {
      await page.locator('.dock .act').click();
      await page.mouse.move(1180, 420); // off the button, so it is not filmed in its hover colour
      event('sign-up clicked', { round: await round() });
      // Done when the sign-up is over: the key marker is there and the button is the game's again.
      await settle(
        'beat2',
        page.waitForFunction(
          () => document.querySelector('.chainbar .keymark') !== null && !/Claim|Setting up|Signing in|Continue as guest|Try again/.test(document.querySelector('.dock .act')?.textContent ?? 'Claim'),
          null,
          { timeout: 120_000 },
        ),
      );
      facts.key = await text('.chainbar .keymark');
      event('sign-up finished', { balance: await balance(), key: facts.key });
      // The band lifts for a moment, so the header shows "key: volunteer only" beside the account.
      await sleep(900);
      await caption('');
      await sleep(2600);
    } else {
      log('rehearsal: this account has already claimed here, so the claim is skipped');
      await sleep(3000);
    }
    for (const href of await page.locator('.txlink a').evaluateAll((els) => els.map((a) => a.href))) facts.txs.push({ what: 'claim', href });

    // ---- wait for the next round, fast ----
    segment('ff1', FAST);
    await marker(true);
    await caption('The next round opens. <b>The cost to volunteer starts high and falls.</b>');
    for (;;) {
      if ((await round()) > r0 && (await secondsLeft()) <= 162 && !(await saved())) break;
      if ((await round()) > r0 + 1) throw new Error('missed the round after the claim');
      await sleep(300);
    }
    const r1 = await round();

    // ---- beat 3: "I'll do it" ----
    await marker(false);
    segment('beat3', 1);
    await sleep(1300);
    await shot('play-testnet.png'); // the live ring mid-round, the cost falling on the button
    await sleep(2300);
    if (!/I'll do it/.test(await text('.dock .act')) || (await page.locator('.dock .act:not([disabled])').count()) === 0) throw new Error(`cannot volunteer: ${await text('.dock')}`);
    const shown = await text('.act__cost .sr-only');
    const heldBefore = await balance();
    await page.locator('.dock .act').click();
      await page.mouse.move(1180, 420); // off the button, so it is not filmed in its hover colour
    event('volunteer clicked', { round: r1, costShown: shown, secondsLeft: await secondsLeft() });
    await settle(
      'beat3',
      page.waitForFunction(
        () => (document.querySelector('.stamp') !== null && document.querySelector('.face--it.face--you') !== null) || document.querySelector('.act__alert') !== null,
        null,
        { timeout: 90_000 },
      ),
    );
    if (!/You did it/.test(await text('.stamp'))) throw new Error(`volunteer was refused: ${await text('.dock')}`);
    // What was burned is what left the balance (the figure under the stage counts down to it).
    await sleep(1100);
    // The app's own "Burned" figure for this account, when the table already has it (a fresh
    // account has burned nothing else); otherwise the drop in the balance, which can differ
    // from it by a hundredth because both balances are shown truncated.
    const tableBurned = await mine(2);
    const burned = tableBurned || fmt(num(heldBefore) - num(await balance()));
    event('volunteer confirmed', { burned, state: await text('.stamp'), tableBurned });
    await caption(`Burn <b>${burned} NOTIT</b>: the round is saved and you are <b>It</b>. A real transaction on NEAR testnet.`);
    await sleep(600);
    for (const href of await page.locator('.txlink a').evaluateAll((els) => els.map((a) => a.href))) facts.txs.push({ what: 'volunteer', href });
    await sleep(1700);
    await shot('you-are-it.png');
    await sleep(1900);
    facts.burned = burned;

    // ---- the rest of this round and most of the next: left out ----
    segment('wait', 0);
    await caption('The next round. <b>Nobody volunteers.</b>');
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
    const flashed = () => document.querySelector('.stage--paid') !== null;
    const before = await balance();
    const collectedBefore = await mine(3);
    const collapse = page.waitForFunction(flashed, null, { timeout: 60_000 });
    collapse.catch(() => {});
    // Run the clock out, then give the chain a moment; a longer wait is fast-forwarded.
    while ((await secondsLeft()) > 0 && (await round()) === r2) await sleep(150);
    await settle('beat4', collapse);
    // The README's collapse picture is cut from the filmed frames (coins mid-flight), so nothing pauses here.
    facts.collapseAt = now();
    event('collapse seen', { round: r2, line: await text('.stage__line'), note: await text('.act__note') });
    await caption('Nobody volunteered. <b>Everyone paid 15% to It.</b>');
    await sleep(1300);
    // The app's own "+…" chip next to the balance is the amount that just arrived.
    const gained = (await text('.figs__delta')).replace(/^\+/, '');
    await sleep(1600);
    const collected = await mine(3);
    const after = await balance();
    event('collapse settled', { balanceBefore: before, balanceAfter: after, gained, collected });
    facts.collapse = { round: r2, balanceBefore: before, balanceAfter: after, gained, collected };
    // If the chip was missed, use the rise of the app's own "Collected" figure in the table (or
    // of the balance), so the caption never differs from the page by a rounding unit.
    const rise = collected && collectedBefore ? fmt(num(collected) - num(collectedBefore)) : fmt(num(after) - num(before));
    facts.collapse.shown = gained || rise;
    await caption(`Nobody volunteered. <b>Everyone paid 15% to It:</b> +${facts.collapse.shown} NOTIT.`);
    await sleep(3600);
    bots('start');

    // ---- beat 5: the lock if there is one, otherwise the record of every round ----
    segment('beat5', 1);
    if (facts.locked || FORCE_LOCK_BEAT) {
      // The lock line on the Play page, then rule five on the Rules page.
      await caption('No admin. <b>The contract account has no access keys</b>, so nobody can change the rules — including its author.');
      await scrollTo('.chainbar', 380, true);
      await sleep(4800);
      await page.getByRole('tab', { name: 'Rules' }).click();
      await page.waitForSelector('.rules');
      await scrollTo('.rule:nth-child(5)', 300);
      await sleep(4800);
    } else {
      await caption('Every round is on chain: <b>who did it, what they burned, what they collected.</b>');
      await scrollTo('.strip', BAND + 20, true);
      await sleep(8200);
    }

    // ---- beat 6: the Lab ----
    segment('beat6', 1);
    await page.getByRole('tab', { name: 'Lab' }).click();
    await labBeat();

    // ---- beat 7: end card ----
    segment('end', 1);
    await caption('');
    await page.evaluate(() => window.__vid.end(true));
    await sleep(5000);
    segment('stop', 0);
    }
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
    clearTimeout(heldTimer);
    if (held && minGap !== Infinity) keep(held.data, held.ts);
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
  const { segments } = timeline;
  const frames = [...timeline.frames].sort((a, b) => a.ts - b.ts);
  await mkdir(OUT_DIR, { recursive: true });
  const parts = join(WORK_DIR, 'parts');
  await rm(parts, { recursive: true, force: true });
  await mkdir(parts, { recursive: true });

  // SKIP_SEGMENTS=beat6 leaves segments out of the cut. BEAT6_FROM=<work dir of `lab`> takes the
  // Lab beat from a separate recording (the Lab does not touch the chain, so it can be re-shot).
  const skip = new Set((process.env.SKIP_SEGMENTS ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  let labDir = null;
  let labTimeline = null;
  if (process.env.BEAT6_FROM) {
    labDir = resolve(process.env.BEAT6_FROM);
    labTimeline = JSON.parse(await readFile(join(labDir, 'timeline.json'), 'utf8'));
  }

  // 1. One clip per segment: each frame is held until the next one, divided by the segment's speed.
  const clips = [];
  for (const [i, seg0] of segments.entries()) {
    if (seg0.speed === 0 || skip.has(seg0.name)) continue;
    let seg = seg0;
    let segFrames = frames;
    let framesDir = join(WORK_DIR, 'frames');
    if (labTimeline && seg0.name === 'beat6') {
      const other = labTimeline.segments.find((x) => x.name === 'beat6');
      if (!other) throw new Error(`no beat6 segment in ${labDir}`);
      seg = { ...other, dissolve: seg0.dissolve };
      segFrames = [...labTimeline.frames].sort((a, b) => a.ts - b.ts);
      framesDir = join(labDir, 'frames');
    }
    const own = segFrames.filter((f) => f.ts >= seg.start && f.ts < seg.end);
    // If the picture did not change right at the start of the segment, the frame showing
    // then is the last one before it (only if recent: nothing is kept during left-out waits).
    const before = segFrames.filter((f) => f.ts < seg.start).pop();
    if (before && seg.start - before.ts < 1 && (own.length === 0 || own[0].ts - seg.start > 0.05)) {
      own.unshift({ file: before.file, ts: seg.start });
    }
    if (own.length < 2) {
      console.log(`segment ${seg.name}: only ${own.length} frames, skipped`);
      continue;
    }
    let list = '';
    for (const [k, f] of own.entries()) {
      const until = k + 1 < own.length ? own[k + 1].ts : seg.end;
      list += `file '${join(framesDir, f.file)}'\nduration ${(Math.max(0.001, until - f.ts) / seg.speed).toFixed(5)}\n`;
    }
    list += `file '${join(framesDir, own[own.length - 1].file)}'\n`;
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

  // 2b. The README's collapse picture: the filmed frame about 0.3 s after the round closed
  // unsaved (coins on their way), without the caption band.
  const collapseAt = timeline.facts?.collapseAt;
  if (collapseAt) {
    const want = collapseAt + 0.42;
    const near = frames.filter((f) => f.ts >= collapseAt + 0.2 && f.ts <= collapseAt + 0.7).sort((a, b) => Math.abs(a.ts - want) - Math.abs(b.ts - want))[0];
    if (near) {
      await mkdir(join(WORK_DIR, 'shots'), { recursive: true });
      ffmpeg(['-i', join(WORK_DIR, 'frames', near.file), '-vf', `crop=${W}:${H - BAND - 1}:0:${BAND + 1}`, join(WORK_DIR, 'shots', 'collapse.png')]);
      console.log(`collapse.png from ${near.file}, ${(near.ts - collapseAt).toFixed(2)} s after the round closed`);
    } else console.log('no frame near the collapse for collapse.png');
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
  if (mode === 'lab') {
    LAB_ONLY = true;
    await record();
  }
  if (mode === 'record' || mode === 'all') await record();
  if (mode === 'build' || mode === 'all') await build();
}
