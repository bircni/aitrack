import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { isKnownChannel } from '../shared/contracts.js';

contextBridge.exposeInMainWorld('aitrack', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!isKnownChannel(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  onChanged(listener: () => void): () => void {
    const wrapped = (_event: IpcRendererEvent): void => {
      listener();
    };
    ipcRenderer.on('store:changed', wrapped);
    return () => {
      ipcRenderer.removeListener('store:changed', wrapped);
    };
  },
});
