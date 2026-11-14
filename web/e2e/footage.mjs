/**
 * Clean footage of the app for a film cut elsewhere: no captions, no speed
 * changes, real time, 2560x1440 (a 1280x720 page at device scale 2), with a
 * visible pointer that moves like a hand and rings when it presses.
 *
 *   node web/e2e/footage.mjs session   one real session on NEAR testnet (clips watch, signup, volunteer, unsaved, locked)
 *   node web/e2e/footage.mjs phone     the same account on a phone-sized page (needs the session's storage)
 *   node web/e2e/footage.mjs lab       the Lab (no chain)
 *   node web/e2e/footage.mjs demo      Demo-mode plates, named demo-… so they are never passed off as testnet
 *   node web/e2e/footage.mjs timeline  merge what the modes wrote into <OUT>/timeline.json
 *
 * Each mode writes its clips as MP4 (H.264, CRF 12, yuv420p, 30 fps) into OUT and
 * its part of the timeline into WORK. Frame numbers in the timeline count from
 * the first frame of each clip.
 *
 * Variables: BASE_URL (default http://127.0.0.1:4173/), GUEST_CREDENTIALS (session),
 * OUT (default ../video/footage), WORK (default web/.video/footage, git-ignored),
 * BOTS_STOP / BOTS_START (shell commands), PLAYWRIGHT_MODULE, FFMPEG, FFPROBE.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const OUT = resolve(process.env.OUT ?? join(here, '../../video/footage'));
const WORK = resolve(process.env.WORK ?? join(here, '../.video/footage'));
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const FPS = 30;
const mode = process.argv[2] ?? 'session';
/** Where the signed-in browser state is kept between `session` and `phone`: it holds the guest's (volunteer-only) keys, so never under the repository. */
const STATE = resolve(process.env.STATE ?? '/tmp/notit-footage-guest-state.json');

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

