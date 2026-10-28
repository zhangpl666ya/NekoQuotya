import { BrowserWindow, Menu, screen, type Rectangle } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../collector/packStore.ts';
import type { ImageAppearance } from '../shared/appearance.ts';
import type { Locale, Translate } from '../shared/i18n/index.ts';
import { IPC, type EditableBehavior, type PetHud, type PetInit, type PetPointer } from '../shared/ipc.ts';
import {
  applyBehaviorOverride,
  BehaviorSchema,
  EDITABLE_BEHAVIOR,
  type Behavior,
  type BehaviorOverride,
} from '../shared/packs/manifest.ts';
import type { Lines } from '../shared/lines.ts';
import type { LoadedPack } from '../shared/packs/registry.ts';
import type { PetIntent } from '../shared/pet.ts';
import type { PackSnapshot } from '../shared/types.ts';
import { PetBrain } from './brain/petBrain.ts';
import { clampToArea, type Overhang } from './geometry.ts';

// One per pack: the pet's brain and its window (docs/architecture.md §6.1).
//  · frameless, transparent, always on top, not in the taskbar, never steals focus
//  · click-through except over the character (the renderer reports hits)
//  · dragged by the main process following the cursor, kept inside the screen
//  · position and visibility saved in the pack's data/state.json
//
// state.json is written by the main process; the collector process holds the
// data-folder lock only for the collector's own files.

/** Room above the character for the speech bubble */
const BUBBLE_SPACE = 80;
const PLACEHOLDER_SIZE = { width: 240, height: 220 };
/** Transparent margin around the placeholder face inside its canvas (see renderers/placeholder.ts) */
const PLACEHOLDER_MARGIN = { top: 28, side: 32, bottom: 20 };
/** The quota widget to the right of the character (renderer/pet/style.css #hud) */
const HUD_WIDTH = 104;
const HUD_GAP = 4;
const EDGE_MARGIN = 24;

interface PetState {
  visible: boolean;
  /** Relative to the display's top-left corner, so it survives display rearrangements */
  position: { displayId: number; x: number; y: number } | null;
}

export interface PetControllerDeps {
  locale: Locale;
  t: Translate;
  /** Index among packs, used to spread default positions */
  index: number;
  lines: Lines;
  appearance: ImageAppearance | null;
  assetBase: string;
  preload: string;
  loadPage: (win: BrowserWindow, page: 'pet') => Promise<void>;
  onOpenLauncher: () => void;
  onVisibilityChange: () => void;
  onQuit: () => void;
}

export class PetController {
  readonly pack: LoadedPack;
  private deps: PetControllerDeps;
  private readonly brain: PetBrain;
  private win: BrowserWindow | null = null;
  private state: PetState = { visible: true, position: null };
  private lastSentKey = '';
  private hud: PetHud = { windows: [], todayTokens: 0 };
  private override: BehaviorOverride = {};
  private lastHudKey = '';
  private dragTimer: NodeJS.Timeout | null = null;
  private dragOffset = { x: 0, y: 0 };

  constructor(pack: LoadedPack, deps: PetControllerDeps) {
    this.pack = pack;
    this.deps = deps;
    this.brain = new PetBrain(pack.manifest.behavior, Date.now());
  }

  get visible(): boolean {
    return this.state.visible;
  }

