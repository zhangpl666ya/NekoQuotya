// NekoQuotya landing page: language toggle, reveal-on-scroll, the desktop demo,
// the scroll-driven mood demo and the interactive tray panel. No dependencies.

(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

  // ------------------------------------------------------------------ i18n

  const STRINGS = {
    en: {
      'nav.mood': 'Mood', 'nav.girls': 'Meet the girls', 'nav.panel': 'Panel', 'nav.agents': 'For agents',
      'hero.eyebrow': 'A desktop pet for AI developers',
      'hero.tagline': 'Your AI coding quota, guarded by a cat-girl.',
      'hero.sub': "She sits on your desktop, watches your Claude Code, Codex, Gemini CLI and DeepSeek usage, and her mood follows your quota. Panicking before you hit the limit, so you don't have to.",
      'hero.meta': 'Free · v1.0.1 · Windows 10/11 · data never leaves your PC',
      'cta.download': 'Download for Windows', 'cta.star': '★ Star on GitHub', 'cta.source': 'View source',
      'desk.kicker': 'Lives on your desktop',
      'desk.title': 'Code as usual. She keeps an eye on the meter.',
      'desk.text': 'Tap her and a tiny quota card pops out beside her: your 5-hour and weekly limits, right where you work. No dashboards, no browser tabs.',
      'desk.bubble': 'Tokens incoming~ ✨',
      'quota.session': '5-hour', 'quota.weekly': 'Weekly', 'quota.budget': 'Daily budget',
      'mood.kicker': 'Scroll to burn tokens',
      'mood.title': 'Her mood <em>is</em> your quota.',
      'mood.ENERGETIC': 'Energetic', 'mood.FOCUSED': 'Focused', 'mood.SWEATING': 'Sweating',
      'mood.PANICKED': 'Panicked', 'mood.EXHAUSTED': 'Exhausted', 'mood.SLEEPING': 'Sleeping', 'mood.idle': 'idle',
      'mood.note': 'Subscription tools follow the quota %. API-billed tools follow a daily token budget you set.',
      'resets': 'resets 18:00',
      'girls.kicker': 'Meet the girls', 'girls.title': 'One character per AI tool',
      'girls.text': 'Pick who lives on your desktop. Each one watches her own tool, wears its colours, and reacts to its usage.',
      'girls.claude.name': 'Claude-chan', 'girls.gpt.name': 'GPT-chan', 'girls.gemini.name': 'Gemini-chan', 'girls.deepseek.name': 'DeepSeek-chan',
      'tag.quota': 'follows quota', 'tag.budget': 'follows budget',
      'panel.kicker': 'One click in the tray', 'panel.title': 'Every tool, every period, at a glance',
      'panel.l1': 'Today, this week, this month and all-time tokens per tool',
      'panel.l2': 'Subscription quota bars with reset times',
      'panel.l3': 'Click a card for an activity heatmap, a 60-day trend and per-session details',
      'panel.l4': 'Drag cards to reorder them',
      'panel.demo': 'Interactive demo. Try the tabs. Numbers are examples.',
      'panel.refresh': 'Refresh', 'panel.settings': 'Settings',
      'period.today': 'Today', 'period.week': 'Week', 'period.month': 'Month', 'period.total': 'Total',
      'tokens': 'tokens',
      'feat.kicker': "Why it's nice to have", 'feat.title': 'Cute outside, careful inside',
      'feat.local.t': '100% local', 'feat.local.p': 'Usage is read from your own log files by tokscale. No account, no server, no telemetry.',
      'feat.ledger.t': 'Never loses a session', 'feat.ledger.p': 'A per-session ledger keeps your history even after the AI tool cleans up its logs.',
      'feat.live.t': 'Live in seconds', 'feat.live.p': 'She watches the log folders and reacts within seconds of your next prompt.',
      'feat.mood.t': 'Quota or budget', 'feat.mood.p': 'Subscriptions follow the 5-hour and weekly quota. API billing follows a daily token budget.',
      'feat.packs.t': 'Add your own girl', 'feat.packs.p': 'Each character is a folder: pack.json plus a few PNGs. Any tool tokscale supports can get one.',
      'feat.lang.t': 'English & 中文', 'feat.lang.p': 'The whole app follows your system language.',
      'agents.kicker': 'For AI agents', 'agents.title': 'Let your agent set her up',
      'agents.text': 'The README has a section written for coding agents: where every file lives, how to check detection, change the budget, or add a character for a new tool. Paste this into Claude Code or Codex:',
      'agents.copy': 'Copy', 'agents.copied': 'Copied ♡',
      'final.title': 'Adopt a cat-girl for your quota',
      'final.text': 'Free download. Install, and she shows up on your desktop.',
      'footer.powered': 'Usage data by <a href="https://github.com/junhoyeo/tokscale" target="_blank" rel="noopener">tokscale</a>',
      'footer.note': 'Not affiliated with Anthropic, OpenAI, Google or DeepSeek.',
    },
    zh: {
      'nav.mood': '心情', 'nav.girls': '角色', 'nav.panel': '面板', 'nav.agents': '给 Agent',
      'hero.eyebrow': '写给 AI 开发者的桌宠',
      'hero.tagline': '你的 AI 编程额度，由猫娘守护。',
      'hero.sub': '她住在你的桌面上，盯着 Claude Code、Codex、Gemini CLI 和 DeepSeek 的用量，心情跟着额度走。额度快见底时，她会先替你慌张。',
      'hero.meta': '免费 · v1.0.1 · Windows 10/11 · 数据只留在你的电脑上',
      'cta.download': '下载 Windows 版', 'cta.star': '★ 在 GitHub 点星', 'cta.source': '查看源码',
      'desk.kicker': '住在你的桌面上',
      'desk.title': '你照常写代码，她帮你盯着额度。',
      'desk.text': '戳她一下，旁边就弹出一张小额度卡：5 小时额度和每周额度，就在你干活的地方。不用开网页，不用看仪表盘。',
      'desk.bubble': 'token 来啦~ ✨',
      'quota.session': '5 小时', 'quota.weekly': '每周', 'quota.budget': '每日预算',
      'mood.kicker': '往下滚动，消耗 token',
      'mood.title': '她的心情<em>就是</em>你的额度。',
      'mood.ENERGETIC': '元气', 'mood.FOCUSED': '专注', 'mood.SWEATING': '冒汗',
      'mood.PANICKED': '慌张', 'mood.EXHAUSTED': '累瘫', 'mood.SLEEPING': '睡觉', 'mood.idle': '空闲时',
      'mood.note': '订阅类工具按额度百分比算心情；按 API 计费的工具按你设定的每日 token 预算算。',
      'resets': '18:00 重置',
      'girls.kicker': '认识她们', 'girls.title': '每个 AI 工具一位角色',
      'girls.text': '选一位住在你的桌面上。每位角色盯着自己的工具，穿着它的品牌色，对它的用量做出反应。',
      'girls.claude.name': 'Claude 娘', 'girls.gpt.name': 'GPT 娘', 'girls.gemini.name': 'Gemini 娘', 'girls.deepseek.name': 'DeepSeek 娘',
      'tag.quota': '按额度', 'tag.budget': '按预算',
      'panel.kicker': '托盘里点一下', 'panel.title': '所有工具、所有时段，一眼看清',
      'panel.l1': '每个工具的今日、本周、本月和总计 token',
      'panel.l2': '订阅额度进度条和重置时间',
      'panel.l3': '点卡片查看活跃热力图、近 60 天趋势和每个会话的明细',
      'panel.l4': '拖动卡片调整顺序',
      'panel.demo': '可交互演示，试试切换标签。数字是示例。',
      'panel.refresh': '刷新', 'panel.settings': '设置',
      'period.today': '今日', 'period.week': '本周', 'period.month': '本月', 'period.total': '总计',
      'tokens': 'tokens',
      'feat.kicker': '为什么值得装', 'feat.title': '外表可爱，内里靠谱',
      'feat.local.t': '完全本地', 'feat.local.p': '用量由 tokscale 从你自己的日志文件读取。不用注册账号，没有服务器，不上传任何数据。',
      'feat.ledger.t': '会话永不丢失', 'feat.ledger.p': '按会话记账，即使 AI 工具清理了日志，你的历史用量也还在。',
      'feat.live.t': '秒级更新', 'feat.live.p': '她盯着日志文件夹，你发出下一条提示后几秒内就有反应。',
      'feat.mood.t': '额度或预算', 'feat.mood.p': '订阅用户按 5 小时和每周额度；API 计费按每日 token 预算。',
      'feat.packs.t': '自己加角色', 'feat.packs.p': '每位角色就是一个文件夹：一个 pack.json 加几张 PNG。tokscale 支持的工具都能有自己的角色。',
      'feat.lang.t': '中文 & English', 'feat.lang.p': '整个程序跟随系统语言。',
      'agents.kicker': '给 AI Agent', 'agents.title': '让你的 Agent 帮你配置',
      'agents.text': 'README 里有一节专门写给编程 Agent 看：每个文件在哪、怎么检查工具是否被识别、怎么改预算、怎么给新工具加角色。把这段话贴给 Claude Code 或 Codex：',
      'agents.copy': '复制', 'agents.copied': '已复制 ♡',
      'final.title': '领养一只帮你看额度的猫娘',
      'final.text': '免费下载。装好后，她就出现在你的桌面上。',
      'footer.powered': '用量数据来自 <a href="https://github.com/junhoyeo/tokscale" target="_blank" rel="noopener">tokscale</a>',
      'footer.note': '与 Anthropic、OpenAI、Google、DeepSeek 无关联。',
    },
  };

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  };

  // ?lang=zh / ?lang=en (shareable links) > the visitor's last choice > browser language
  const urlLang = new URLSearchParams(location.search).get('lang');
  let lang = (urlLang in STRINGS && urlLang) || storage.get('nq-lang') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const t = (key) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key;

  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of $$('[data-i18n]')) el.innerHTML = t(el.dataset.i18n);
    $('#lang').textContent = lang === 'zh' ? 'EN' : '中文';
    renderTray();
    lastMood = null; // re-say the current line in the new language
    updateMood();
  }

  $('#lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    storage.set('nq-lang', lang);
    applyLang();
  });

  // ------------------------------------------------------------------ reveal on scroll

  const revealer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      }
    },
    { threshold: 0.15 }
  );
  $$('.reveal').forEach((el) => revealer.observe(el));

  // ------------------------------------------------------------------ desktop demo

  const CODE = [
    '<span class="c">// asking Claude to refactor the auth module…</span>',
    '<span class="k">export async function</span> <span class="f">refreshSession</span>(user) {',
    '  <span class="k">const</span> token = <span class="k">await</span> <span class="f">issueToken</span>(user.id);',
    '  <span class="k">if</span> (!token) <span class="k">throw new</span> <span class="f">Error</span>(<span class="s">"no token"</span>);',
    '  <span class="k">await</span> cache.<span class="f">set</span>(<span class="s">`session:${user.id}`</span>, token);',
    '  <span class="k">return</span> { token, expiresIn: <span class="s">3600</span> };',
    '}',
    '',
    '<span class="c">// ✨ 12,480 tokens later…</span>',
  ];

  function playDesktop(root) {
    root.classList.add('play');
    const code = $('#code');
    let i = 0;
    const step = () => {
      code.innerHTML = CODE.slice(0, i).join('\n') + '<span class="cursor"></span>';
      if (i++ < CODE.length) setTimeout(step, reduceMotion ? 0 : 320);
    };
    step();
    setTimeout(() => {
      for (const fill of $$('.hud-fill[data-w]', root)) fill.style.width = `${fill.dataset.w}%`;
      for (const el of $$('[data-count]', root)) countUp(el, Number(el.dataset.count));
    }, reduceMotion ? 0 : 1400);
  }

  function countUp(el, target) {
    const start = performance.now();
    const tick = (now) => {
      const k = clamp((now - start) / 1200);
      el.textContent = `${Math.round(target * (1 - Math.pow(1 - k, 3)))}%`;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const desk = $('#desktopDemo');
  new IntersectionObserver(
    (entries, obs) => {
      if (entries.some((e) => e.isIntersecting)) {
        playDesktop(desk);
        obs.disconnect();
      }
    },
    { threshold: 0.45 }
  ).observe(desk);

  // ------------------------------------------------------------------ scroll-driven mood

  const PACKS = {
    claude: { color: '#D97757', fill: '#D97757', budget: false },
    gpt: { color: '#1F1F1F', fill: '#1F1F1F', budget: false },
    gemini: { color: '#8E75D6', fill: 'linear-gradient(90deg,#4285F4,#9B72CB,#D96570)', budget: true },
    deepseek: { color: '#4D6BFE', fill: '#4D6BFE', budget: true },
  };
  // Each character speaks in her own voice (taken from the app's packs/<id>/lines files)
  const SAY = {
    "claude": {
      "en": {
        "ENERGETIC": "I'd be happy to help today!",
        "FOCUSED": "Let me think about this carefully…",
        "SWEATING": "To be honest, quota's getting low.",
        "PANICKED": "I apologize, but we're nearly out!",
        "EXHAUSTED": "I'm sorry… I can't continue right now.",
        "SLEEPING": "Zzz… still reading in my dreams…"
      },
      "zh": {
        "ENERGETIC": "今天也很乐意帮你～",
        "FOCUSED": "让我仔细想一想……",
        "SWEATING": "诚实地说，额度有点紧了。",
        "PANICKED": "非常抱歉，额度快用完了！",
        "EXHAUSTED": "对不起……我暂时无法继续了。",
        "SLEEPING": "Zzz……梦里也在看书……"
      }
    },
    "gpt": {
      "en": {
        "ENERGETIC": "Certainly! What shall we build?",
        "FOCUSED": "Let's delve into this.",
        "SWEATING": "Even dragons have limits, you know.",
        "PANICKED": "This is NOT a drill, darling!",
        "EXHAUSTED": "You've reached your usage limit.",
        "SLEEPING": "Zzz… regenerating response…"
      },
      "zh": {
        "ENERGETIC": "当然可以！今天做点什么？",
        "FOCUSED": "让我们深入探讨一下。",
        "SWEATING": "龙也是有极限的哦。",
        "PANICKED": "这不是演习，亲爱的！",
        "EXHAUSTED": "你已达到使用上限。",
        "SLEEPING": "Zzz……正在重新生成回答……"
      }
    },
    "gemini": {
      "en": {
        "ENERGETIC": "Nyaa~ Let's go go go! ✨",
        "FOCUSED": "Thinking in flash mode~",
        "SWEATING": "Eh? The budget's melting! 💦",
        "PANICKED": "Nyaaa! Budget alert! Budget alert!",
        "EXHAUSTED": "Budget gone. I'm just a cat now.",
        "SLEEPING": "Nyaa… zzz… ✨"
      },
      "zh": {
        "ENERGETIC": "喵～冲冲冲！✨",
        "FOCUSED": "闪电模式思考中～",
        "SWEATING": "诶？预算在融化！💦",
        "PANICKED": "喵呜！预算警报！预算警报！",
        "EXHAUSTED": "预算没了，我现在只是一只猫。",
        "SLEEPING": "喵……zzz……✨"
      }
    },
    "deepseek": {
      "en": {
        "ENERGETIC": "Good day, master! Ready to serve~",
        "FOCUSED": "<think> Let me reason step by step…",
        "SWEATING": "Master, the budget is getting heavy…",
        "PANICKED": "M-master! The budget's almost gone!",
        "EXHAUSTED": "Sinking to the seabed… zzz…",
        "SLEEPING": "Zzz… resting at the seabed…"
      },
      "zh": {
        "ENERGETIC": "主人早安！随时为您服务～",
        "FOCUSED": "<think> 让我一步一步推理……",
        "SWEATING": "主人，预算有点吃紧了……",
        "PANICKED": "主、主人！预算快没了！",
        "EXHAUSTED": "沉到海底了……zzz……",
        "SLEEPING": "Zzz……在海底休息……"
      }
    }
  };
  const MOOD_FILE = { ENERGETIC: 'energetic', FOCUSED: 'focused', SWEATING: 'sweating', PANICKED: 'panicked', EXHAUSTED: 'exhausted', SLEEPING: 'sleeping' };
  /** Same thresholds as the app's default behavior: 30 / 60 / 80 / 95 % */
  const moodFor = (pct) => (pct < 30 ? 'ENERGETIC' : pct < 60 ? 'FOCUSED' : pct < 80 ? 'SWEATING' : pct < 95 ? 'PANICKED' : 'EXHAUSTED');
  /** The last part of the section: quota spent, she falls asleep until the reset */
  const SLEEP_FROM = 0.88;

  const moodSec = $('#mood');
  const girl = $('#moodGirl');
  const bubble = $('#moodBubble');
  let pack = 'claude';
  let lastMood = null;

  // Preload every pose so swapping never flashes
  for (const p of Object.keys(PACKS)) for (const f of Object.values(MOOD_FILE)) new Image().src = `assets/${p}-${f}.webp`;

  function setPack(next) {
    pack = next;
    const cfg = PACKS[pack];
    moodSec.style.setProperty('--pack', cfg.color);
    moodSec.style.setProperty('--pack-fill', cfg.fill);
    $('#moodHud').style.setProperty('--pack', cfg.color);
    $('#moodHud').style.setProperty('--pack-fill', cfg.fill);
    $$('#pick button').forEach((b) => b.classList.toggle('active', b.dataset.pack === pack));
    // Budget-billed tools show one budget bar instead of the 5-hour and weekly quota
    $('#moodBarLabel').textContent = t(cfg.budget ? 'quota.budget' : 'quota.session');
    $('#moodWeek').closest('.hud-item').style.display = cfg.budget ? 'none' : '';
    lastMood = null;
    updateMood();
  }

  $$('#pick button').forEach((b) => b.addEventListener('click', () => setPack(b.dataset.pack)));

  function updateMood() {
    const rect = moodSec.getBoundingClientRect();
    const span = moodSec.offsetHeight - innerHeight;
    const p = clamp(-rect.top / span);
    const sleeping = p >= SLEEP_FROM;
    const pct = Math.round(clamp(p / (SLEEP_FROM - 0.03)) * 100);
    const mood = sleeping ? 'SLEEPING' : moodFor(pct);
    const cfg = PACKS[pack];

    $('#moodFill').style.width = `${pct}%`;
    $('#moodPct').textContent = cfg.budget
      ? `${((pct / 100) * 2).toFixed(2)}M / 2M`
      : sleeping ? `100% · ${t('resets')}` : `${pct}%`;
    const week = Math.round(pct * 0.42);
    $('#moodWeek').textContent = `${week}%`;
    $('#moodWeekFill').style.width = `${week}%`;
    $('#moodProgress').style.width = `${p * 100}%`;
    $('#moodBarLabel').textContent = t(cfg.budget ? 'quota.budget' : 'quota.session');

    if (mood === lastMood) return;
    lastMood = mood;
    girl.src = `assets/${pack}-${MOOD_FILE[mood]}.webp`;
    bubble.textContent = SAY[pack][lang][mood];
    $$('#ladder li').forEach((li) => li.classList.toggle('on', li.dataset.mood === mood));
    if (reduceMotion) return;
    girl.classList.remove('bump', 'shake');
    bubble.classList.remove('pop');
    void girl.offsetWidth; // restart the animations
    girl.classList.add(mood === 'PANICKED' ? 'shake' : 'bump');
    bubble.classList.add('pop');
  }

  // ------------------------------------------------------------------ hero parallax

  const heroGirls = {
    claude: [$('.hg-claude'), -1, -1],
    gpt: [$('.hg-gpt'), 1, -1],
    gemini: [$('.hg-gemini'), -1, 1],
    deepseek: [$('.hg-deepseek'), 1, 1],
  };
  const heroText = $('.hero-text');

  function updateHero() {
    const y = scrollY;
    if (y > innerHeight * 1.2) return;
    for (const [el, dx, dy] of Object.values(heroGirls)) {
      el.style.transform = `translate(${dx * y * 0.35}px, ${dy * y * 0.18 - y * 0.15}px) rotate(${dx * y * 0.02}deg)`;
    }
    heroText.style.transform = `translateY(${y * 0.25}px)`;
    heroText.style.opacity = String(clamp(1 - y / (innerHeight * 0.75)));
  }

  // ------------------------------------------------------------------ tray panel demo

  const TRAY = [
    { id: 'claude', name: 'girls.claude.name', color: '#D97757', mood: 'mood.FOCUSED',
      usage: { today: [12.4, '2.1M · 10.3M'], week: [58.1], month: [203.6], total: [488.2] },
      quota: [['quota.session', 62, '17:40'], ['quota.weekly', 24, 'Thu 07:00']] },
    { id: 'gpt', name: 'girls.gpt.name', color: '#1F1F1F', mood: 'mood.ENERGETIC',
      usage: { today: [3.2], week: [21.7], month: [64.9], total: [131.0] },
      quota: [['quota.session', 8, '19:05'], ['quota.weekly', 11, 'Mon 12:08']] },
    { id: 'deepseek', name: 'girls.deepseek.name', color: '#4D6BFE', mood: 'mood.SWEATING',
      usage: { today: [1.4], week: [6.8], month: [18.3], total: [42.5] },
      quota: [['quota.budget', 71, null]] },
  ];
  const periodOf = {};

  function renderTray() {
    const body = $('#trayBody');
    body.innerHTML = '';
    for (const card of TRAY) {
      const period = periodOf[card.id] || 'today';
      const el = document.createElement('div');
      el.className = 'tcard';
      el.style.setProperty('--c', card.color);
      el.innerHTML = `
        <img src="assets/${card.id}-card.webp" alt="" />
        <div class="tcard-head"><span class="tcard-name">${t(card.name)}</span><span class="tcard-mood">${t(card.mood)}</span></div>
        <div class="ttabs">${['today', 'week', 'month', 'total']
          .map((p) => `<button data-p="${p}" class="${p === period ? 'on' : ''}">${t(`period.${p}`)}</button>`)
          .join('')}</div>
        <div class="tbig">${card.usage[period][0].toFixed(1)}M<small>${t('tokens')}</small></div>
        ${card.quota
          .map(([label, pct, reset]) => `
          <div class="tbar">
            <div class="tbar-head"><span>${t(label)}</span><span>${pct}%${reset ? ` · ${reset}` : ''}</span></div>
            <div class="tbar-track"><div class="tbar-fill" style="width:${pct}%"></div></div>
          </div>`)
          .join('')}`;
      for (const b of $$('.ttabs button', el)) {
        b.addEventListener('click', () => {
          periodOf[card.id] = b.dataset.p;
          renderTray();
        });
      }
      body.appendChild(el);
    }
  }

  // ------------------------------------------------------------------ copy prompt

  $('#copy').addEventListener('click', async () => {
    const text = $('#agentPrompt').innerText;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    const btn = $('#copy');
    btn.textContent = t('agents.copied');
    setTimeout(() => (btn.textContent = t('agents.copy')), 1600);
  });

  // ------------------------------------------------------------------ scroll loop

  let queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!reduceMotion) updateHero();
      updateMood();
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  setPack('claude');
  applyLang();
  onScroll();
})();
