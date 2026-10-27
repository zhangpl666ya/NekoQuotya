import { app, nativeImage, type NativeImage } from 'electron';
import path from 'node:path';

// App icons from assets/ (made from the user's artwork; build/ holds the 1024 PNG and
// the .ico for packaging). tray.png has @2x/@3x variants that Electron picks by DPI.

const assets = () => path.join(app.getAppPath(), 'assets');

/** Taskbar and title-bar icon for the app's normal windows */
export function windowIcon(): string {
  return path.join(assets(), 'icon.png');
}

/** Tray icon, or null if the file is missing (the caller then draws a fallback) */
export function trayImage(): NativeImage | null {
  const image = nativeImage.createFromPath(path.join(assets(), 'tray.png'));
  return image.isEmpty() ? null : image;
}
