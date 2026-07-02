/**
 * Electron API Shim for Termux
 * Provides minimal stubs for Electron APIs that are imported by shared modules.
 * Most proxy server code doesn't use Electron directly, but some type definitions
 * and utility files may reference Electron types.
 */

// Stub for app
export const app = {
  getPath: (name: string) => '/tmp',
  getName: () => 'chat2api-termux',
  getVersion: () => '1.4.0',
  isPackaged: true,
  commandLine: {
    appendSwitch: () => {},
  },
  requestSingleInstanceLock: () => true,
  on: () => {},
  quit: () => {},
  relaunch: () => {},
  whenReady: () => Promise.resolve(),
}

// Stub for BrowserWindow
export class BrowserWindow {
  webContents: any = { send: () => {} }
  constructor() {}
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  show() {}
  hide() {}
  close() {}
  focus() {}
  isMinimized() { return false }
  isDestroyed() { return false }
  restore() {}
  setTitle() {}
  on() {}
  once() {}
  removeAllListeners() {}
  webContentsEvent = { send: () => {} }
  get webContents() { return this.webContentsEvent }
}

// Stub for safeStorage
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString('utf-8'),
}

// Stub for shell
export const shell = {
  openExternal: (url: string) => {
    console.log('[Termux] Would open URL:', url)
    return Promise.resolve()
  },
  openPath: (path: string) => {
    console.log('[Termux] Would open path:', path)
    return Promise.resolve('')
  },
}

// Stub for net (Electron's net module used by Perplexity adapter)
// This is handled by the perplexity-shim, but provide a stub for other potential uses
export const net = {
  request: () => {
    throw new Error('Electron net.request is not available in Termux mode. Use the perplexity-shim instead.')
  },
  fetch: () => {
    throw new Error('Electron net.fetch is not available in Termux mode.')
  },
}

// Stub for ipcMain
export const ipcMain = {
  on: () => {},
  handle: () => {},
  removeHandler: () => {},
}

// Stub for ipcRenderer
export const ipcRenderer = {
  on: () => {},
  send: () => {},
  invoke: () => Promise.resolve(),
}

// Stub for contextBridge
export const contextBridge = {
  exposeInMainWorld: () => {},
}

// Stub for Notification
export const Notification = class {
  constructor() {}
  show() {}
}

// Stub for Tray
export const Tray = class {
  constructor() {}
  destroy() {}
  setToolTip() {}
  setContextMenu() {}
}

// Stub for Menu
export const Menu = {
  buildFromTemplate: () => ({}) as any,
}

// Stub for dialog
export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
}

// Stub for nativeTheme
export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: 'system',
}

export default {
  app,
  BrowserWindow,
  safeStorage,
  shell,
  net,
  ipcMain,
  ipcRenderer,
  contextBridge,
  Notification,
  Tray,
  Menu,
  dialog,
  nativeTheme,
}