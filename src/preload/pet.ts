import { contextBridge, ipcRenderer } from 'electron';
import type { PetHud, PetInit, PetPointer } from '../shared/ipc.ts';
import { PET_CHANNELS } from '../shared/ipc/pet.ts';
import type { PetIntent } from '../shared/pet.ts';

// The only API the sandboxed pet window gets.

const api = {
  init: (): Promise<PetInit | null> => ipcRenderer.invoke(PET_CHANNELS.init),
  onIntent: (callback: (intent: PetIntent) => void): (() => void) => {
    const handler = (_event: unknown, intent: PetIntent) => callback(intent);
    ipcRenderer.on(PET_CHANNELS.intent, handler);
    return () => ipcRenderer.removeListener(PET_CHANNELS.intent, handler);
  },
  onHud: (callback: (hud: PetHud) => void): (() => void) => {
    const handler = (_event: unknown, hud: PetHud) => callback(hud);
    ipcRenderer.on(PET_CHANNELS.hud, handler);
    return () => ipcRenderer.removeListener(PET_CHANNELS.hud, handler);
  },
  setIgnoreMouse: (ignore: boolean): void => ipcRenderer.send(PET_CHANNELS.ignoreMouse, ignore),
  pointer: (event: PetPointer): void => ipcRenderer.send(PET_CHANNELS.pointer, event),
};

export type PetApi = typeof api;

contextBridge.exposeInMainWorld('nekoPet', api);
