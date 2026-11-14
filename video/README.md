# Not It: the demo film

A motion-design film of one real session of Not It on NEAR testnet, built with
[Remotion](https://www.remotion.dev) 4.0.543. Output: 1920×1080, 30 fps, H.264 yuv420p, no audio.

This is a standalone npm project; it is not part of the repository's workspaces.

## Render

```sh
cd video
npm install                 # Remotion fetches its own headless browser on the first render; ffmpeg is bundled
npm run footage             # footage/timeline.json -> src/footage.ts; converts footage/*.mp4 into public/footage/ (about 90 s)
export TMPDIR="$PWD/.cache/tmp" && mkdir -p "$TMPDIR"   # only needed where /tmp is small
npx remotion render Film out/demo.mp4 --concurrency=5
npx remotion still Film out/demo-poster.png --frame=46   # the poster: the first sentence landed, every face looking away
```

`npx remotion studio` opens the timeline for scrubbing (the footage steps frame by frame there:
the film owns time, see `Plate`).

## Footage

The plates are not committed here if they are too large for the repository; they are six clean
2560×1440 recordings in `footage/` with `footage/timeline.json` (event frames, facts) and
`footage/README.txt` (what each clip is). `watch`, `signup`, `volunteer`, `unsaved` and `locked` are
one real session on the locked contract `notit-play.testnet`; `lab` is the site's in-browser
simulation and is tagged as such in the film.

`npm run footage` does not copy the plates as they are: they are untagged H.264 written with the BT.601
matrix, which an HD decoder reads as BT.709 (the yellow goes orange next to the motion graphics). The
script re-encodes them as tagged BT.709 (CRF 10) into `public/footage/`, which is what the film reads;
`Plate` adds a 1.2 % gain so the plate's yellow lands on the app's `#ffd60a`.

Swapping footage is a config change: replace the files and `timeline.json`, run `npm run footage`.
Every number the film prints comes from `src/footage.ts` (`FACTS`), which that script generates.
Positions on the page (where the button, the clock and the faces are) are in `src/poi.ts`, in CSS px
of the 1280×720 page, measured from stills.

## Layout

| Path | What |
|---|---|
| `SHOTLIST.md` | The film shot by shot, with timings |
| `footage/` | The plates, `timeline.json`, `README.txt` (recorded by the session script, not by this project) |
| `src/Film.tsx` | The four sections in order |
| `src/scenes/ColdOpen.tsx` | 0–5.5 s: the pitch as kinetic type, ending in the app's formation for a match cut |
| `src/scenes/Real.tsx` | The real session: watch, sign up, volunteer, the unsaved round |
| `src/scenes/Why.tsx` | No admin: the lock line, rule 5 and `"keys": []`; the lab |
| `src/scenes/EndCard.tsx` | The ring, the wordmark, the URL |
| `src/components/` | `Face`, `ClockRing`, `Coin`, `Plate` (footage behind a virtual camera), `Shot` (plate + time map + camera keys), `Callout`, `Numeral`, `Panel`, `Tag`, `Kinetic` |
| `src/anim.ts` | Easing, springs, keyframe tracks and the time remap used for speed ramps |
| `src/tokens.ts` | The app's colours, line weight and type, scaled to 1920 |
| `scripts/gen-footage.mjs` | `timeline.json` → `src/footage.ts` |
| `scripts/sheet.mjs` | Contact sheet of any composition, for review (`FFMPEG=/path/to/full/ffmpeg node scripts/sheet.mjs Film 0-1500:60`) |

Rules the code follows: every frame is a pure function of `useCurrentFrame()`; no CSS animations or
timers; footage through `<OffthreadVideo>` frozen on an explicit source frame, so speed ramps are
exact and the speed badge shows the true rate; the font is the app's own Bricolage Grotesque variable
file (weight and width axes), loaded with `@remotion/fonts`.
