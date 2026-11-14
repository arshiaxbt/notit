"""Soundtrack for the demo film: narration plus a ticking-clock sound bed.

Everything is generated locally and deterministically:
  - narration: Kokoro (open neural text-to-speech, Apache-2.0), voice set below;
  - sound bed and effects: synthesised here with numpy (no samples, no licensed music).

Times are seconds in the 51.07 s film and follow video/SHOTLIST.md and
video/footage/timeline.json (30 fps: press = frame 292, 542; confirmed = 603;
round closes = 897; coins = 916-945; "No admin." = 1066; end card = 1342).

Usage (see video/README.md):
  python make_audio.py <kokoro-model.onnx> <voices.bin> <out.wav>
"""

import sys

import numpy as np
import soundfile as sf

SR = 48_000
LENGTH = 51.07
VOICE = "af_heart"

# (start, latest end, text)
LINES = [
    (0.70, 5.55, "Somebody has to do it. If nobody does, everybody pays the last person who did."),
    (5.80, 9.05, "This is Not It: a meme coin on the Near Protocol testnet."),
    (9.25, 14.90, "One click, and you're playing. The key left in your browser can only volunteer."),
    (15.40, 23.80, "Every round, a cost falls. The first to volunteer burns it, and becomes It."),
    (24.70, 28.60, "Next round: nobody volunteers."),
    (31.70, 35.35, "So everybody pays fifteen percent, to It."),
    (35.75, 41.35, "No admin. The contract has no keys, so nobody can change the rules."),
    (41.75, 44.75, "And the game theory is simulated in the open."),
    (45.90, 50.00, "Not It. Would you volunteer?"),
]

T_PRESS_1, T_KEY, T_PRESS_2, T_CONFIRM = 292 / 30, 392 / 30, 542 / 30, 603 / 30
T_CLOSE, T_COINS_A, T_COINS_B = 897 / 30, 916 / 30, 945 / 30
T_STAMP, T_END = 1066 / 30, 1342 / 30

rng = np.random.default_rng(7)
N = int(LENGTH * SR)


def place(buf: np.ndarray, t: float, sig: np.ndarray, gain: float = 1.0) -> None:
    i = int(t * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += gain * sig[: j - i]


def env(dur: float, decay: float, attack: float = 0.002) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    return np.minimum(1.0, t / attack) * np.exp(-t / decay)


def tone(freq: float, dur: float, decay: float, harmonics=((1, 1.0),)) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    wave = sum(a * np.sin(2 * np.pi * freq * h * t) for h, a in harmonics)
    return wave * env(dur, decay)


def tick(high: bool) -> np.ndarray:
    """A dry clock tick: a short pitched knock plus a sliver of noise."""
    f = 1900.0 if high else 1450.0
    knock = tone(f, 0.05, 0.008, ((1, 1.0), (2.4, 0.35)))
    noise = rng.standard_normal(len(knock)) * env(0.05, 0.002) * 0.5
    return knock + noise


def pluck(freq: float, dur: float = 0.9) -> np.ndarray:
    """Marimba-like: fundamental with a quickly dying fourth harmonic."""
    body = tone(freq, dur, 0.22, ((1, 1.0), (2, 0.18)))
    bar = tone(freq * 4, dur, 0.035) * 0.35
    return body + bar


def bass(freq: float) -> np.ndarray:
    return tone(freq, 1.2, 0.38, ((1, 1.0), (2, 0.25)))


def thud(dur: float = 0.9, f0: float = 95.0, f1: float = 42.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.08)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * env(dur, 0.22, 0.003)


def click() -> np.ndarray:
    blip = tone(2600.0, 0.03, 0.006)
    noise = rng.standard_normal(len(blip)) * env(0.03, 0.0015)
    return blip * 0.7 + noise * 0.6


def note(name: str) -> float:
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave - 4)) / 12)


