// NekoQuotya promo video timeline. window.renderAt(t) draws the frame at t seconds;
// nothing else moves on its own, so frames are reproducible.
// Music grid: 128 BPM → one beat = 0.46875 s, one bar = 1.875 s, 9 bars = 16.875 s.
//   bar 1      0.000  the question
//   bar 2      1.875  four girls pop in, logo
//   bars 3–5   3.750  quota climbs over the music's 3-bar build-up; "quota gone" lands in
//                     the short silence after the snare roll
//   bar 6      9.375  DROP: GPT / Gemini / DeepSeek cuts
//   bars 7–8  11.250  features: desktop, tray panel, heatmap
//   bar 9     15.000  icon and name
// The music window is chosen so its drop lands on bar 6 (promo/analyze_music.py).
// ?lang=zh|en picks the text. ?t=4.2 shows one frame (for previewing in a browser).

(() => {
  'use strict';

  const BEAT = 60 / 128;
  const BAR = BEAT * 4;
  /** Claude's quota scene spans the music's whole build-up */
  const CLAUDE_BARS = 3;
  /** The silence between the snare roll and the drop, measured in the track */
  const PRE_DROP_GAP = 0.69;
  const DURATION = BAR * (6 + CLAUDE_BARS);
  const params = new URLSearchParams(location.search);
  const lang = params.get('lang') === 'zh' ? 'zh' : 'en';
  document.body.classList.add(lang);

  // ------------------------------------------------------------------ text

  const TEXT = {
    zh: {
      q1: '你的 AI 额度', q2: '还剩多少？', scr: '5 小时',
      tagline: '额度用完前，她先慌',
      session: '5 小时 · 已用', moods: { ENERGETIC: '元气', FOCUSED: '专注', SWEATING: '冒汗', PANICKED: '慌张', EXHAUSTED: '累瘫' },
      claude: { ENERGETIC: '今天也很乐意帮你～', FOCUSED: '让我仔细想一想……', SWEATING: '诚实地说，额度有点紧了', PANICKED: '非常抱歉，快用完了！', EXHAUSTED: '对不起……撑不住了……' },
      gone: '额度耗尽！', knew: '她比你先知道。',
      cuts: [
        { name: 'GPT', tool: 'Codex', line: '当然可以！✨' },
        { name: 'Gemini', tool: 'Gemini', line: '喵～冲冲冲！' },
        { name: 'DeepSeek', tool: 'DeepSeek', line: '<think> 让我想想…' },
      ],
      oneEach: '一个工具，一个形象',
      f: [
        { title: '桌面常驻', sub: '戳一下 · 额度一目了然' },
        { title: '托盘面板', sub: '每个工具的用量，一屏看完' },
        { title: '活跃热力图', sub: '哪天爆肝，哪天躺平' },
      ],
      deskBubble: 'token 来啦～ ✨', deskL1: '5 小时', deskL2: '每周',
      periods: ['今日', '本周', '本月', '总计'], tokens: 'tokens',
      names: { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek' },
      trayMoods: { claude: '专注', gpt: '元气', deepseek: '冒汗' },
      hmTitle: '活跃度', hmMeta: '活跃 126 天', trTitle: '趋势', trMeta: '峰值 28.1M',
    },
    en: {
      q1: 'Your AI quota…', q2: 'how much is left?', scr: '5-hour',
      tagline: 'She panics before you run out',
      session: '5-hour · used', moods: { ENERGETIC: 'Energetic', FOCUSED: 'Focused', SWEATING: 'Sweating', PANICKED: 'Panicked', EXHAUSTED: 'Exhausted' },
      claude: { ENERGETIC: 'Happy to help today!', FOCUSED: 'Let me think carefully…', SWEATING: "To be honest, quota's low", PANICKED: "Sorry, we're nearly out!", EXHAUSTED: "I can't go on… sorry…" },
      gone: 'QUOTA GONE!', knew: 'She knew before you did.',
      cuts: [
        { name: 'GPT', tool: 'Codex CLI', line: 'Certainly! ✨' },
        { name: 'Gemini', tool: 'Gemini CLI', line: "Nyaa~ Let's go!" },
        { name: 'DeepSeek', tool: 'DeepSeek', line: '<think> let me think…' },
      ],
      oneEach: 'One tool, one girl',
      f: [
        { title: 'On your desktop', sub: 'Tap her · see your quota' },
        { title: 'Tray panel', sub: 'Every tool, every period, one screen' },
        { title: 'Activity heatmap', sub: 'Your busy days, at a glance' },
      ],
      deskBubble: 'Tokens incoming~ ✨', deskL1: '5-hour', deskL2: 'Weekly',
      periods: ['Today', 'Week', 'Month', 'Total'], tokens: 'tokens',
      names: { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek' },
      trayMoods: { claude: 'Focused', gpt: 'Energetic', deepseek: 'Sweating' },
      hmTitle: 'ACTIVITY', hmMeta: '126 active days', trTitle: 'TREND', trMeta: 'Peak 28.1M',
    },
  }[lang];

  // ------------------------------------------------------------------ helpers

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
  const easeInCubic = (k) => k * k * k;
  const easeOutBack = (k, s = 1.9) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
  /** Deterministic wobble in [-1, 1] */
  const noise = (t, seed = 0) => Math.sin(t * 91.7 + seed * 12.9) * 0.6 + Math.sin(t * 57.3 + seed * 3.1) * 0.4;
  /** A squash-and-stretch landing that settles over `len` seconds */
  const land = (k) => (k >= 1 ? 1 : 1 + Math.sin(k * Math.PI * 2.5) * 0.12 * (1 - k));
  /** 1 on a beat, decaying to 0 before the next one */
  const beatPulse = (t, from = 0) => (t < from ? 0 : Math.pow(1 - (((t - from) % BEAT) / BEAT), 4));
  const set = (el, styles) => Object.assign(el.style, styles);
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

  // ------------------------------------------------------------------ static text

  $('q1').textContent = TEXT.q1;
  $('q2').textContent = TEXT.q2;
  $('scrLabel').textContent = TEXT.scr;
  $('tag2').textContent = TEXT.tagline;
  $('hud3Label').textContent = TEXT.session;
  $('gone').textContent = TEXT.gone;
  $('knew').textContent = TEXT.knew;
  $('oneEach').textContent = TEXT.oneEach;
  $('deskBubble').textContent = TEXT.deskBubble;
  $('deskL1').textContent = TEXT.deskL1;
  $('deskL2').textContent = TEXT.deskL2;
  $('hmTitle').textContent = TEXT.hmTitle;
  $('hmMeta').textContent = TEXT.hmMeta;
  $('trTitle').textContent = TEXT.trTitle;
  $('trMeta').textContent = TEXT.trMeta;

  const CODE = [
    '<span class="c">// refactoring auth…</span>',
    '<span class="k">export async function</span>',
    '  <span class="f">refreshSession</span>(user) {',
    '  <span class="k">const</span> t = <span class="k">await</span> <span class="f">issue</span>(user);',
    '  <span class="k">return</span> { t, ttl: <span class="s">3600</span> };',
    '}',
  ];

  // Tray cards
  const TRAY = [
    { id: 'claude', c: '#D97757', vals: [12.4, 58.1, 203.6, 488.2], q: 62 },
    { id: 'gpt', c: '#1F1F1F', vals: [3.2, 21.7, 64.9, 131.0], q: 8 },
    { id: 'deepseek', c: '#4D6BFE', vals: [1.4, 6.8, 18.3, 42.5], q: 71 },
  ];
  $('tray').innerHTML =
    '<div class="tray-head"><span>NekoQuotya</span></div><div class="tray-body">' +
    TRAY.map(
      (card) => `<div class="tcard" id="tc-${card.id}" style="--c:${card.c}">
        <img src="assets/${card.id}-card.webp" />
        <div class="tcard-head"><b>${TEXT.names[card.id]}</b><span>${TEXT.trayMoods[card.id]}</span></div>
        <div class="ttabs">${TEXT.periods.map((p, i) => `<span data-i="${i}">${p}</span>`).join('')}</div>
        <div class="tbig"><span class="num">0</span><small>${TEXT.tokens}</small></div>
        <div class="track"><div class="fill"></div></div>
      </div>`
    ).join('') +
    '</div>';

  // Heatmap: 26 weeks × 7 days of seeded levels, denser toward the recent weeks
  const levels = [];
  for (let i = 0; i < 26 * 7; i++) {
    const r = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const v = Math.abs(r) + (i / 182) * 0.35;
    levels.push(v < 0.35 ? 0 : v < 0.55 ? 1 : v < 0.75 ? 2 : v < 0.95 ? 3 : 4);
  }
  const SHADES = ['#ebe9f0', '#f0c4b3', '#e8a387', '#df8763', '#d97757'];
  $('heatmap').innerHTML = levels.map(() => '<i></i>').join('');
  const cells = [...$('heatmap').children];
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(0.15 + Math.abs(Math.sin(i * 1.7) * 0.45) + (i > 32 ? 0.25 : 0));
  bars[38] = 1;
  $('trend').innerHTML = bars.map((_, i) => `<i class="${i === 38 ? 'peak' : ''}"></i>`).join('');
  const trendBars = [...$('trend').children];

  // Sparkle particles for the pastel scenes
  const SPARKS = [];
  for (let i = 0; i < 18; i++) {
    const el = document.createElement('span');
    el.textContent = i % 3 === 0 ? '♡' : i % 2 ? '✦' : '✧';
    el.style.color = ['#ff8fb1', '#b9a7ff', '#ffc4a3', '#ffe066'][i % 4];
    $('sparks').appendChild(el);
    SPARKS.push({ el, x: (i * 263) % 1000 + 20, y: (i * 547) % 1800 + 40, phase: i * 0.37, size: 40 + (i % 4) * 16 });
  }

  // ------------------------------------------------------------------ scenes

  const scenes = [];
  const scene = (id, from, to, draw) => scenes.push({ el: $(id), from, to, draw });

  // S1: the question
  scene('s1', 0, BAR, (t) => {
    const slam = (el, at) => {
      const k = prog(t, at, at + 0.16);
      const after = t - at - 0.16;
      const shake = after > 0 ? Math.max(0, 1 - after / 0.35) * 18 : 0;
      set(el, {
        opacity: String(k > 0 ? 1 : 0),
        transform: `translate(${noise(t, 1) * shake}px, ${noise(t, 2) * shake}px) scale(${lerp(2.8, 1, easeInCubic(k))})`,
      });
    };
    slam($('q1'), 0.12);
    slam($('q2'), 0.12 + BEAT * 2);
    const scr = $('scramble');
    const on = t > 0.5;
    set(scr, { opacity: String(on ? 1 : 0), transform: `translateY(${on ? 0 : 40}px)` });
    $('scrValue').textContent =
      t < 1.15 ? `${String(Math.floor(Math.abs(noise(Math.floor(t * 16), 3)) * 99)).padStart(2, '0')}%` : t < 1.55 ? '87%' : '??%';
    $('q2').style.transform += ` rotate(${Math.sin(t * 9) * 2}deg)`;
  });

  // S2: girls pop in on half beats, logo lands on beat 3
  const POPS = [
    ['pop-claude', 0, -8],
    ['pop-gpt', BEAT * 0.5, 8],
    ['pop-gemini', BEAT, -6],
    ['pop-deepseek', BEAT * 1.5, 6],
  ];
  scene('s2', BAR, BAR * 2, (t, local) => {
    for (const [id, at, rot] of POPS) {
      const k = prog(local, at, at + 0.28);
      const bob = Math.sin((local - at) * 6) * 6;
      set($(id), { opacity: String(k > 0 ? 1 : 0), transform: `translateY(${bob}px) scale(${k > 0 ? easeOutBack(k) : 0}) rotate(${rot * (1 - k)}deg)` });
    }
    const lk = prog(local, BEAT * 2 - 0.12, BEAT * 2);
    const settle = prog(local, BEAT * 2, BEAT * 2 + 0.45);
    set($('logo2'), {
      opacity: String(lk > 0 ? 1 : 0),
      transform: `translateY(${lerp(-900, 0, easeInCubic(lk))}px) scaleY(${land(settle)}) scaleX(${2 - land(settle)})`,
    });
    const tk = prog(local, BEAT * 3, BEAT * 3 + 0.2);
    set($('tag2'), { opacity: String(tk), transform: `translate(-50%, ${lerp(30, 0, easeOutCubic(tk))}px)` });
    // whip zoom into the next scene
    const out = prog(local, BAR - 0.14, BAR);
    $('s2').style.transform = `scale(${1 + easeInCubic(out) * 0.35})`;
    $('s2').style.filter = out > 0 ? `blur(${out * 12}px)` : '';
  });

  // S3: quota climbs from 0 to 100 (accelerating), moods follow the app's thresholds
  const S3 = BAR * 2;
  const S4 = S3 + BAR * CLAUDE_BARS;
  const S3_FULL = S4 - PRE_DROP_GAP; // quota hits 100% as the roll stops
  const MOODS = [['ENERGETIC', 0], ['FOCUSED', 30], ['SWEATING', 60], ['PANICKED', 80], ['EXHAUSTED', 95]];
  // Accelerating climb; the exponent keeps every mood on screen for at least ~0.45 s
  const CLIMB = 1.35;
  const pctAt = (t) => 100 * Math.pow(prog(t, S3, S3_FULL), CLIMB);
  const crossAt = (p) => S3 + Math.pow(p / 100, 1 / CLIMB) * (S3_FULL - S3);
  const BG3 = { ENERGETIC: '#fff1ea', FOCUSED: '#ffe9dd', SWEATING: '#ffdccc', PANICKED: '#ffc7c0', EXHAUSTED: '#f5b5b5' };
  scene('s3', S3, S4, (t) => {
    const pct = pctAt(t);
    let mood = 'ENERGETIC';
    let since = S3;
    for (const [m, p] of MOODS) if (pct >= p) { mood = m; since = p === 0 ? S3 : crossAt(p); }
    const k = t - since;
    const girl = $('girl3');
    const src = `assets/claude-${mood.toLowerCase()}.webp`;
    if (!girl.src.endsWith(src)) girl.src = src;
    const shakeAmp = mood === 'PANICKED' ? 16 : mood === 'SWEATING' ? 5 : 0;
    const bump = k < 0.18 ? 1 + Math.sin((k / 0.18) * Math.PI) * 0.07 : 1;
    set(girl, { transform: `translate(calc(-50% + ${noise(t, 4) * shakeAmp}px), ${noise(t, 5) * shakeAmp * 0.5}px) scale(${bump}, ${2 - bump})` });
    $('s3').style.background = BG3[mood];
    set($('alarm'), { opacity: String(mood === 'PANICKED' ? 0.35 + beatPulse(t, S3) * 0.55 : mood === 'EXHAUSTED' ? 0.5 : 0) });

    $('bigPct').textContent = `${Math.round(pct)}%`;
    set($('bigPct'), { transform: `scale(${1 + beatPulse(t, S3) * 0.08 + (pct / 100) * 0.15}) translate(${noise(t, 6) * shakeAmp * 0.6}px, 0)` });
    $('fill3').style.width = `${pct}%`;
    $('moodChip').textContent = TEXT.moods[mood];

    const bubble = $('bubble3');
    bubble.textContent = TEXT.claude[mood];
    const bk = prog(k, 0, 0.14);
    set(bubble, { transform: `translateX(-50%) scale(${easeOutBack(bk)})`, opacity: String(bk > 0 ? 1 : 0) });

    // "QUOTA GONE!" slams at 100%, then a short silence (dim) before the drop
    const gk = prog(t, S3_FULL, S3_FULL + 0.14);
    const gAfter = t - S3_FULL - 0.14;
    const gShake = gAfter > 0 ? Math.max(0, 1 - gAfter / 0.3) * 22 : 0;
    set($('gone'), {
      opacity: String(gk > 0 ? 1 : 0),
      transform: `translate(${noise(t, 7) * gShake}px, ${noise(t, 8) * gShake}px) scale(${lerp(3, 1, easeInCubic(gk))}) rotate(-4deg)`,
    });
    set($('dim3'), { opacity: String(prog(t, S4 - 0.3, S4 - 0.05) * 0.55) });
    const kk = prog(t, S3_FULL + 0.18, S3_FULL + 0.32);
    set($('knew'), { opacity: String(kk), transform: `translateY(${lerp(24, 0, easeOutCubic(kk))}px)` });
  });

  // S4: the drop. Three cuts, 0.625 s each, each girl in her brand colours
  const CUTS = [
    { id: 'gpt', bg: 'radial-gradient(circle at 50% 55%, #4a4a52 0%, #141416 70%)' },
    { id: 'gemini', bg: 'linear-gradient(160deg, #4285F4 0%, #9B72CB 50%, #D96570 100%)' },
    { id: 'deepseek', bg: 'radial-gradient(circle at 50% 55%, #6f8bff 0%, #2a3fd6 75%)' },
  ];
  const CUT = (BAR * 1) / 3;
  scene('s4', S4, S4 + BAR, (t, local) => {
    const i = Math.min(2, Math.floor(local / CUT));
    const k = local - i * CUT;
    const cut = CUTS[i];
    const text = TEXT.cuts[i];
    $('s4').style.background = cut.bg;
    const girl = $('girl4');
    const src = `assets/${cut.id}-energetic.webp`;
    if (!girl.src.endsWith(src)) girl.src = src;
    const zk = easeOutCubic(prog(k, 0, 0.16));
    set(girl, { transform: `translateX(-50%) scale(${lerp(1.45, 1, zk) + k * 0.06}) rotate(${(i - 1) * 3 * (1 - zk)}deg)` });
    $('rays4').style.transform = `rotate(${t * 40}deg) scale(${1 + beatPulse(t, S4) * 0.06})`;
    const ok = prog(local, 0.05, 0.2);
    set($('oneEach'), { opacity: String(ok), transform: `translate(-50%, ${lerp(30, 0, easeOutCubic(ok))}px)` });
    $('name4').textContent = text.name;
    $('tool4').textContent = text.tool;
    const nk = prog(k, 0.04, 0.16);
    set($('name4'), { opacity: String(nk > 0 ? 1 : 0), transform: `scale(${lerp(1.8, 1, easeInCubic(nk))})` });
    set($('tool4'), { opacity: String(prog(k, 0.1, 0.2)) });
    const bubble = $('bubble4');
    bubble.textContent = text.line;
    const bk = prog(k, 0.16, 0.28);
    set(bubble, { opacity: String(bk > 0 ? 1 : 0), transform: `translateX(-50%) scale(${easeOutBack(bk)})` });
  });

  // S5: features, 1.25 s each with a whip between them
  const S5 = S4 + BAR;
  const FEAT = (BAR * 2) / 3;
  scene('s5', S5, S5 + BAR * 2, (t, local) => {
    const i = Math.min(2, Math.floor(local / FEAT));
    const k = local - i * FEAT;
    ['f1', 'f2', 'f3'].forEach((id, j) => {
      const inK = easeOutCubic(prog(k, 0, 0.2));
      set($(id), { display: j === i ? 'flex' : 'none', transform: `translateX(${lerp(1080, 0, inK)}px)` });
    });
    $('capTitle').textContent = TEXT.f[i].title;
    $('capSub').textContent = TEXT.f[i].sub;
    const ck = prog(k, 0.02, 0.16);
    set($('capTitle'), { transform: `scale(${easeOutBack(ck)})` });
    set($('whip'), { opacity: String(i > 0 ? Math.max(0, 1 - k / 0.14) : 0) });

    if (i === 0) {
      // desktop: code types, she drops in, quota card pops out
      const lines = Math.floor(prog(k, 0, 0.6) * CODE.length);
      $('code5').innerHTML = CODE.slice(0, lines).join('\n');
      const dk = prog(k, 0.12, 0.42);
      set($('deskPet'), { transform: `translateY(${lerp(-900, 0, easeOutBack(dk, 1.2))}px)`, opacity: String(dk > 0 ? 1 : 0) });
      const hk = prog(k, 0.5, 0.68);
      set($('deskHud'), { transform: `scale(${easeOutBack(hk)})`, opacity: String(hk > 0 ? 1 : 0) });
      const vk = easeOutCubic(prog(k, 0.6, 1.0));
      $('deskV1').textContent = `${Math.round(62 * vk)}%`;
      $('deskV2').textContent = `${Math.round(24 * vk)}%`;
      $('deskF1').style.width = `${62 * vk}%`;
      $('deskF2').style.width = `${24 * vk}%`;
      set($('deskBubble'), { opacity: String(prog(k, 0.7, 0.8)) });
    } else if (i === 1) {
      // tray: cards slide in; the period tab advances every half beat
      const period = Math.min(3, Math.floor(prog(k, 0.35, 1.2) * 4));
      TRAY.forEach((card, j) => {
        const el = $(`tc-${card.id}`);
        const ck2 = easeOutBack(prog(k, 0.08 + j * 0.08, 0.3 + j * 0.08), 1.2);
        set(el, { transform: `translateX(${lerp(700, 0, ck2)}px)`, opacity: String(ck2 > 0 ? 1 : 0) });
        el.querySelectorAll('.ttabs span').forEach((s) => s.classList.toggle('on', Number(s.dataset.i) === period));
        const vk = easeOutCubic(prog(k, 0.2 + period * 0.22, 0.4 + period * 0.22));
        const from = period === 0 ? 0 : card.vals[period - 1];
        el.querySelector('.num').textContent = `${lerp(from, card.vals[period], vk).toFixed(1)}M`;
        el.querySelector('.fill').style.width = `${card.q * easeOutCubic(prog(k, 0.25, 0.7))}%`;
      });
    } else {
      // heatmap fills column by column, trend bars grow
      cells.forEach((cell, n) => {
        const col = Math.floor(n / 7);
        const ck3 = prog(k, 0.05 + col * 0.022, 0.15 + col * 0.022);
        cell.style.background = ck3 > 0 ? SHADES[levels[n]] : '#ebe9f0';
        cell.style.transform = `scale(${ck3 > 0 ? easeOutBack(ck3) : 0.6})`;
      });
      trendBars.forEach((bar, n) => {
        const bk = easeOutCubic(prog(k, 0.3 + n * 0.012, 0.6 + n * 0.012));
        bar.style.height = `${bars[n] * 100 * bk}%`;
      });
    }
  });

  // S6: the icon pops in on the last bar, the name follows; then everything holds still
  const S6 = S5 + BAR * 2;
  scene('s6', S6, DURATION + 1, (t, local) => {
    const ik = prog(local, 0, 0.3);
    const nk = prog(local, 0.18, 0.45);
    const logo = $('logo6');
    set(logo.querySelector('img'), { opacity: String(ik > 0 ? 1 : 0), transform: `scale(${easeOutBack(ik, 1.4)})` });
    set(logo.querySelector('span'), { opacity: String(nk), transform: `translateY(${lerp(40, 0, easeOutCubic(nk))}px)` });
  });

  // ------------------------------------------------------------------ frame

  function renderAt(t) {
    for (const s of scenes) {
      const on = t >= s.from && t < s.to;
      s.el.style.display = on ? 'block' : 'none';
      if (on) s.draw(t, t - s.from);
    }
    // White flash on the big cuts: into bar 2, the drop, and the finale
    const flashes = [[BAR, 0.22], [S4, 0.18], [S4 + CUT, 0.1], [S4 + CUT * 2, 0.1], [S6, 0.25]];
    let flash = 0;
    for (const [at, len] of flashes) if (t >= at && t < at + len) flash = Math.max(flash, 1 - (t - at) / len);
    if (t > BAR - 0.18 && t < BAR) flash = Math.max(flash, prog(t, BAR - 0.18, BAR));
    $('flash').style.opacity = String(flash);
    // Sparkles drift in the pastel scenes
    const pastel = (t >= BAR && t < S3) || t >= S5;
    SPARKS.forEach((s) => {
      const tw = (Math.sin(t * 4 + s.phase * 7) + 1) / 2;
      set(s.el, {
        display: pastel ? 'block' : 'none',
        left: `${s.x + Math.sin(t + s.phase) * 20}px`,
        top: `${s.y - ((t * 40 + s.phase * 100) % 200)}px`,
        fontSize: `${s.size}px`,
        opacity: String(0.25 + tw * 0.75),
        transform: `scale(${0.7 + tw * 0.5}) rotate(${t * 60 + s.phase * 90}deg)`,
      });
    });
  }

  window.PROMO = { DURATION, BEAT, BAR };
  window.renderAt = renderAt;
  /** Resolves when fonts and every image are ready, so the first frame is complete */
  // Web fonts only load glyphs that are on screen; text in hidden scenes would render in
  // a fallback font, so load every character the video uses up front.
  const allText = JSON.stringify(TEXT) + '0123456789%.MK';
  window.promoReady = Promise.all([
    document.fonts.load('400 100px "ZCOOL KuaiLe"', allText),
    document.fonts.load('700 100px "Fredoka"', allText),
    document.fonts.load('600 100px "Fredoka"', allText),
    document.fonts.ready,
    ...[...document.images].map((img) => img.decode().catch(() => {})),
    ...['claude', 'gpt', 'gemini', 'deepseek'].flatMap((p) =>
      ['energetic', 'focused', 'sweating', 'panicked', 'exhausted'].map((m) => {
        const img = new Image();
        img.src = `assets/${p}-${m}.webp`;
        return img.decode().catch(() => {});
      })
    ),
  ]);

  const preview = params.get('t');
  if (preview !== null) renderAt(Number(preview));
})();
