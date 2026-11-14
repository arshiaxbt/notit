// Contact sheet of a composition: node scripts/sheet.mjs <Composition> <frames> [cols] [scale]
//   frames: "0,10,20" or "0-150:10" (from-to:step)
// Renders each frame once from a single bundle and tiles them into stills/<Composition>-sheet.jpg.
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition, openBrowser} from '@remotion/renderer';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.TMPDIR = path.join(root, '.cache/tmp');
mkdirSync(process.env.TMPDIR, {recursive: true});
const [comp, spec, colsArg, scaleArg, nameArg] = process.argv.slice(2);
const frames = spec.includes(':')
  ? (() => {
      const [range, step] = spec.split(':');
      const [a, b] = range.split('-').map(Number);
      const out = [];
      for (let f = a; f <= b; f += Number(step)) out.push(f);
      return out;
    })()
  : spec.split(',').map(Number);
const cols = Number(colsArg ?? 4);
const scale = Number(scaleArg ?? 0.3334);
const dir = path.join(root, 'stills', `${comp}-frames`);
rmSync(dir, {recursive: true, force: true});
mkdirSync(dir, {recursive: true});

const serveUrl = await bundle({entryPoint: path.join(root, 'src/index.ts'), publicDir: path.join(root, 'public'), outDir: path.join(root, '.cache/bundle-sheet')});
const browser = await openBrowser('chrome');
const composition = await selectComposition({serveUrl, id: comp, puppeteerInstance: browser});
let i = 0;
const run = async () => {
  while (i < frames.length) {
    const k = i++;
    const f = Math.min(frames[k], composition.durationInFrames - 1);
    await renderStill({composition, serveUrl, frame: f, output: path.join(dir, `${String(k).padStart(3, '0')}.jpg`), imageFormat: 'jpeg', jpegQuality: 88, scale, puppeteerInstance: browser, overwrite: true});
  }
};
await Promise.all([run(), run(), run()]);
await browser.close({silent: true});
const rows = Math.ceil(frames.length / cols);
const out = path.join(root, 'stills', `${nameArg ?? comp + '-sheet'}.jpg`);
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'; // needs a full ffmpeg build (the one Remotion bundles has no tile filter)
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, '%03d.jpg'), '-vf', `tile=${cols}x${rows}:padding=6:color=0x888888`, '-frames:v', '1', '-q:v', '3', out], {cwd: root, stdio: 'inherit'});
console.log(out, 'frames:', frames.join(' '));
