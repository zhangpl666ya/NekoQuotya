# Promo video

A 17-second vertical (1080×1920) promo, in Chinese and English, built as an HTML page
whose every frame is computed from a time `t`, then rendered frame by frame.

| File | What it is |
|---|---|
| `final/nekoquotya-zh.mp4`, `final/nekoquotya-en.mp4` | The published videos (music position fine-tuned by hand after rendering) |
| `index.html`, `promo.css`, `promo.js` | The scenes and the timeline (`promo.js`: 128 BPM grid, all text for both languages) |
| `render.cjs` | Renders `index.html` to MP4 or stills with Electron + ffmpeg |
| `analyze_music.py` | Finds a track's tempo, beats and drop, and the window to cut from it |

The site uses smaller copies of the final videos in `site/assets/video/`.

## Rendering

`assets/` (high-res cutouts of the character art, ~65 MB) and `out/` are not committed.
Re-create the art at ~1000 px tall with the same cutout as the app's art before rendering.

```bash
# preview one frame in a browser: open promo/index.html?lang=zh&t=6.5
PROMO='{"lang":"zh","stills":[1,6.5,9.5]}' node_modules/electron/dist/electron.exe promo/render.cjs
PROMO='{"lang":"zh","audio":"music.mp3","audioStart":51.206,"fadeOut":1.5}' node_modules/electron/dist/electron.exe promo/render.cjs
python promo/analyze_music.py music.mp3 plot.png
```

Options are passed in the `PROMO` environment variable because Electron misreads some
extra command-line arguments. ffmpeg comes from `imageio-ffmpeg` (or set `FFMPEG`).

## Music

The timeline is 9 bars at 128 BPM: question (1) · girls pop in (1) · Claude's quota
climbs over the music's build-up (3) · drop: GPT / Gemini / DeepSeek (1) · features (2) ·
logo (1). Pick an audio start so the track's drop lands on bar 6 (9.375 s).
