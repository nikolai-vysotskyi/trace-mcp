// This file represents a renderer-side module that uses the preload API
// but could also directly use ipcRenderer in older setups
import { ipcRenderer } from 'electron';

// Invoke handlers (matched by resolveEdges → main handle)
export async function loadFolder() {
  return ipcRenderer.invoke('select-folder');
}

export async function openFile(filePath: string) {
  return ipcRenderer.invoke('open-file', filePath);
}

// Send to main (matched by resolveEdges → main on)
export function logEvent(message: string) {
  ipcRenderer.send('log-event', message);
}

// Listen for main→renderer push (matched by resolveEdges ← webContents.send)
export function onUpdateAvailable(callback: (data: unknown) => void) {
  ipcRenderer.on('update-available', (_e, data) => callback(data));
}

export function onDataResponse(callback: (data: unknown) => void) {
  ipcRenderer.on('data-response', (_e, data) => callback(data));
}