/** Runs in the page on every load: a pointer that follows the mouse, and a ring where it presses. */
function installCursor() {
  const start = () => {
    if (document.getElementById('__cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #__cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; width: 22px; height: 22px; pointer-events: none; transform: translate(-200px, -200px); will-change: transform; }
      #__cursor.is-hidden { display: none; }
      .__press { position: fixed; left: 0; top: 0; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px; border: 3px solid #16130c; border-radius: 50%; pointer-events: none; animation: __press 0.42s ease-out forwards; }
      @keyframes __press { from { opacity: 0.9; scale: 0.35; } to { opacity: 0; scale: 1.25; } }
    `;
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18.5 L7.6 14.4 L10.6 20.6 L13.4 19.3 L10.5 13.2 L16.6 12.9 Z" fill="#16130c" stroke="#fffdf5" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const saved = sessionStorage.getItem('__cursor');
    if (saved) c.style.transform = saved;
    document.addEventListener('mousemove', (e) => {
      c.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
      sessionStorage.setItem('__cursor', c.style.transform);
    }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__press';
      r.style.translate = `${e.clientX}px ${e.clientY}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.documentElement && document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
}

/** A browser whose real device scale is `scale`, so the screencast is that many device pixels per CSS pixel. */
async function open({ width, height, scale, storageState, initScripts = [] }) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, '--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: null, colorScheme: 'light', storageState });
  await context.addInitScript(() => { try { localStorage.setItem('notit-theme', 'light'); } catch {} });
  await context.addInitScript(installCursor);
  for (const [fn, arg] of initScripts) await context.addInitScript(fn, arg);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const size = async () => page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));

  // ---- the pointer: eased moves, never teleports ----
  const mouse = { x: Math.round(width * 0.82), y: Math.round(height * 0.62) };
  const moveTo = async (x, y, ms = 520) => {
    const { x: x0, y: y0 } = mouse;
    const steps = Math.max(6, Math.round(ms / 34)); // about one move per captured frame
    const begin = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
      const due = begin + (ms * i) / steps;
      if (due > Date.now()) await sleep(due - Date.now());
    }
    mouse.x = x;
    mouse.y = y;
  };
  const centre = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`nothing to point at: ${selector}`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const pointAt = async (selector, ms, dx = 0, dy = 0) => {
    const c = await centre(selector);
    await moveTo(c.x + dx, c.y + dy, ms);
    return { x: c.x + dx, y: c.y + dy };
  };
  const press = async () => {
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
  };
  const showCursor = (on) => page.evaluate((v) => document.getElementById('__cursor')?.classList.toggle('is-hidden', !v), on);

  // ---- capture: the screencast, kept only while a clip is open ----
  const cdp = await context.newCDPSession(page);
  const clips = [];
  let clip = null;
  let last = null; // the most recent frame, so a clip can start on the picture already showing
  const writes = [];
  const keep = (data, ts) => {
    const file = `f${String(clip.frames.length + 1).padStart(6, '0')}.jpg`;
    clip.frames.push({ file, ts });
    writes.push(writeFile(join(clip.dir, file), Buffer.from(data, 'base64')));
  };
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    const ts = f.metadata.timestamp ?? now();
    last = { data: f.data, ts };
    if (clip) keep(f.data, ts);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: width * scale, maxHeight: height * scale, everyNthFrame: 1 });

  const startClip = async (name, facts = {}) => {
    const dir = join(WORK, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    clip = { name, dir, start: now(), end: null, frames: [], events: [], facts };
    if (last) keep(last.data, clip.start);
    log(`--- clip ${name}`);
    return clip;
  };
  const mark = (name, extra = {}) => {
    if (!clip) return;
    const t = now() - clip.start;
    clip.events.push({ name, frame: Math.round(t * FPS), t: Number(t.toFixed(3)), pointer: { x: mouse.x, y: mouse.y }, ...extra });
    log(`    ${name} @${t.toFixed(2)}s`, Object.keys(extra).length ? JSON.stringify(extra) : '');
  };
  const stopClip = async () => {
    if (!clip) return null;
    clip.end = now();
    const done = clip;
    clip = null;
    clips.push(done);
    log(`--- end ${done.name}: ${(done.end - done.start).toFixed(1)} s, ${done.frames.length} frames captured`);
    return done;
  };

  const close = async () => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    await browser.close();
  };
  return { browser, context, page, problems, size, mouse, moveTo, pointAt, press, showCursor, startClip, stopClip, mark, clips, close };
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}
function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames:format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(out);
  return { width: j.streams[0].width, height: j.streams[0].height, frames: Number(j.streams[0].nb_read_frames), duration: Number(j.format.duration), bytes: Number(j.format.size) };
}