  get webContentsId(): number | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents.id : null;
  }

  intent(): PetIntent {
    return this.brain.intent();
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.stateFile(), 'utf8')) as Partial<PetState>;
      this.state = { visible: saved.visible !== false, position: saved.position ?? null };
    } catch {
      // no saved state yet
    }
    try {
      const saved = JSON.parse(await fs.readFile(this.settingsFile(), 'utf8')) as { behavior?: unknown };
      this.override = pickOverride(saved.behavior);
      this.brain.setRules(this.behavior(), Date.now());
    } catch {
      // no user settings: the pack's own behavior applies
    }
  }

  /** Open the pet window if it was visible last time; called after load() once every pet is loaded */
  restore(): void {
    if (this.state.visible) this.createWindow();
  }

  // ---- settings (docs/architecture.md §6.2: user overrides live in data/, pack.json is never edited) ----

  /** The pack's behavior with the user's overrides */
  behavior(): Behavior {
    return applyBehaviorOverride(this.pack.manifest.behavior, this.override);
  }

  settingsValues(): { values: EditableBehavior; defaults: EditableBehavior } {
    const pick = (b: Behavior): EditableBehavior => ({
      dailyBudget: b.dailyBudget,
      moodBasis: b.moodBasis,
      idleSleepMinutes: b.idleSleepMinutes,
      chatterMinutes: b.chatterMinutes,
    });
    return { values: pick(this.behavior()), defaults: pick(this.pack.manifest.behavior) };
  }

  /** Save the user's overrides (an empty object resets to the pack's defaults) and apply them now */
  async saveSettings(override: unknown): Promise<void> {
    this.override = pickOverride(override);
    this.push(this.brain.setRules(this.behavior(), Date.now()));
    await writeJsonAtomic(this.settingsFile(), { behavior: this.override });
  }

  /** After a language switch: the pet page reloads and picks up the new locale and lines */
  setLanguage(locale: Locale, lines: Lines): void {
    this.deps = { ...this.deps, locale, lines };
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.lastSentKey = '';
    this.lastHudKey = '';
    win.webContents.reload();
  }

  initPayload(): PetInit {
    const { appearance } = this.deps;
    return {
      packId: this.pack.id,
      locale: this.deps.locale,
      renderer: appearance ? 'image' : 'placeholder',
      appearance,
      assetBase: this.deps.assetBase,
      lines: this.deps.lines,
      intent: this.brain.intent(),
      theme: this.pack.manifest.theme,
      hud: this.hud,
    };
  }

  // ---- inputs from the collector, the clock and the user -----------------------

  observe(snapshot: PackSnapshot): void {
    const intent = this.brain.observe(snapshot, Date.now());
    this.hud = hudOf(snapshot, intent.info.todayTokens);
    this.push(intent);
    this.pushHud();
  }

  tick(): void {
    this.push(this.brain.tick(Date.now()));
  }

  pointer(event: PetPointer): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    switch (event.type) {
      case 'poke':
        this.push(this.brain.interact('poke', Date.now()));
        return;
      case 'dragStart':
        this.startDrag(win);
        this.push(this.brain.interact('dragStart', Date.now()));
        return;
      case 'dragEnd':
        this.stopDrag();
        this.push(this.brain.interact('dragEnd', Date.now()));
        return;
      case 'menu':
        this.showMenu(win);
        return;
      case 'openLauncher':
        this.deps.onOpenLauncher();
        return;
    }
  }

  setIgnoreMouse(ignore: boolean): void {
    if (this.dragTimer) return; // keep receiving events while dragging
    this.win?.setIgnoreMouseEvents(ignore, { forward: true });
  }

  // ---- visibility ----------------------------------------------------------------

  setVisible(visible: boolean): void {
    if (visible === this.state.visible) return;
    this.state = { ...this.state, visible };
    if (visible) this.createWindow();
    else this.closeWindow();
    void this.saveState();
    this.deps.onVisibilityChange();
  }

  destroy(): void {
    this.stopDrag();
    this.closeWindow();
  }

  // ---- window ---------------------------------------------------------------------

  private createWindow(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const size = this.windowSize();
    const bounds = this.initialBounds(size);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      title: this.pack.id,
      webPreferences: {
        preload: this.deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.stopDrag();
    });
    this.win = win;
    this.lastSentKey = '';
    this.lastHudKey = '';
    this.deps.loadPage(win, 'pet').catch((err: unknown) => {
      // Closing the window mid-load aborts the load; only a real failure is worth logging
      if (!win.isDestroyed()) console.error('[pet] page failed to load', err);
    });
  }

  private closeWindow(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.close();
  }

  /** Character on the left, quota widget on the right, bubble space above */
  private windowSize(): { width: number; height: number } {
    const art = this.artSize();
    return { width: art.width + HUD_GAP + HUD_WIDTH, height: art.height + BUBBLE_SPACE };
  }

  private artSize(): { width: number; height: number } {
    const a = this.deps.appearance;
    return a ? { width: a.size[0], height: a.size[1] } : PLACEHOLDER_SIZE;
  }

  /**
   * Only the character must stay on screen. The bubble space above it, the quota
   * widget on its right and any padding may leave the screen. Image art is kept whole,
   * since its transparent margins are unknown.
   */
  private overhang(): Overhang {
    const inner = this.deps.appearance ? { top: 0, side: 0, bottom: 0 } : PLACEHOLDER_MARGIN;
    return { top: BUBBLE_SPACE + inner.top, left: inner.side, right: inner.side + HUD_GAP + HUD_WIDTH, bottom: inner.bottom };
  }

  /** Saved position if its display still exists, otherwise the bottom-right corner of the primary display */
  private initialBounds(size: { width: number; height: number }): Rectangle {
    const saved = this.state.position;
    const display = saved && screen.getAllDisplays().find((d) => d.id === saved.displayId);
    const overhang = this.overhang();
    if (saved && display) {
      return clampToArea({ x: display.bounds.x + saved.x, y: display.bounds.y + saved.y, ...size }, display.workArea, overhang);
    }
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - size.width - EDGE_MARGIN - this.deps.index * (size.width + EDGE_MARGIN);
    return clampToArea({ x, y: area.y + area.height - size.height, ...size }, area, overhang);
  }

  // ---- dragging -------------------------------------------------------------------

  /**
   * Follow the cursor. Positions are computed only from the cursor and the grab offset,
   * and compared with the last position *we set*: reading the position back from the
   * window and re-setting it whenever it differs makes the window creep on displays
   * with fractional scaling (each move is rounded). setBounds with the fixed size also
   * keeps the window from growing a pixel at a time.
   */
  private startDrag(win: BrowserWindow): void {
    this.stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const start = win.getBounds();
    const size = this.windowSize();
    this.dragOffset = { x: cursor.x - start.x, y: cursor.y - start.y };
    win.setIgnoreMouseEvents(false);
    const overhang = this.overhang();
    let last = { x: start.x, y: start.y };
    this.dragTimer = setInterval(() => {
      if (win.isDestroyed()) return this.stopDrag();
      const point = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(point).workArea;
      const next = clampToArea({ x: point.x - this.dragOffset.x, y: point.y - this.dragOffset.y, ...size }, area, overhang);
      if (next.x === last.x && next.y === last.y) return;
      last = { x: next.x, y: next.y };
      win.setBounds(next);
    }, 16);
  }

  private stopDrag(): void {
    if (!this.dragTimer) return;
    clearInterval(this.dragTimer);
    this.dragTimer = null;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.state = {
      ...this.state,
      position: { displayId: display.id, x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y },
    };
    void this.saveState();
  }

  private showMenu(win: BrowserWindow): void {
    const { t } = this.deps;
    Menu.buildFromTemplate([
      { label: t('menu.openPanel'), click: () => this.deps.onOpenLauncher() },
      { label: t('menu.hidePet'), click: () => this.setVisible(false) },
      { type: 'separator' },
      { label: t('menu.quit'), click: () => this.deps.onQuit() },
    ]).popup({ window: win });
  }

  // ---- intent and state ------------------------------------------------------------

  /** Send the intent to the window when something visible changed */
  private push(intent: PetIntent): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const key = [
      intent.mood,
      intent.activity,
      intent.action?.id,
      intent.action?.startedAt,
      intent.bubble?.id,
      intent.info.pressure,
      intent.info.stale,
    ].join('|');
    if (key === this.lastSentKey) return;
    this.lastSentKey = key;
    win.webContents.send(IPC.petIntent, intent);
  }

  /** Send the quota widget's data when it changed */
  private pushHud(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const key = JSON.stringify(this.hud);
    if (key === this.lastHudKey) return;
    this.lastHudKey = key;
    win.webContents.send(IPC.petHud, this.hud);
  }

  private stateFile(): string {
    return path.join(this.pack.dataDir, 'state.json');
  }

  private settingsFile(): string {
    return path.join(this.pack.dataDir, 'settings.json');
  }

  private async saveState(): Promise<void> {
    try {
      await writeJsonAtomic(this.stateFile(), this.state);
    } catch {
      // position memory is a convenience; failing to save it must not disturb the pet
    }
  }
}

/** Keep only valid, editable keys; anything else in a settings file or request is dropped */
function pickOverride(raw: unknown): BehaviorOverride {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_BEHAVIOR) {
    if (!(key in raw)) continue;
    const value = (raw as Record<string, unknown>)[key];
    const probe = BehaviorSchema.shape[key].safeParse(value);
    if (probe.success) out[key] = probe.data;
  }
  return out as BehaviorOverride;
}

/** The quota widget's data: the 5-hour and weekly windows (or the first two that apply) */
export function hudOf(snapshot: PackSnapshot, todayTokens: number): PetHud {
  const applicable = (snapshot.quota?.windows ?? []).filter((w) => w.applicable && w.usedPercent != null);
  const preferred = applicable.filter((w) => w.kind === 'session' || w.kind === 'weekly');
  const chosen = (preferred.length ? preferred : applicable).slice(0, 2);
  return {
    windows: chosen.map(({ kind, rawLabel, usedPercent, stale }) => ({ kind, rawLabel, usedPercent, stale })),
    todayTokens,
  };
}

