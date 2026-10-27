import { contextBridge, ipcRenderer } from 'electron';
import type { SessionsView } from '../shared/ipc.ts';
import { SESSION_CHANNELS } from '../shared/ipc/sessions.ts';
import type { Period } from '../shared/stats.ts';

// The only API the sandboxed session window gets.

const api = {
  get: (period: Period): Promise<SessionsView | null> => ipcRenderer.invoke(SESSION_CHANNELS.get, period),
  onChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(SESSION_CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(SESSION_CHANNELS.changed, handler);
  },
};

export type SessionsApi = typeof api;

contextBridge.exposeInMainWorld('nekoSessions', api);