/** Each captured frame is held until the next one, then the clip is resampled to a steady 30 fps: real time, no speed change. */
async function encode(clip) {
  await mkdir(OUT, { recursive: true });
  let list = '';
  for (const [i, f] of clip.frames.entries()) {
    const until = i + 1 < clip.frames.length ? clip.frames[i + 1].ts : clip.end;
    list += `file '${join(clip.dir, f.file)}'\nduration ${Math.max(0.001, until - f.ts).toFixed(5)}\n`;
  }
  list += `file '${join(clip.dir, clip.frames[clip.frames.length - 1].file)}'\n`;
  const listFile = join(clip.dir, 'list.txt');
  await writeFile(listFile, list);
  const file = join(OUT, `${clip.name}.mp4`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-movflags', '+faststart', '-an', file]);
  const p = probe(file);
  const gaps = clip.frames.slice(1).map((f, i) => f.ts - clip.frames[i].ts).sort((a, b) => a - b);
  log(`encoded ${clip.name}.mp4: ${p.duration.toFixed(2)} s, ${p.frames} frames, ${p.width}x${p.height}, ${(p.bytes / 1e6).toFixed(1)} MB; captured ${clip.frames.length} frames, median gap ${gaps.length ? (gaps[gaps.length >> 1] * 1000).toFixed(0) : '-'} ms`);
  return {
    file: `${clip.name}.mp4`,
    fps: FPS,
    frames: p.frames,
    width: p.width,
    height: p.height,
    seconds: Number(p.duration.toFixed(3)),
    capturedFrames: clip.frames.length,
    events: clip.events,
    facts: clip.facts,
  };
}

async function savePart(name, clips, extra = {}) {
  await mkdir(WORK, { recursive: true });
  const entries = [];
  for (const c of clips) entries.push(await encode(c));
  await writeFile(join(WORK, `part-${name}.json`), JSON.stringify({ part: name, recordedAt: new Date().toISOString(), base: BASE, clips: entries, ...extra }, null, 1));
  return entries;
}

/* ------------------------------------------------------------------ reading the page */

const READ = () => {
  const t = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const b = document.querySelector('.dock .act');
  const [m, sec] = (t('.clock .sr-only') || '0:00').split(':').map(Number);
  return {
    left: m * 60 + sec,
    round: Number(t('#strip-title').replace(/\D/g, '')),
    label: t('.dock .act .act__label'),
    cost: t('.act__cost .sr-only'),
    enabled: !!b && !b.disabled,
    pending: !!b?.classList.contains('act--pending'),
    note: t('.act__note'),
    line: t('.stage__line'),
    stamp: t('.stamp'),
    saved: !!document.querySelector('.stage--saved'),
    paid: !!document.querySelector('.stage--paid'),
    asleep: !!document.querySelector('.stage--asleep'),
    youIt: !!document.querySelector('.face--it.face--you'),
    it: document.querySelector('.face--it')?.getAttribute('data-face') ?? null,
    keymark: t('.chainbar .keymark'),
    account: document.querySelector('.acct__id')?.getAttribute('title') ?? '',
    balance: t('.figs__item:first-child dd .sr-only'),
    figures: [...document.querySelectorAll('.figs__item')].map((i) => `${i.querySelector('dt')?.textContent}: ${i.querySelector('dd .sr-only')?.textContent ?? i.querySelector('dd')?.textContent}`),
    delta: t('.figs__delta'),
    myBurned: t('.wall tr.is-me td:nth-of-type(2)'),
    myPaid: t('.wall tr.is-me td:nth-of-type(3)'),
    tx: [...document.querySelectorAll('.txlink a')].map((a) => a.href),
    faces: document.querySelectorAll('.stage .face:not(.face--ghost)').length,
    contract: t('.chainbar code'),
  };
};

async function until(page, fn, ms, what, every = 120) {
  const begin = Date.now();
  for (;;) {
    const s = await page.evaluate(READ);
    if (fn(s)) return s;
    if (Date.now() - begin > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s).slice(0, 300)}`);
    await sleep(every);
  }
}

/* ------------------------------------------------------------------------- session */

async function session() {
  const credPath = process.env.GUEST_CREDENTIALS;
  if (!credPath) throw new Error('GUEST_CREDENTIALS is required');
  const cred = JSON.parse(await readFile(resolve(credPath), 'utf8'));
  const guest = { accountId: cred.account_id, secretKey: cred.private_key };
  const bots = (which) => {
    const cmd = which === 'stop' ? process.env.BOTS_STOP : process.env.BOTS_START;
    if (!cmd) return '';
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    log(`bots ${which}: ${out}`);
    return out;
  };
  const s = await open({ width: 1280, height: 720, scale: 2 });
  const { page, moveTo, pointAt, press, startClip, stopClip, mark, showCursor } = s;
  const read = () => page.evaluate(READ);
  const facts = { account: guest.accountId, base: BASE, deviations: [] };
  let botsStopped = false;
  try {
    await page.goto(BASE + '#play', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stage .face:not(.face--ghost)', { timeout: 60_000 });
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('.lock')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    log('page', JSON.stringify(await s.size()), JSON.stringify(await read()).slice(0, 200));
    facts.contract = (await read()).contract;

    // ---- 1. watch: the live ring, signed out, mid-round, nothing touched ----
    await showCursor(false);
    await until(page, (x) => !x.saved && x.left <= 150 && x.left >= 85, 400_000, 'a round in its middle');
    let c = await startClip('watch');
    let r = await read();
    c.facts = { round: r.round, secondsLeftAtStart: r.left, it: r.it, faces: r.faces, signedIn: false, figures: r.figures };
    await sleep(12_000);
    r = await read();
    c.facts.secondsLeftAtEnd = r.left;
    await stopClip();
    await showCursor(true);
    await page.mouse.move(s.mouse.x, s.mouse.y);

    // ---- 2. signup: in a round a bot has already saved, so the claim is not cut on the way in ----
    r = await until(page, (x) => x.saved && x.left >= 26 && x.left <= 75, 20 * 60_000, 'a saved round with time to sign up', 400);
    bots('stop');
    botsStopped = true;
    const r0 = r.round;
    c = await startClip('signup');
    c.facts = { round: r0, account: guest.accountId, balanceBefore: r.balance || '—' };
    await sleep(2000);
    const at = await pointAt('.dock .act', 760);
    await sleep(250);
    // The account was made by the faucet beforehand; its key is put in storage in the instant of the press,
    // so the button the pointer travels to still reads "Play as guest" and the app carries on from there.
    c.facts.buttonLabel = (await read()).label;
    await page.evaluate(({ accountId, secretKey }) => localStorage.setItem('notit-guest:testnet', JSON.stringify({ accountId, secretKey, setup: 'pending' })), guest);
    mark(`pointer down on "${c.facts.buttonLabel}"`, { target: at });
    await press();
    await moveTo(at.x + 250, at.y - 46, 620);
    let lastNote = '';
    const begin = Date.now();
    for (;;) {
      r = await read();
      const note = r.note.replace(/\s*\(opens the block explorer\)/, '');
      if (note !== lastNote && note) {
        lastNote = note;
        if (/^\d\/\d/.test(note)) mark(`step: ${note}`);
      }
      if (r.keymark && !/Setting up|Signing in|Continue as guest|Play as guest|Try again/.test(r.label)) break;
      if (Date.now() - begin > 120_000) throw new Error('sign-up did not finish: ' + JSON.stringify(r).slice(0, 300));
      await sleep(60);
    }
    mark('signed in', { key: r.keymark.replace(/\s*\(opens the block explorer\)/, ''), balance: r.balance });
    c.facts.signUpSeconds = Number(((Date.now() - begin) / 1000).toFixed(1));
    c.facts.key = r.keymark.replace(/\s*\(opens the block explorer\)/, '');
    c.facts.balanceAfter = r.balance;
    c.facts.claimOnFastTx = (r.tx[0] ?? '').split('/').pop() || null;
    await sleep(3200);
    await stopClip();
    facts.signup = c.facts;

    // ---- 3. volunteer: the next round, 8 s before the press to 8 s after it is confirmed ----
    r = await until(page, (x) => x.round > r0 && !x.saved && x.enabled && x.label === "I'll do it" && x.left <= 174, 300_000, 'the next round', 200);
    const r1 = r.round;
    c = await startClip('volunteer');
    await sleep(6600);
    const btn = await pointAt('.dock .act', 800, -60, 4);
    await sleep(500);
    r = await read();
    if (!r.enabled || r.label !== "I'll do it") throw new Error('cannot volunteer: ' + JSON.stringify(r).slice(0, 300));
    c.facts = { round: r1, costShownAtClick: r.cost, secondsLeftAtClick: r.left, balanceBefore: r.balance, itBefore: r.it };
    mark('pointer down on "I\'ll do it"', { target: btn, costShown: r.cost });
    await press();
    await moveTo(btn.x + 300, btn.y - 60, 640);
    let sending = false;
    const vBegin = Date.now();
    for (;;) {
      r = await read();
      if (!sending && r.label === 'Sending') {
        sending = true;
        mark('"Sending" appears', { costFrozenAt: r.cost });
      }
      if (r.stamp && r.youIt) break;
      if (/OK/.test(r.note) && !r.pending) throw new Error('volunteer was refused: ' + r.note);
      if (Date.now() - vBegin > 90_000) throw new Error('volunteer did not confirm');
      await sleep(40);
    }
    mark('confirmed: your face takes the middle seat', { stamp: r.stamp });
    c.facts.confirmSeconds = Number(((Date.now() - vBegin) / 1000).toFixed(1));
    await sleep(1500);
    r = await read();
    c.facts.balanceAfter = r.balance;
    c.facts.burned = r.myBurned || null;
    c.facts.volunteerTx = (r.tx[0] ?? '').split('/').pop() || null;
    mark('explorer link shown', { link: r.tx[0] ?? null });
    await sleep(6800);
    await stopClip();
    facts.volunteer = c.facts;

    // ---- 4. unsaved: the following round, bots paused: its last 15 s through 10 s after it closes ----
    r = await until(page, (x) => x.round === r1 + 1 && x.left <= 17, 400_000, 'the end of the following round', 250);
    if (r.saved) throw new Error(`round ${r.round} was saved by someone: nothing to film`);
    const r2 = r.round;
    c = await startClip('unsaved');
    c.facts = { round: r2, it: 'you', balanceBefore: r.balance, paidToItBefore: r.myPaid || '0.00', secondsLeftAtStart: r.left };
    await moveTo(1150, 300, 700);
    let closed = false;
    const uBegin = Date.now();
    for (;;) {
      r = await read();
      if (!closed && r.round > r2) {
        closed = true;
        mark('round closes: the clock starts the next round', { nextRound: r.round });
      }
      if (r.paid) break;
      if (Date.now() - uBegin > 90_000) throw new Error('the round did not close unsaved');
      await sleep(30);
    }
    if (!closed) mark('round closes', { nextRound: r.round });
    const payers = r.faces - 1;
    mark('coins start: red flash, every face pays you', { payers });
    const coinsMs = 600 + Math.max(0, payers - 1) * 30;
    await sleep(coinsMs);
    mark('coins end');
    await sleep(900);
    r = await read();
    c.facts.collected = (r.note.match(/you collected ([\d,.]+)/) ?? [])[1] ?? r.delta.replace(/^\+/, '');
    await sleep(Math.max(0, 10_000 - coinsMs - 900));
    r = await read();
    c.facts.balanceAfter = r.balance;
    c.facts.paidToItAfter = r.myPaid || null;
    await stopClip();
    facts.unsaved = c.facts;
    bots('start');
    botsStopped = false;

    // ---- 5. locked: the chain bar's lock line, then rule five ----
    c = await startClip('locked');
    await sleep(1200);
    await page.evaluate(() => { const el = document.querySelector('.chainbar'); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 430, behavior: 'smooth' }); });
    await sleep(900);
    let p = await pointAt('.lock', 760, 30, 0);
    mark('pointer rests on the lock line', { target: p, text: (await page.evaluate(() => document.querySelector('.lock')?.textContent?.replace(/\s+/g, ' ').trim())) ?? '' });
    await sleep(4000);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(800);
    p = await pointAt('#tab-rules', 700);
    mark('pointer down on the Rules tab', { target: p });
    await press();
    await page.waitForSelector('.rules');
    await sleep(500);
    await page.evaluate(() => { const el = document.querySelector('.rule:nth-child(5)'); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 300, behavior: 'smooth' }); });
    await sleep(900);
    p = await pointAt('.rule:nth-child(5)', 700, -260, 0);
    mark('pointer rests on rule 5', { target: p, text: (await page.evaluate(() => document.querySelector('.rule:nth-child(5)')?.textContent?.replace(/\s+/g, ' ').trim())) ?? '' });
    await sleep(4200);
    c.facts = { contract: facts.contract };
    await stopClip();

    await page.evaluate(() => window.scrollTo(0, 0));
    await s.context.storageState({ path: STATE });
  } catch (e) {
    s.problems.push(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: join(WORK, 'session-failure.png') }).catch(() => {});
    await stopClip();
  } finally {
    if (botsStopped) {
      try {
        bots('start');
      } catch (e) {
        s.problems.push(`COULD NOT RESTART THE BOTS: ${e.message}`);
      }
    }
    await s.close();
  }
  await savePart('session', s.clips, { facts, problems: s.problems });
  log('problems:', s.problems.length ? s.problems.join(' | ') : 'none');
}

/* --------------------------------------------------------------------------- phone */

async function phone() {
  const state = STATE;
  if (!existsSync(state)) throw new Error('run `session` first: the phone clip signs in with its storage');
  const s = await open({ width: 390, height: 844, scale: 3, storageState: state });
  const { page } = s;
  await page.goto(BASE + '#play', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.acct', { state: 'attached', timeout: 60_000 });
  await page.waitForSelector('.stage .face:not(.face--ghost)', { timeout: 60_000 });
  await page.waitForSelector('.figs__item dd');
  await s.showCursor(false);
  log('page', JSON.stringify(await s.size()));
  await until(page, (x) => !x.saved && x.left <= 165 && x.left >= 40, 400_000, 'an open round');
  const c = await s.startClip('phone');
  let r = await page.evaluate(READ);
  c.facts = { round: r.round, signedIn: true, button: `${r.label} ${r.cost}`.trim(), secondsLeftAtStart: r.left, line: r.line, viewport: await s.size() };
  await sleep(10_000);
  await s.stopClip();
  await s.close();
  await savePart('phone', s.clips, { problems: s.problems });
}

/* ----------------------------------------------------------------------------- lab */

async function lab() {
  const s = await open({ width: 1280, height: 720, scale: 2 });
  const { page, moveTo, pointAt, press, startClip, stopClip, mark } = s;
  await page.goto(BASE + '#play', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stage .face:not(.face--ghost)', { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(s.mouse.x, s.mouse.y);
  const done = () => page.waitForFunction(() => /Done/.test(document.querySelector('.controls__status')?.textContent ?? ''), null, { timeout: 60_000 });
  const crowd = () => page.evaluate(() => Number((document.querySelector('#by-n')?.getAttribute('aria-valuetext') ?? '0').replace(/\D/g, '')));
  const reading = () => page.evaluate(() => document.querySelector('.reading')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  // Where on the slider's track a crowd size sits: its positions run 0..max along the track.
  const trackX = async (position) => {
    const g = await page.evaluate(() => { const el = document.querySelector('#by-n'); const b = el.getBoundingClientRect(); return { left: b.left, width: b.width, y: b.top + b.height / 2, max: Number(el.max), min: Number(el.min) }; });
    const thumb = 16;
    return { x: g.left + thumb / 2 + ((position - g.min) / (g.max - g.min)) * (g.width - thumb), y: g.y };
  };
  const positionFor = async (target) => page.evaluate((want) => {
    // The page itself knows the scale: walk the slider's positions and find the one that shows this size.
    const el = document.querySelector('#by-n');
    return { value: Number(el.value), want };
  }, target);
  void positionFor;

  // Set the crowd to about 10 before filming, with the keys (not on film).
  await pointAt('#tab-lab', 600);
  await press();
  await page.waitForSelector('#by-n');
  await done();
  await page.locator('#by-n').focus();
  for (let i = 0; i < 200 && (await crowd()) > 10; i++) {
    await page.keyboard.press('ArrowLeft');
    await sleep(25);
  }
  await done();
  const startValue = await page.evaluate(() => Number(document.querySelector('#by-n').value));
  // Find the slider position that means about 60 holders, then put the slider back.
  let endValue = startValue;
  for (let i = 0; i < 200 && (await crowd()) < 60; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(20);
  }
  endValue = await page.evaluate(() => Number(document.querySelector('#by-n').value));
  for (let i = 0; i < 200 && (await crowd()) > 10; i++) {
    await page.keyboard.press('ArrowLeft');
    await sleep(20);
  }
  await done();
  await page.evaluate(() => { document.activeElement?.blur(); const el = document.querySelector('.lab__grid'); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 24 }); });
  await moveTo(900, 560, 500);
  await sleep(600);

  const c = await startClip('lab');
  c.facts = { experiment: 'Bystander effect', from: { holders: await crowd(), reading: await reading() } };
  await sleep(1800);
  const a = await trackX(startValue);
  await moveTo(a.x, a.y, 800);
  await sleep(250);
  mark('pointer down on the crowd-size slider', { target: { x: Math.round(a.x), y: Math.round(a.y) }, holders: await crowd() });
  await page.mouse.down();
  const b = await trackX(endValue);
  const steps = 150;
  const dragBegin = Date.now();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = a.x + (b.x - a.x) * e;
    await page.mouse.move(x, a.y);
    s.mouse.x = Math.round(x);
    s.mouse.y = Math.round(a.y);
    const due = dragBegin + (6000 * i) / steps;
    if (due > Date.now()) await sleep(due - Date.now());
    if (i % 30 === 0) mark('dragging', { holders: await crowd() });
  }
  await page.mouse.up();
  mark('pointer up', { holders: await crowd() });
  await done();
  mark('result for the final size', { reading: await reading() });
  c.facts.to = { holders: await crowd(), reading: await reading() };
  await moveTo(b.x + 60, b.y + 90, 500);
  await sleep(3000);
  // The fourth experiment.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(700);
  const tab = await pointAt('.subtabs__tab:nth-child(4)', 760);
  mark('pointer down on "Forward-looking"', { target: tab });
  await press();
  await page.waitForFunction(() => /rounds go unsaved at most/.test(document.querySelector('.reading')?.textContent ?? ''), null, { timeout: 60_000 });
  mark('forward-looking result shown', { reading: await reading() });
  c.facts.forwardLooking = {
    reading: await reading(),
    rows: await page.evaluate(() => [...document.querySelectorAll('.table tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()))),
  };
  await moveTo(tab.x + 420, tab.y + 250, 700);
  await sleep(3200);
  await stopClip();
  await s.close();
  await savePart('lab', s.clips, { problems: s.problems });
}

/* ---------------------------------------------------------------------------- demo */

async function demo() {
  const parts = [];
  const problems = [];
  // demo-seat-swap: the usual crowd, 10-second rounds; someone else volunteers and takes the middle seat.
  {
    const s = await open({ width: 1280, height: 720, scale: 2 });
    const { page } = s;
    await page.goto(BASE + '?mode=demo#play', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stage .face');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.seg__opt', { hasText: '10 s' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await s.showCursor(false);
    await sleep(1500);
    // Start right after a round opens, so a volunteer arrives within the clip.
    let r = await until(page, (x) => !x.saved && x.left >= 8, 60_000, 'a fresh demo round', 60);
    const c = await s.startClip('demo-seat-swap');
    c.facts = { mode: 'Demo (simulated crowd, not testnet)', roundSeconds: 10, itBefore: r.it, round: r.round };
    const begin = Date.now();
    let swapped = 0;
    let it = r.it;
    while (Date.now() - begin < 9000 || (swapped === 0 && Date.now() - begin < 40_000)) {
      r = await page.evaluate(READ);
      if (r.it !== it && r.it) {
        swapped += 1;
        it = r.it;
        s.mark('someone else volunteers: seat swap begins', { it: r.it, line: r.line });
      }
      await sleep(40);
    }
    await sleep(1200);
    c.facts.itAfter = it;
    await s.stopClip();
    await s.close();
    parts.push(...s.clips);
    problems.push(...s.problems);
  }
  // demo-unsaved and demo-asleep: a crowd that never volunteers; you are It and collect, round after round, until the game sleeps.
  {
    const s = await open({ width: 1280, height: 720, scale: 2 });
    const { page } = s;
    await page.goto(BASE + '?mode=demo&crowd=quiet#play', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stage .face');
    await page.evaluate(() => document.fonts.ready);
    await s.showCursor(false);
    await page.locator('.dock .act').click(); // claim
    await until(page, (x) => x.label === "I'll do it" && x.enabled, 30_000, 'the demo claim', 60);
    await page.locator('.dock .act').click(); // volunteer once: someone has to be It for the others to pay
    await page.waitForSelector('.stamp');
    await page.mouse.move(1180, 300);
    let r = await until(page, (x) => x.youIt && !x.saved && x.left <= 4, 60_000, 'the end of the first unsaved round', 40);
    let c = await s.startClip('demo-unsaved');
    c.facts = { mode: 'Demo (simulated crowd, not testnet)', roundSeconds: 10, it: 'you', balanceBefore: r.balance, round: r.round };
    r = await until(page, (x) => x.paid, 30_000, 'the demo round to close unsaved', 25);
    s.mark('coins start: red flash, every face pays you', { payers: r.faces - 1 });
    await sleep(600 + (r.faces - 2) * 30);
    s.mark('coins end');
    await sleep(3600);
    r = await page.evaluate(READ);
    c.facts.balanceAfter = r.balance;
    await s.stopClip();
    await page.waitForSelector('.stage--asleep', { timeout: 150_000 });
    await sleep(4200); // let the last coins and the flash finish
    c = await s.startClip('demo-asleep');
    r = await page.evaluate(READ);
    c.facts = { mode: 'Demo (simulated crowd, not testnet)', roundSeconds: 10, state: 'asleep: eight unsaved rounds in a row, nothing more is charged until someone volunteers', line: r.line, round: r.round };
    await sleep(8500);
    await s.stopClip();
    await s.close();
    parts.push(...s.clips);
    problems.push(...s.problems);
  }
  await savePart('demo', parts, { problems });
}

/* ------------------------------------------------------------------------ timeline */

async function timeline() {
  const parts = readdirSync(WORK).filter((f) => /^part-.*\.json$/.test(f)).sort();
  const out = { fps: FPS, note: 'Frame numbers count from the first frame of each clip. Pointer positions are in page (CSS) pixels: multiply by the clip width / page width for video pixels.', clips: [], facts: {}, problems: [] };
  for (const f of parts) {
    const p = JSON.parse(await readFile(join(WORK, f), 'utf8'));
    for (const c of p.clips) out.clips.push({ ...c, recordedAt: p.recordedAt, part: p.part });
    if (p.facts) Object.assign(out.facts, p.facts);
    for (const x of p.problems ?? []) out.problems.push(`${p.part}: ${x}`);
  }
  if (existsSync(join(WORK, 'chain-facts.json'))) out.facts.chain = JSON.parse(await readFile(join(WORK, 'chain-facts.json'), 'utf8'));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'timeline.json'), JSON.stringify(out, null, 1));
  for (const c of out.clips) console.log(`${c.file.padEnd(22)} ${String(c.seconds).padStart(7)} s  ${String(c.frames).padStart(5)} frames  ${c.width}x${c.height}  ${c.events.length} events`);
}

async function test() {
  const s = await open({ width: 1280, height: 720, scale: 2 });
  const { page } = s;
  await page.goto(BASE + '?mode=demo#play', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stage .face');
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(s.mouse.x, s.mouse.y);
  await sleep(1200);
  const c = await s.startClip('test');
  await sleep(1000);
  const at = await s.pointAt('.dock .act', 760);
  s.mark('pointer down', { target: at });
  await s.press();
  await s.moveTo(at.x + 250, at.y - 46, 620);
  await sleep(2500);
  await s.stopClip();
  c.facts = { size: await s.size() };
  await s.close();
  await savePart('test', s.clips);
}

if (mode === 'session') await session();
else if (mode === 'test') await test();
else if (mode === 'phone') await phone();
else if (mode === 'lab') await lab();
else if (mode === 'demo') await demo();
else if (mode === 'timeline') await timeline();
else throw new Error(`unknown mode: ${mode}`);
