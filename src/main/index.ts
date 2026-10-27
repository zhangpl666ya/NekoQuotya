import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectorMessage } from '../collector/host.ts';
import { isLocale, translator, type Locale } from '../shared/i18n/index.ts';
import {
  IPC,
  type LauncherCommand,
  type LauncherPack,
  type LauncherState,
  type PetPointer,
  type SessionsView,
  type SettingsSave,
  type SettingsView,
} from '../shared/ipc.ts';
import { packName } from '../shared/packs/manifest.ts';
import { loadPacks, type PackLoadError } from '../shared/packs/registry.ts';
import { allPeriodTotals, PERIODS, periodTotals, sessionRows, type Period } from '../shared/stats.ts';
import type { PackSnapshot } from '../shared/types.ts';
import { AuxWindows, type AuxPage } from './auxWindows.ts';
import { CollectorClient } from './collectorClient.ts';
import { Launcher } from './launcher.ts';
import { assetBase, cardArtUrl, loadImageAppearance, loadLines, registerPackScheme, servePackAssets } from './packAssets.ts';
import { resolvePacksRoot } from './packInstall.ts';
import { PetController } from './petController.ts';

// The app: one pet window per pack, a tray icon with the launcher panel, and the
// collector running in a utility process. No HTTP server, no open ports.

const TICK_MS = 250;
/** Rows sent to a session window per period; the rest are summarized as "more" */
const MAX_SESSION_ROWS = 500;
const HERE = import.meta.dirname;

registerPackScheme();

// Resolved in main(): app.getLocale() is only valid after "ready". NEKO_LANG overrides it.
let locale: Locale = 'en';
let t = translator(locale);

const pets = new Map<string, PetController>();
const snapshots = new Map<string, PackSnapshot>();
let loadErrors: PackLoadError[] = [];
let launcher: Launcher | null = null;
let aux: AuxWindows | null = null;
let collector: CollectorClient | null = null;
let refreshing = false;
let quotaChecking = false;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => launcher?.show());
  app.whenReady().then(main, (err) => {
    console.error(err);
    app.exit(1);
  });
}

// The app lives in the tray: closing every window must not quit it
app.on('window-all-closed', () => {});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void shutdown();
});

async function main(): Promise<void> {
  locale = resolveLocale(process.env.NEKO_LANG ?? app.getLocale());
  t = translator(locale);

  // The project's packs/ in development; a copy in the user folder when installed (packInstall.ts)
  const packsRoot = await resolvePacksRoot();
  const loaded = await loadPacks(packsRoot);
  loadErrors = loaded.errors;
  sortByOrder(loaded.packs, await readPackOrder());
  servePackAssets(loaded.packs);

  launcher = new Launcher({
    t,
    preload: preloadPath('launcher'),
    loadPage,
    getState: launcherState,
    onRefresh: () => void refreshNow(),
    onQuit: () => app.quit(),
  });
  aux = new AuxWindows({ preload: preloadPath, loadPage });

  for (const [index, pack] of loaded.packs.entries()) {
    const pet = new PetController(pack, {
      locale,
      t,
      index,
      lines: await loadLines(pack, locale),
      appearance: await loadImageAppearance(pack),
      assetBase: assetBase(pack),
      preload: preloadPath('pet'),
      loadPage,
      onOpenLauncher: () => launcher?.show(),
      onVisibilityChange: () => launcher?.push(),
      onQuit: () => app.quit(),
    });
    pets.set(pack.id, pet);
    await pet.load();
  }
  // One pet at a time: if several were saved as visible (or a new pack defaults to visible), keep the first.
  // Windows open only after this, so a pet that is about to be hidden never starts loading.
  const visible = [...pets.values()].filter((p) => p.visible);
  for (const pet of visible.slice(1)) pet.setVisible(false);
  for (const pet of pets.values()) pet.restore();

  registerIpc();
  setInterval(() => {
    for (const pet of pets.values()) pet.tick();
  }, TICK_MS);

  collector = new CollectorClient(path.join(HERE, 'collector.js'), onCollectorMessage);
  collector.start(packsRoot);
  quotaChecking = true;
}

