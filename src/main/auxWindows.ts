import { BrowserWindow } from 'electron';
import { windowIcon } from './appIcon.ts';
import { IPC } from '../shared/ipc.ts';

// Ordinary framed windows opened from the launcher: one session window per pack and a
// single settings window. Opening one that already exists focuses it.

export type AuxPage = 'sessions' | 'settings';

const SETTINGS_WIDTH = 440;

export interface AuxWindowsDeps {
  preload: (page: AuxPage) => string;
  loadPage: (win: BrowserWindow, page: AuxPage) => Promise<void>;
}

export class AuxWindows {
  private readonly deps: AuxWindowsDeps;
  /** Session windows by pack id */
  private readonly sessions = new Map<string, BrowserWindow>();
  private settings: BrowserWindow | null = null;

  constructor(deps: AuxWindowsDeps) {
    this.deps = deps;
  }

  /** The pack a session window shows, by its webContents id */
  packOf(webContentsId: number): string | null {
    for (const [packId, win] of this.sessions) if (!win.isDestroyed() && win.webContents.id === webContentsId) return packId;
    return null;
  }

  isSettings(webContentsId: number): boolean {
    return !!this.settings && !this.settings.isDestroyed() && this.settings.webContents.id === webContentsId;
  }

  openSessions(packId: string, title: string): void {
    const existing = this.sessions.get(packId);
    if (existing && !existing.isDestroyed()) return focus(existing);
    const win = this.create('sessions', title, { width: 860, height: 600, minWidth: 620, minHeight: 400 });
    win.on('closed', () => this.sessions.delete(packId));
    this.sessions.set(packId, win);
  }

  /** Frameless like the launcher panel; the page draws its own title bar and sizes the window to its content */
  openSettings(title: string): void {
    if (this.settings && !this.settings.isDestroyed()) return focus(this.settings);
    const win = this.create('settings', title, { width: SETTINGS_WIDTH, height: 420, minWidth: SETTINGS_WIDTH, minHeight: 200 }, { frame: false, resizable: false });
    win.on('closed', () => (this.settings = null));
    this.settings = win;
  }

  /** Fit the settings window's height to its content */
  resizeSettings(height: number): void {
    const win = this.settings;
    if (!win || win.isDestroyed() || !Number.isFinite(height)) return;
    win.setContentSize(SETTINGS_WIDTH, Math.round(Math.min(Math.max(height, 200), 900)));
  }

  closeSettings(): void {
    if (this.settings && !this.settings.isDestroyed()) this.settings.close();
  }

  /** Tell a pack's session window that new data is available */
  notifySessions(packId: string): void {
    const win = this.sessions.get(packId);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.sessionsChanged);
  }

  destroy(): void {
    for (const win of this.sessions.values()) if (!win.isDestroyed()) win.destroy();
    if (this.settings && !this.settings.isDestroyed()) this.settings.destroy();
  }

  private create(
    page: AuxPage,
    title: string,
    size: { width: number; height: number; minWidth: number; minHeight: number },
    extra: { frame?: boolean; resizable?: boolean } = {}
  ): BrowserWindow {
    const win = new BrowserWindow({
      ...size,
      ...extra,
      title,
      icon: windowIcon(),
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f7f7f8',
      webPreferences: { preload: this.deps.preload(page), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => win.show());
    // Keep the window title ours instead of the page's <title>
    win.on('page-title-updated', (event) => event.preventDefault());
    void this.deps.loadPage(win, page);
    return win;
  }
}

function focus(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
