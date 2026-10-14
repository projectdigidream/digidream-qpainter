//
// qPainter on the desktop.
//
// The web build (vite build, dist/), served over `qpainter://app/` rather than
// file://: a real, secure origin, so ES modules, the service worker and the
// browser library (IndexedDB) work exactly as they do on a web host. Opening
// and saving go through the browser's own file pickers (File System Access),
// which Electron provides -- so the page needs no bridge of its own.
//
const { app, BrowserWindow, Menu, protocol, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const PAYLOAD = path.join(__dirname, 'payload')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'qpainter',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, allowServiceWorkers: true },
}])

function createWindow () {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    backgroundColor: '#14161a',
    title: 'qPainter',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // Links out of the app open in the browser, not in the painter's window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('qpainter://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL('qpainter://app/index.html')
}

app.whenReady().then(() => {
  protocol.handle('qpainter', async (req) => {
    const url = new URL(req.url)
    // Resolve inside the payload and refuse anything that climbs out of it.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.normalize(path.join(PAYLOAD, rel))
    if (!file.startsWith(PAYLOAD)) return new Response('forbidden', { status: 403 })
    try {
      const body = await fs.readFile(file)
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