function onCollectorMessage(message: CollectorMessage): void {
  switch (message.type) {
    case 'update':
      snapshots.set(message.snapshot.packId, message.snapshot);
      pets.get(message.snapshot.packId)?.observe(message.snapshot);
      if (message.reason === 'quota') quotaChecking = false;
      if (message.reason === 'today' || message.reason === 'history') aux?.notifySessions(message.snapshot.packId);
      launcher?.push();
      return;
    case 'started':
      quotaChecking = false;
      launcher?.push();
      return;
    case 'fatal':
      console.error('[collector]', message.detail);
      return;
    default:
      return;
  }
}

async function refreshNow(): Promise<void> {
  if (refreshing || !collector) return;
  refreshing = true;
  quotaChecking = true;
  launcher?.push();
  try {
    await collector.refreshNow();
  } finally {
    refreshing = false;
    quotaChecking = false;
    launcher?.push();
  }
}

function registerIpc(): void {
  const petFor = (senderId: number) => [...pets.values()].find((p) => p.webContentsId === senderId);

  ipcMain.handle(IPC.petInit, (event) => petFor(event.sender.id)?.initPayload() ?? null);
  ipcMain.on(IPC.petIgnoreMouse, (event, ignore: unknown) => {
    if (typeof ignore === 'boolean') petFor(event.sender.id)?.setIgnoreMouse(ignore);
  });
  ipcMain.on(IPC.petPointer, (event, pointer: PetPointer) => {
    if (pointer && typeof pointer.type === 'string') petFor(event.sender.id)?.pointer(pointer);
  });

  const fromLauncher = (senderId: number) => launcher?.webContentsId === senderId;
  ipcMain.handle(IPC.launcherGet, (event) => (fromLauncher(event.sender.id) ? launcherState() : null));
  ipcMain.on(IPC.launcherCommand, (event, command: LauncherCommand) => {
    if (!fromLauncher(event.sender.id) || !command) return;
    switch (command.type) {
      case 'togglePet': {
        const pet = pets.get(command.packId);
        if (pet) setActivePet(pet.visible ? null : pet.pack.id);
        return;
      }
      case 'refreshNow':
        void refreshNow();
        return;
      case 'setAutostart':
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!command.enabled });
        launcher?.push();
        return;
      case 'openSessions': {
        const pet = pets.get(command.packId);
        if (pet) aux?.openSessions(pet.pack.id, `${packName(pet.pack.manifest, locale)} · ${t('sessions.title')}`);
        return;
      }
      case 'reorder':
        reorderPacks(command.order);
        return;
      case 'openSettings':
        aux?.openSettings(`NekoQuotya · ${t('settings.title')}`);
        return;
      case 'quit':
        app.quit();
        return;
    }
  });

  // Session window: the pack is the one the window was opened for, never one the page names
  ipcMain.handle(IPC.sessionsGet, (event, period: unknown): SessionsView | null => {
    const packId = aux?.packOf(event.sender.id);
    const pet = packId ? pets.get(packId) : undefined;
    if (!pet || typeof period !== 'string' || !(PERIODS as string[]).includes(period)) return null;
    const snap = snapshots.get(pet.pack.id);
    const p = period as Period;
    const empty: PackSnapshot = { packId: pet.pack.id, today: null, history: null, quota: null, status: null };
    const rows = sessionRows(snap ?? empty, p, Date.now());
    return {
      locale,
      packName: packName(pet.pack.manifest, locale),
      theme: pet.pack.manifest.theme,
      period: p,
      totals: periodTotals(snap ?? empty, p, Date.now()),
      rows: rows.slice(0, MAX_SESSION_ROWS),
      truncated: rows.length > MAX_SESSION_ROWS,
    };
  });

  ipcMain.handle(IPC.settingsGet, (event) => (aux?.isSettings(event.sender.id) ? settingsView() : null));
  ipcMain.handle(IPC.settingsSave, async (event, save: SettingsSave): Promise<SettingsView | null> => {
    if (!aux?.isSettings(event.sender.id) || !save || typeof save.packId !== 'string') return null;
    await pets.get(save.packId)?.saveSettings(save.override);
    launcher?.push();
    return settingsView();
  });
  ipcMain.handle(IPC.settingsSetActive, (event, packId: unknown): SettingsView | null => {
    if (!aux?.isSettings(event.sender.id)) return null;
    if (packId === null || (typeof packId === 'string' && pets.has(packId))) setActivePet(packId);
    return settingsView();
  });
  ipcMain.on(IPC.settingsResize, (event, height: unknown) => {
    if (aux?.isSettings(event.sender.id) && typeof height === 'number') aux.resizeSettings(height);
  });
  ipcMain.on(IPC.settingsClose, (event) => {
    if (aux?.isSettings(event.sender.id)) aux.closeSettings();
  });
}

