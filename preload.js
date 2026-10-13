const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  openInTab: (p) => ipcRenderer.invoke('open-path', p),
  pickDrawing: (title) => ipcRenderer.invoke('pick-drawing', title),
  loadDrawing: (p, isMain) => ipcRenderer.invoke('load-drawing', p, isMain),
  resolveXref: (host, ref) => ipcRenderer.invoke('resolve-xref', host, ref),
  savePng: (dataUrl, name) => ipcRenderer.invoke('save-png', dataUrl, name),
  printPage: (content, opt) => ipcRenderer.invoke('print-page', content, opt),
  ctbList: () => ipcRenderer.invoke('ctb-list'),
  ctbImport: () => ipcRenderer.invoke('ctb-import'),
  ctbRead: (name) => ipcRenderer.invoke('ctb-read', name),
  ctbRemember: (choice, sheetName) => ipcRenderer.invoke('ctb-remember', choice, sheetName),
  ctbRemove: (name) => ipcRenderer.invoke('ctb-remove', name),
  checkConverter: () => ipcRenderer.invoke('check-converter'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(c)),
});
