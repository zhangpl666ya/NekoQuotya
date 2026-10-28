"""Find tempo, beats and the drop in a music track, and suggest the 8-bar window for the promo.

usage: python promo/analyze_music.py <track.mp3> [plot.png]

The promo is 8 bars long and the drop lands on bar 5, so the window starts 4 bars
before the drop. Prints JSON with bpm, the first beat, the drop time and the window.
"""
import json
import sys

import librosa
import numpy as np

path = sys.argv[1]
y, sr = librosa.load(path, sr=22050, mono=True)
duration = len(y) / sr

tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='time', start_bpm=128)
bpm = float(np.atleast_1d(tempo)[0])
beat = 60 / bpm

# Loudness per beat, plus low-end energy (a drop brings the bass and the kick)
hop = 512
rms = librosa.feature.rms(y=y, hop_length=hop)[0]
spec = np.abs(librosa.stft(y, hop_length=hop))
freqs = librosa.fft_frequencies(sr=sr)
low = spec[freqs < 150].mean(axis=0)
times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)

def mean_between(series, a, b):
    m = (times >= a) & (times < b)
    return float(series[m].mean()) if m.any() else 0.0

# The drop: the beat where energy over the next bar most exceeds the bar before it,
# weighting the bass. Candidates must leave room for the 4 bars before and after.
bar = beat * 4
best = None
for b in beats:
    if b - 4 * bar < 0 or b + 4 * bar > duration:
        continue
    after = mean_between(rms, b, b + bar) + mean_between(low, b, b + bar) / (low.max() + 1e-9) * rms.max()
    before = mean_between(rms, b - bar, b) + mean_between(low, b - bar, b) / (low.max() + 1e-9) * rms.max()
    jump = after - before
    if best is None or jump > best[1]:
        best = (float(b), jump)

drop = best[0]
start = drop - 4 * bar
result = {
    'duration': round(duration, 2),
    'bpm': round(bpm, 2),
    'beat': round(beat, 4),
    'firstBeat': round(float(beats[0]), 3),
    'beats': len(beats),
    'drop': round(drop, 3),
    'windowStart': round(start, 3),
    'windowEnd': round(start + 8 * bar, 3),
}
print(json.dumps(result, indent=2))

# Top 5 drop candidates for a sanity check
cands = []
for b in beats:
    if b - bar < 0 or b + bar > duration:
        continue
    cands.append((mean_between(rms, b, b + bar) - mean_between(rms, b - bar, b), float(b)))
print('strongest energy jumps (t, jump):', [(round(t, 2), round(j, 4)) for j, t in sorted(cands, reverse=True)[:5]])

if len(sys.argv) > 2:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(16, 4))
    ax.plot(times, rms / rms.max(), label='loudness', lw=0.8)
    ax.plot(times, low / low.max(), label='bass', lw=0.8, alpha=0.7)
    for b in beats:
        ax.axvline(b, color='#ddd', lw=0.4, zorder=0)
    ax.axvspan(start, start + 8 * bar, color='#ffb3c7', alpha=0.3, label='promo window')
    ax.axvline(drop, color='red', lw=1.5, label='drop')
    ax.set_xlim(0, duration)
    ax.legend(loc='upper right')
    ax.set_xlabel('seconds')
    fig.tight_layout()
    fig.savefig(sys.argv[2], dpi=90)
