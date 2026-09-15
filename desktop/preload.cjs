const { contextBridge, ipcRenderer } = require('electron');

// No raw IPC, Node, filesystem, chat contents, or credentials cross this bridge.
if (process.isMainFrame) {
  ipcRenderer.on('local-geni:workspace:search', () => window.dispatchEvent(new Event('local-geni-search')));
  contextBridge.exposeInMainWorld('localGeniDesktop', {
    version: 1,
    whatsapp: {
      open: () => ipcRenderer.invoke('local-geni:whatsapp:open'),
      reload: () => ipcRenderer.invoke('local-geni:whatsapp:reload'),
      forget: () => ipcRenderer.invoke('local-geni:whatsapp:forget'),
      hide: () => ipcRenderer.send('local-geni:whatsapp:hide'),
      setBounds: ({ x, y, width, height, visible }) => ipcRenderer.send('local-geni:whatsapp:bounds', { x, y, width, height, visible }),
      onStatus: callback => {
        const listener = (_event, value) => callback({ phase: value.phase, error: value.error });
        ipcRenderer.on('local-geni:whatsapp:status', listener);
        return () => ipcRenderer.removeListener('local-geni:whatsapp:status', listener);
      },
    },
  });
}
