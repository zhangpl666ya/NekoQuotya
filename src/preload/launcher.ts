import { contextBridge, ipcRenderer } from 'electron';
import type { LauncherCommand, LauncherState } from '../shared/ipc.ts';
import { LAUNCHER_CHANNELS } from '../shared/ipc/launcher.ts';

// The only API the sandboxed launcher panel gets.

const api = {
  get: (): Promise<LauncherState | null> => ipcRenderer.invoke(LAUNCHER_CHANNELS.get),
  onState: (callback: (state: LauncherState) => void): (() => void) => {
    const handler = (_event: unknown, state: LauncherState) => callback(state);
    ipcRenderer.on(LAUNCHER_CHANNELS.state, handler);
    return () => ipcRenderer.removeListener(LAUNCHER_CHANNELS.state, handler);
  },
  command: (command: LauncherCommand): void => ipcRenderer.send(LAUNCHER_CHANNELS.command, command),
};

export type LauncherApi = typeof api;

contextBridge.exposeInMainWorld('nekoLauncher', api);