/** Only one pet is on the desktop at a time: show this pack's pet and hide the others (null hides all) */
function setActivePet(packId: string | null): void {
  for (const pet of pets.values()) pet.setVisible(pet.pack.id === packId);
  launcher?.push();
}

// ---- card order (dragged in the panel; also the order in the settings window) ----

const layoutFile = () => path.join(app.getPath('userData'), 'layout.json');

async function readPackOrder(): Promise<string[]> {
  try {
    const saved = JSON.parse(await fs.readFile(layoutFile(), 'utf8')) as { packOrder?: unknown };
    return Array.isArray(saved.packOrder) ? saved.packOrder.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return []; // first run: folder order
  }
}

/** Packs named in `order` come first in that order; new packs keep their folder order after them */
function sortByOrder<T extends { id: string }>(items: T[], order: string[]): void {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  items.sort((a, b) => rank(a.id) - rank(b.id));
}

function reorderPacks(order: unknown): void {
  // Must name every pack exactly once
  if (!Array.isArray(order) || order.length !== pets.size || new Set(order).size !== order.length) return;
  if (!order.every((id) => typeof id === 'string' && pets.has(id))) return;
  const entries = (order as string[]).map((id) => [id, pets.get(id)!] as const);
  pets.clear();
  for (const [id, pet] of entries) pets.set(id, pet);
  launcher?.push();
  void fs
    .mkdir(path.dirname(layoutFile()), { recursive: true })
    .then(() => fs.writeFile(layoutFile(), JSON.stringify({ packOrder: order }, null, 2)))
    .catch((err: unknown) => console.error('[layout] could not save the card order', err));
}

function settingsView(): SettingsView {
  return {
    locale,
    packs: [...pets.values()].map((pet) => ({
      id: pet.pack.id,
      name: packName(pet.pack.manifest, locale),
      theme: pet.pack.manifest.theme,
      hasQuota: !!pet.pack.manifest.source.quotaProvider,
      ...pet.settingsValues(),
    })),
    activePackId: [...pets.values()].find((p) => p.visible)?.pack.id ?? null,
  };
}

function launcherState(): LauncherState {
  const now = Date.now();
  const packs: LauncherPack[] = [...pets.values()].map((pet) => {
    const snap = snapshots.get(pet.pack.id);
    const intent = pet.intent();
    return {
      id: pet.pack.id,
      name: packName(pet.pack.manifest, locale),
      theme: pet.pack.manifest.theme,
      cardArt: cardArtUrl(pet.pack),
      petVisible: pet.visible,
      mood: snap ? intent.mood : null,
      activity: snap ? intent.activity : null,
      usage: snap ? allPeriodTotals(snap, now) : null,
      quota: pet.pack.manifest.source.quotaProvider
        ? {
            plan: snap?.quota?.plan ?? null,
            windows: snap?.quota?.windows ?? [],
            error: snap?.quota?.error ?? null,
            checking: quotaChecking,
          }
        : null,
      status: snap?.status
        ? { lastError: snap.status.lastError, warnings: snap.status.warnings, retainedSessions: snap.status.history.retainedSessions }
        : null,
    };
  });
  return {
    locale,
    packs,
    loadErrors,
    refreshing,
    autostart: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    autostartAvailable: app.isPackaged,
  };
}

async function shutdown(): Promise<void> {
  for (const pet of pets.values()) pet.destroy();
  launcher?.destroy();
  aux?.destroy();
  try {
    await collector?.stop();
  } finally {
    app.exit(0);
  }
}

type Page = 'pet' | 'launcher' | AuxPage;

function preloadPath(name: Page): string {
  return path.join(HERE, '..', 'preload', `${name}.cjs`);
}

async function loadPage(win: BrowserWindow, page: Page): Promise<void> {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServer) await win.loadURL(`${devServer}/${page}/index.html`);
  else await win.loadFile(path.join(HERE, '..', 'renderer', page, 'index.html'));
}

function resolveLocale(raw: string): Locale {
  if (isLocale(raw)) return raw;
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
