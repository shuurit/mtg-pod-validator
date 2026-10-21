"""Procedural lo-fi fantasy score for the closing-ceremony video.

    python music.py out/music.wav

Reads season-data.js for the trophy counts so the bell cues land on the same
seconds index.html reveals each emblem (keep the scene timings below in sync
with index.html). 72 BPM, D minor: plucked lute arpeggios, warm pad, round
bass, a soft lo-fi beat, and an ocarina melody for intro, champion and outro.
No vinyl crackle or noise beds -- the only noise is inside drum/pluck hits.
"""
import json, re, sys
from pathlib import Path
import numpy as np
from scipy.signal import butter, lfilter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 44100
HERE = Path(__file__).parent
rng = np.random.default_rng(7)

# ---------- cue timings (mirror index.html) ----------
data = json.loads(re.sub(r"^window\.SEASON = |;\s*$", "", (HERE / "season-data.js").read_text(encoding="utf-8")))
PODIUM = {"season-champion", "second-place", "third-place"}
CATS = ["tempo", "table", "combat", "playstyle", "survival", "standings"]
counts = [sum(1 for a in data["awards"] if a["category"] == c and a["id"] not in PODIUM) for c in CATS]
counts = [n for n in counts if n]
t = 37.5
reveals, phase_starts = [], []
for n in counts:
    phase_starts.append(t)
    reveals += [t + 0.8 + i * 0.5 + 0.15 for i in range(n)]
    t += 3.6 + n * 1.0
HOARD = t
haul = {}
for a in data["awards"]:
    haul[a["winner"]] = haul.get(a["winner"], 0) + 1
hoard_hits = [HOARD + 1.0 + r * 0.15 + i * 0.16 for r, n in enumerate(sorted(haul.values(), reverse=True)) for i in range(n)]
POD = HOARD + 7
CHAMP = POD + 8.0 + 0.5
OUTRO = POD + 16
END = OUTRO + 6.5
SCENES = [7.5, 15, 26, *phase_starts, HOARD, POD, OUTRO]

N = int(END * SR) + SR * 3
L = np.zeros(N); Rch = np.zeros(N)

def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    Rch[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def env(n, a, r):
    e = np.ones(n); na, nr = int(a * SR), int(r * SR)
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e
def lp(x, fc, order=2): return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)

# ---------- instruments ----------
def pluck(m, dur=1.8, bright=0.5):
    """Karplus-Strong lute/harp pluck via a single lfilter."""
    f = hz(m); P = int(SR / f); n = int(dur * SR)
    x = np.zeros(n); x[:P] = lp(rng.uniform(-1, 1, P), 1500 + 5000 * bright)
    a = np.zeros(P + 2); a[0] = 1; a[P] = a[P + 1] = -0.4985
    y = lfilter([1], a, x)
    return lp(y, 3800) * env(n, 0.002, 0.3) * 0.9

def bell(m, dur=2.6):
    n = int(dur * SR); tt = np.arange(n) / SR; f = hz(m)
    s = sum(g * np.sin(2 * np.pi * f * k * tt) * np.exp(-tt * d) for k, g, d in [(1, 1, 2.2), (2.76, .35, 4), (5.4, .15, 7), (2, .25, 3)])
    return s * env(n, 0.003, 0.2) * 0.5

def pad(ms, dur):
    n = int(dur * SR); tt = np.arange(n) / SR; s = np.zeros(n)
    for m in ms:
        for det in (-0.07, 0.0, 0.07):
            f = hz(m + det)
            s += sum(np.sin(2 * np.pi * f * k * tt + k) / k ** 1.6 for k in (1, 2, 3, 4))
    s = lp(s / (len(ms) * 3), 1400) * (1 + 0.15 * np.sin(2 * np.pi * 0.2 * tt))
    return s * env(n, 1.2, 1.4) * 0.22

def bass(m, dur):
    n = int(dur * SR); tt = np.arange(n) / SR
    s = np.sin(2 * np.pi * hz(m) * tt) + 0.25 * np.sin(4 * np.pi * hz(m) * tt)
    return np.tanh(1.5 * s) * env(n, 0.02, 0.25) * np.exp(-tt * 0.6) * 0.45

def ocarina(m, dur):
    n = int(dur * SR); tt = np.arange(n) / SR
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.2 * tt) * np.clip(tt / 0.4, 0, 1)
    ph = 2 * np.pi * np.cumsum(hz(m) * vib) / SR
    s = np.sin(ph) + 0.12 * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)
    return s * env(n, 0.06, min(0.25, dur * 0.4)) * 0.28

