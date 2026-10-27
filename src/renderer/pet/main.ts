import { translator, type Translate } from '../../shared/i18n/index.ts';
import type { PetHud, PetInit } from '../../shared/ipc.ts';
import { resolveLine } from '../../shared/lines.ts';
import type { PetIntent } from '../../shared/pet.ts';
import { ImageRenderer } from './renderers/image.ts';
import { PlaceholderRenderer } from './renderers/placeholder.ts';
import type { PetRenderer } from './renderers/types.ts';

// Pet window shell: picks the renderer, shows the speech bubble and turns mouse
// input into pointer events for the main process.
//   hover over the character → stop click-through
//   click                    → poke
//   press and move > 4 px    → drag (the main process moves the window)
//   double-click             → open the launcher panel
//   right-click              → menu
// The quota widget beside the character appears for a few seconds after a click; it is
// display-only and clicks through.

const DRAG_THRESHOLD = 4;
/** How long the quota widget stays after a click */
const HUD_SECONDS = 8;

const api = window.nekoPet;
const stage = document.getElementById('stage')!;
const bubble = document.getElementById('bubble')!;
const hud = document.getElementById('hud')!;

let renderer: PetRenderer;
let lines: PetInit['lines'] = {};
let t: Translate = translator('en');
let bubbleTimer: number | undefined;
let hudTimer: number | undefined;
let shownBubble = -1;

async function start(): Promise<void> {
  const init = await api.init();
  if (!init) return;
  lines = init.lines;
  t = translator(init.locale);
  const root = document.documentElement.style;
  root.setProperty('--pack', init.theme.color);
  root.setProperty('--pack-fill', init.theme.gradient ? `linear-gradient(90deg, ${init.theme.gradient.join(', ')})` : init.theme.color);
  showHud(init.hud);
  api.onHud(showHud);
  renderer =
    init.renderer === 'image' && init.appearance
      ? new ImageRenderer(init.appearance, init.assetBase)
      : new PlaceholderRenderer();
  await renderer.mount(stage);
  document.documentElement.style.setProperty('--stage-height', `${renderer.height}px`);
  apply(init.intent);
  api.onIntent(apply);
  bindMouse();
}

function apply(intent: PetIntent): void {
  renderer.apply(intent);
  const b = intent.bubble;
  if (!b) {
    hideBubble();
    return;
  }
  if (b.id === shownBubble) return;
  shownBubble = b.id;
  const text = resolveLine(lines, b.lineKey, b.id, b.params);
  if (!text) return hideBubble();
  bubble.textContent = text;
  bubble.hidden = false;
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(hideBubble, Math.max(0, b.until - Date.now()));
}

function hideBubble(): void {
  bubble.hidden = true;
}

/** Quota bars beside the character; today's tokens when the tool has no quota */
function showHud(data: PetHud): void {
  hud.replaceChildren();
  if (data.windows.length) {
    for (const w of data.windows) {
      const item = el('div', `hud-item${w.stale ? ' stale' : ''}`);
      const row = el('div', 'hud-row');
      row.append(
        el('span', 'hud-label', w.kind === 'other' ? w.rawLabel : t(`quota.${w.kind}`)),
        el('span', 'hud-value', `${Math.round(w.usedPercent ?? 0)}%${w.stale ? '?' : ''}`)
      );
      const track = el('div', 'hud-track');
      const fill = el('div', 'hud-fill');
      fill.style.width = `${Math.min(100, Math.max(0, w.usedPercent ?? 0))}%`;
      track.append(fill);
      item.append(row, track);
      hud.append(item);
    }
  } else {
    const row = el('div', 'hud-row');
    row.append(el('span', 'hud-label', t('launcher.today')), el('span', 'hud-value', formatTokens(data.todayTokens)));
    hud.append(row);
  }
}

/** The widget is hidden until she is clicked, then shows for HUD_SECONDS (a new click restarts the timer) */
function revealHud(): void {
  hud.hidden = false;
  window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => (hud.hidden = true), HUD_SECONDS * 1000);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function bindMouse(): void {
  let interactive = false;
  let press: { x: number; y: number; pointerId: number } | null = null;
  let dragging = false;

  const setInteractive = (on: boolean) => {
    if (on === interactive) return;
    interactive = on;
    api.setIgnoreMouse(!on);
  };

  const release = (send: boolean) => {
    // Clear state first: releasing the capture may fire lostpointercapture synchronously
    const wasPressed = press;
    const wasDragging = dragging;
    press = null;
    dragging = false;
    if (send) {
      if (wasDragging) api.pointer({ type: 'dragEnd' });
      else if (wasPressed) {
        api.pointer({ type: 'poke' });
        revealHud();
      }
    }
    if (wasPressed && document.body.hasPointerCapture(wasPressed.pointerId)) {
      document.body.releasePointerCapture(wasPressed.pointerId);
    }
  };

  // mousemove, not pointermove: while the window is click-through, Electron forwards
  // plain mouse moves, and those are what tell us the cursor is over her
  window.addEventListener('mousemove', (e) => {
    if (press && !dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > DRAG_THRESHOLD) {
      dragging = true;
      api.pointer({ type: 'dragStart' });
    }
    setInteractive(dragging || !!press || renderer.hitTest(e.clientX, e.clientY));
  });

  window.addEventListener('mouseleave', () => {
    if (!press) setInteractive(false);
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !renderer.hitTest(e.clientX, e.clientY)) return;
    press = { x: e.screenX, y: e.screenY, pointerId: e.pointerId };
    // Capture the pointer so the release always reaches this window, even if the cursor
    // is outside it at that moment; otherwise a drag could never end
    document.body.setPointerCapture(e.pointerId);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button === 0) release(true);
  });

  // Losing the pointer mid-drag (capture lost, focus change) must not leave the pet stuck to the cursor
  window.addEventListener('pointercancel', () => release(true));
  document.body.addEventListener('lostpointercapture', () => {
    if (dragging) release(true);
  });
  window.addEventListener('blur', () => release(dragging));

  window.addEventListener('dblclick', (e) => {
    if (renderer.hitTest(e.clientX, e.clientY)) api.pointer({ type: 'openLauncher' });
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (renderer.hitTest(e.clientX, e.clientY)) api.pointer({ type: 'menu' });
  });
}

void start();
