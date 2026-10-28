// Render the promo to MP4 (or a few still frames) with Electron's offscreen renderer.
//
//   PROMO='{"lang":"zh"}' electron promo/render.cjs                 → promo/out/nekoquotya-zh.mp4
//   PROMO='{"lang":"en","audio":"music.mp3","audioStart":53.081}' electron promo/render.cjs
//   PROMO='{"lang":"zh","stills":[0.5,4.2,8]}' electron promo/render.cjs   → promo/out/still-zh-*.png
//
// Options come in an env var because Electron misreads some extra command-line arguments.
// Frames are piped straight into ffmpeg (imageio-ffmpeg's binary unless FFMPEG is set).

const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const opts = { lang: 'en', fps: 30, ...JSON.parse(process.env.PROMO || '{}') };
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  return execFileSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // Windows caps a real window at the screen size and offscreen paints lag behind, so the
  // frame size comes from DevTools device emulation and frames from Page.captureScreenshot,
  // which renders the current DOM before returning.
  const win = new BrowserWindow({
    width: 540,
    height: 960,
    // A hidden window produces no frames, so show it, but off the visible screen
    x: -4000,
    y: 0,
    show: true,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'index.html'), { query: { lang: opts.lang } });
  // Electron remembers zoom per origin; make sure an old setting can't shrink the frame
  win.webContents.setZoomFactor(1);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
  await win.webContents.executeJavaScript('window.promoReady.then(() => true)');

  const frameAt = async (t, format = 'jpeg') => {
    await win.webContents.executeJavaScript(`renderAt(${t}); true`);
    const { data } = await dbg.sendCommand('Page.captureScreenshot', { format, quality: 95, fromSurface: true });
    return Buffer.from(data, 'base64');
  };

  try {
    if (opts.stills) {
      for (const t of opts.stills) {
        fs.writeFileSync(path.join(outDir, `still-${opts.lang}-${String(t).replace('.', '_')}.png`), await frameAt(t, 'png'));
      }
    } else {
      const duration = await win.webContents.executeJavaScript('PROMO.DURATION');
      const frames = Math.round(duration * opts.fps);
      const out = path.join(outDir, `nekoquotya-${opts.lang}.mp4`);
      const args = ['-y', '-f', 'image2pipe', '-framerate', String(opts.fps), '-c:v', 'mjpeg', '-i', '-'];
      if (opts.audio) {
        // audioStart: where the 8-bar window starts in the track (see analyze_music.py);
        // a tiny fade-in avoids a click, and the music fades out under the final logo
        const fadeOut = opts.fadeOut ?? 0.8;
        args.push('-ss', String(opts.audioStart ?? 0), '-t', String(duration), '-i', opts.audio);
        args.push('-map', '0:v', '-map', '1:a', '-af', `afade=t=in:d=0.02,afade=t=out:st=${duration - fadeOut}:d=${fadeOut}`);
        args.push('-c:a', 'aac', '-b:a', '256k', '-shortest');
      }
      // JPEG frames are full-range; convert to the standard TV range most players and apps expect
      args.push('-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', out);
      const ff = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let log = '';
      ff.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
      const done = new Promise((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(log)))));
      for (let i = 0; i < frames; i++) {
        const jpeg = await frameAt(i / opts.fps);
        if (!ff.stdin.write(jpeg)) await new Promise((r) => ff.stdin.once('drain', r));
        if (i % 60 === 0) console.log(`frame ${i}/${frames}`);
      }
      ff.stdin.end();
      await done;
      console.log(`wrote ${out}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