def kick():
    n = int(0.45 * SR); tt = np.arange(n) / SR
    f = 50 + 70 * np.exp(-tt * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.9

def snare():
    n = int(0.3 * SR); tt = np.arange(n) / SR
    body = np.sin(2 * np.pi * 185 * tt) * np.exp(-tt * 25)
    sn = lp(rng.uniform(-1, 1, n), 2600) * np.exp(-tt * 22)
    return (0.6 * body + 0.5 * sn) * 0.55

def tick():
    n = int(0.06 * SR); tt = np.arange(n) / SR
    return np.sin(2 * np.pi * 3200 * tt) * np.exp(-tt * 90) * 0.12

# ---------- harmony: i - VI - VII - v (Dm Bb C Am), 72 BPM ----------
BEAT = 60 / 72; BAR = 4 * BEAT
CHORDS = [(50, [62, 65, 69, 72]), (46, [62, 65, 70, 74]), (48, [64, 67, 72, 76]), (45, [64, 67, 69, 72])]
ARP = [0, 1, 2, 3, 2, 1, 3, 2]  # chord-tone order per swung 8th
KICK, SNARE = [0, 2.5], [1, 3]

def in_groove(x): return (7.5 <= x < POD) or (CHAMP <= x < OUTRO)

bar = 0; tb = 0.0
while tb < END:
    root, tones = CHORDS[bar % 4]
    add(pad([root + 12] + tones, BAR + 1.4), tb, 1.0)
    add(bass(root - 12, BAR * 0.95), tb, 0.42 if tb >= 7.5 else 0.25)
    for k, idx in enumerate(ARP):
        off = (k // 2) * BEAT + (BEAT * 0.58 if k % 2 else 0)  # swing
        m = tones[idx] + (12 if (bar % 2 and k >= 4) else 0)
        add(pluck(m, bright=0.35 + 0.1 * (k % 2)), tb + off, 0.55, pan=-0.35 if k % 2 else 0.35)
    for b in range(4):
        x = tb + b * BEAT
        if in_groove(x):
            for k in KICK:
                if b == int(k): add(kick(), tb + k * BEAT, 0.85)
            if b in SNARE: add(snare(), x, 0.6)
            add(tick(), x + BEAT * 0.58, 1.0, pan=0.2)
    bar += 1; tb += BAR

# ---------- melody: intro, champion, outro ----------
MOTIF = [(74, 1), (77, .5), (79, .5), (81, 1.5), (84, .5), (81, 1), (79, 1), (77, .5), (76, .5), (74, 2)]
def melody(at, transpose=0, gain=1.0):
    x = at
    for m, beats in MOTIF:
        add(ocarina(m + transpose, beats * BEAT * 0.98), x, gain, pan=0.1); x += beats * BEAT
melody(1.4); melody(CHAMP + 0.4, 0, 1.1); melody(OUTRO + 0.6, 0, 0.9)

# ---------- accents ----------
SCALE = [62, 64, 65, 67, 69, 70, 72, 74, 76, 77, 79, 81]
for s in SCENES:  # harp glissando into each scene
    for i, m in enumerate(SCALE[::2] + [86]):
        add(pluck(m + 12, 1.4, 0.7), s - 0.45 + i * 0.05, 0.28, pan=-0.5 + i * 0.15)
for i, r in enumerate(reveals):  # bell as each emblem lands
    add(bell([74, 77, 81, 79, 76, 72][i % 6] + 12), r, 0.35, pan=(i % 3 - 1) * 0.3)
for i, h in enumerate(hoard_hits):
    add(bell(86 + [0, 3, 5, 7, 10][i % 5]), h, 0.12, pan=(i % 5 - 2) * 0.2)
for k, at in enumerate([POD + 1.4, POD + 4.8]):  # bronze, silver
    for m in (62, 69, 74): add(bell(m + 12 + 2 * k, 3.5), at, 0.3)
for m in (50, 57, 62, 66, 69, 74, 78):  # champion: D major bloom
    add(bell(m + 12, 5), CHAMP, 0.22)
add(pad([50, 57, 62, 66, 69, 74], 6), CHAMP - 0.3, 1.6)
add(bass(38, 3), CHAMP, 0.6)

# ---------- lo-fi master: reverb, gentle tape wobble, warmth ----------
def reverb(x, secs=2.4, mix=0.22):
    n = int(secs * SR); tt = np.arange(n) / SR
    ir = lp(rng.standard_normal(n), 5000) * np.exp(-tt * 3.2)
    ir /= np.sqrt(np.sum(ir ** 2))
    return x + mix * fftconvolve(x, ir)[: len(x)]

out = []
idx = np.arange(N)
wob = 0.0016 * SR * (1 + np.sin(2 * np.pi * 0.5 * idx / SR))  # +-1.6 ms wow
for ch in (L, Rch):
    y = reverb(ch)
    y = np.interp(idx - wob, idx, y)
    y = lp(y, 7000)
    y = sosfilt(butter(2, 45, "high", fs=SR, output="sos"), y)
    out.append(np.tanh(1.2 * y))
mix = np.stack(out, 1)[: int(END * SR)]
fade = int(3.0 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
fi = int(0.6 * SR); mix[:fi] *= np.linspace(0, 1, fi)[:, None]
mix *= 0.89 / np.max(np.abs(mix))
dst = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "out" / "music.wav")
dst.parent.mkdir(exist_ok=True)
wavfile.write(dst, SR, (mix * 32767).astype(np.int16))
print(f"{dst}: {END:.1f}s, {len(reveals)} emblem cues, champion at {CHAMP:.1f}s")
