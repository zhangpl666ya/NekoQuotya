import { contextBridge, ipcRenderer } from 'electron';
import type { LanguageChoice, SettingsSave, SettingsView } from '../shared/ipc.ts';
import { SETTINGS_CHANNELS } from '../shared/ipc/settings.ts';

// The only API the sandboxed settings window gets.

const api = {
  get: (): Promise<SettingsView | null> => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
  save: (save: SettingsSave): Promise<SettingsView | null> => ipcRenderer.invoke(SETTINGS_CHANNELS.save, save),
  setActive: (packId: string | null): Promise<SettingsView | null> => ipcRenderer.invoke(SETTINGS_CHANNELS.setActive, packId),
  setLanguage: (language: LanguageChoice): Promise<SettingsView | null> => ipcRenderer.invoke(SETTINGS_CHANNELS.setLanguage, language),
  resize: (height: number): void => ipcRenderer.send(SETTINGS_CHANNELS.resize, height),
  close: (): void => ipcRenderer.send(SETTINGS_CHANNELS.close),
};

export type SettingsApi = typeof api;

contextBridge.exposeInMainWorld('nekoSettings', api);