def sound_bed() -> np.ndarray:
    bed = np.zeros(N)
    beat = 0.5  # 120 bpm: the clock

    # The clock: tick, tock, from the first frame until the round runs out.
    t, i = 0.0, 0
    while t < T_CLOSE - 0.05:
        rush = t >= T_CLOSE - 3.0  # the last three seconds are shown in real time
        level = 0.16 if not rush else 0.16 + 0.14 * (t - (T_CLOSE - 3.0)) / 3.0
        place(bed, t, tick(i % 2 == 0), level)
        t += beat / 2 if rush else beat
        i += 1
    # After the unsaved round the next one starts: the clock comes back, quieter.
    t, i = 32.0, 0
    while t < 49.0:
        fade = 1.0 if t < T_END + 1.5 else max(0.0, 1 - (t - T_END - 1.5) / 3.0)
        place(bed, t, tick(i % 2 == 0), 0.11 * fade)
        t += beat
        i += 1

    # A sparse groove under it: bass every two seconds, three plucks answering.
    chords = [("A2", ("A3", "C4", "E4")), ("A2", ("C4", "E4", "A4")), ("F2", ("A3", "C4", "F4")), ("G2", ("B3", "D4", "G4"))]
    bar, k = 2.0, 0
    t = 2.0
    while t < 48.0:
        root, triad = chords[k % 4]
        quiet = T_CLOSE - 0.1 <= t < 32.0  # hold the silence after the round closes
        if not quiet:
            last = t >= T_END
            place(bed, t, bass(note(root if not last else "A2")), 0.20)
            for step, name in zip((0.75, 1.25, 1.5), triad if not last else ("A3", "C#4", "E4")):
                if t + step < T_CLOSE - 0.1 or t + step >= 32.0:
                    place(bed, t + step, pluck(note(name)), 0.085)
        t += bar
        k += 1

    # Effects, on the film's own events.
    place(bed, T_PRESS_1, click(), 0.30)
    place(bed, T_KEY, pluck(note("E5"), 0.5), 0.12)  # the key flips to "volunteer only"
    place(bed, T_KEY + 0.09, pluck(note("A5"), 0.5), 0.12)
    place(bed, T_PRESS_2, click(), 0.30)
    for j, name in enumerate(("A4", "C#5", "E5")):  # confirmed: you are It
        place(bed, T_CONFIRM + 0.10 * j, pluck(note(name), 1.2), 0.15)
    place(bed, T_CLOSE, thud(1.2), 0.55)  # the round runs out
    coins = np.linspace(T_COINS_A, T_COINS_B, 9)
    scale = ("A4", "C5", "D5", "E5", "G5", "A5", "C6", "D6", "E6")
    for tc, name in zip(coins, scale):  # coins travel to It
        place(bed, tc, tone(note(name), 0.18, 0.04, ((1, 1.0), (3, 0.2))), 0.13)
    place(bed, T_STAMP + 0.05, thud(0.5, 140.0, 60.0), 0.40)  # "No admin." stamp
    place(bed, T_STAMP + 0.05, rng.standard_normal(int(0.06 * SR)) * env(0.06, 0.012), 0.10)
    for j, name in enumerate(("A3", "E4", "A4", "C#5", "E5")):  # end card resolves
        place(bed, T_END + 0.35 + 0.07 * j, pluck(note(name), 2.2), 0.14)
    return bed


def resample(x: np.ndarray, sr_in: int) -> np.ndarray:
    if sr_in == SR:
        return x
    n_out = int(round(len(x) * SR / sr_in))
    spec = np.fft.rfft(x)
    out = np.zeros(n_out // 2 + 1, dtype=complex)
    m = min(len(spec), len(out))
    out[:m] = spec[:m]
    return np.fft.irfft(out, n_out) * (n_out / len(x))


def trim(x: np.ndarray, threshold: float = 0.01) -> np.ndarray:
    loud = np.flatnonzero(np.abs(x) > threshold * np.max(np.abs(x)))
    a = max(0, loud[0] - int(0.01 * SR))
    b = min(len(x), loud[-1] + int(0.06 * SR))
    return x[a:b]


def narration(model: str, voices: str) -> tuple[np.ndarray, list[str]]:
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(model, voices)
    track = np.zeros(N)
    report = []
    for start, latest_end, text in LINES:
        slot = latest_end - start
        speed = 1.0
        for _ in range(3):
            samples, sr = kokoro.create(text, voice=VOICE, speed=speed, lang="en-us")
            line = trim(resample(np.asarray(samples, dtype=np.float64), sr))
            dur = len(line) / SR
            if dur <= slot:
                break
            speed = min(1.3, speed * dur / slot * 1.03)
        line = line / (np.sqrt(np.mean(line**2)) + 1e-9) * 0.11  # same loudness for every line
        fade = int(0.01 * SR)
        line[:fade] *= np.linspace(0, 1, fade)
        line[-fade:] *= np.linspace(1, 0, fade)
        place(track, start, line)
        report.append(f"{start:6.2f}-{start + dur:6.2f} (slot to {latest_end:5.2f}, speed {speed:.2f}) {text}")
    return track, report


def follower(x: np.ndarray, attack: float = 0.03, release: float = 0.35) -> np.ndarray:
    """0..1 envelope of the narration, for ducking the bed under it."""
    win = int(0.02 * SR)
    rms = np.sqrt(np.convolve(x**2, np.ones(win) / win, mode="same"))
    target = np.clip(rms / 0.03, 0, 1)
    out = np.zeros_like(target)
    a, r = np.exp(-1 / (attack * SR)), np.exp(-1 / (release * SR))
    level = 0.0
    for i, v in enumerate(target):
        coeff = a if v > level else r
        level = coeff * level + (1 - coeff) * v
        out[i] = level
    return out


def main() -> None:
    model, voices, out_path = sys.argv[1:4]
    voice, report = narration(model, voices)
    bed = sound_bed()
    duck = 1.0 - 0.6 * follower(voice)
    mix = voice + 0.5 * bed * duck
    # Fades at the head and tail, then a gentle limiter.
    head, tail = int(0.05 * SR), int(1.2 * SR)
    mix[:head] *= np.linspace(0, 1, head)
    mix[-tail:] *= np.linspace(1, 0, tail) ** 2
    mix = np.tanh(mix * 1.1) / 1.1  # only the loudest peaks are rounded off
    mix *= 0.7 / np.max(np.abs(mix))
    stereo = np.stack([mix, mix], axis=1)
    sf.write(out_path, stereo, SR, subtype="PCM_16")
    sf.write(out_path.replace(".wav", "-voice.wav"), voice, SR, subtype="PCM_16")
    print("\n".join(report))
    print(f"wrote {out_path}: {len(mix) / SR:.2f} s, peak {np.max(np.abs(mix)):.2f}")


if __name__ == "__main__":
    main()
