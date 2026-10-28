import { BrowserWindow, Menu, Tray, nativeImage, screen, type NativeImage, type Rectangle } from 'electron';
import { trayImage } from './appIcon.ts';
import type { Translate } from '../shared/i18n/index.ts';
import { IPC, type LauncherState } from '../shared/ipc.ts';

// The tray icon and the launcher panel (docs/architecture.md §6.2): a small panel
// anchored to the tray icon that hides when it loses focus.

const PANEL_SIZE = { width: 360, height: 480 };
const GAP = 8;

export interface LauncherDeps {
  t: Translate;
  preload: string;
  loadPage: (win: BrowserWindow, page: 'launcher') => Promise<void>;
  getState: () => LauncherState;
  onRefresh: () => void;
  onQuit: () => void;
}

export class Launcher {
  private readonly deps: LauncherDeps;
  private readonly tray: Tray;
  private panel: BrowserWindow | null = null;
  /** Ignore the tray click that immediately follows a blur-hide, so a click toggles instead of reopening */
  private hiddenAt = 0;

  constructor(deps: LauncherDeps) {
    this.deps = deps;
    this.tray = new Tray(trayImage() ?? trayIcon());
    this.tray.setToolTip(deps.t('tray.tooltip'));
    this.tray.on('click', () => this.toggle());
    this.tray.on('right-click', () => {
      this.tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: deps.t('menu.openPanel'), click: () => this.show() },
          { label: deps.t('menu.refresh'), click: () => deps.onRefresh() },
          { type: 'separator' },
          { label: deps.t('menu.quit'), click: () => deps.onQuit() },
        ])
      );
    });
  }

  /** After a language switch: texts that were set once */
  applyLanguage(): void {
    this.tray.setToolTip(this.deps.t('tray.tooltip'));
  }

  get webContentsId(): number | null {
    return this.panel && !this.panel.isDestroyed() ? this.panel.webContents.id : null;
  }

  /** Send the latest state if the panel is open */
  push(): void {
    const panel = this.panel;
    if (panel && !panel.isDestroyed() && panel.isVisible()) panel.webContents.send(IPC.launcherState, this.deps.getState());
  }

  toggle(): void {
    if (this.panel?.isVisible()) this.panel.hide();
    else if (Date.now() - this.hiddenAt > 300) this.show();
  }

  show(): void {
    const panel = this.ensurePanel();
    panel.setBounds(this.panelBounds());
    panel.show();
    panel.focus();
    this.push();
  }

  destroy(): void {
    this.tray.destroy();
    if (this.panel && !this.panel.isDestroyed()) this.panel.destroy();
  }

  private ensurePanel(): BrowserWindow {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const panel = new BrowserWindow({
      ...PANEL_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'NekoQuotya',
      webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    panel.on('blur', () => {
      if (!panel.isVisible()) return;
      this.hiddenAt = Date.now();
      panel.hide();
    });
    this.panel = panel;
    void this.deps.loadPage(panel, 'launcher');
    return panel;
  }

  /** Above the tray icon when the taskbar is at the bottom, below it when at the top, inside the work area */
  private panelBounds(): Rectangle {
    const tray = this.tray.getBounds();
    const anchor = tray.width ? tray : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
    const { width, height } = PANEL_SIZE;
    let x = anchor.x + anchor.width / 2 - width / 2;
    let y = anchor.y > area.y + area.height / 2 ? area.y + area.height - height - GAP : area.y + GAP;
    x = Math.min(Math.max(x, area.x + GAP), area.x + area.width - width - GAP);
    y = Math.min(Math.max(y, area.y + GAP), area.y + area.height - height - GAP);
    return { x: Math.round(x), y: Math.round(y), width, height };
  }
}

/** Fallback when assets/tray.png is missing: a 16-px (32-px at 2x) round face drawn in code */
function trayIcon(): NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      // BGRA
      let [b, g, r, a] = [0, 0, 0, 0];
      if (d <= 15) [b, g, r, a] = [180, 120, 244, 255]; // pink face
      const eye = Math.hypot(x - 10.5, y - 13) <= 2.4 || Math.hypot(x - 20.5, y - 13) <= 2.4;
      const mouth = y >= 19 && y <= 21 && x >= 12 && x <= 19 && Math.abs(Math.hypot(x - 15.5, y - 15) - 5) < 1.4;
      if (d <= 15 && (eye || mouth)) [b, g, r, a] = [60, 30, 40, 255];
      if (d > 15 && d <= 15.8) a = Math.round((15.8 - d) / 0.8 * 255);
      buf.set([b, g, r, a], i);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}
