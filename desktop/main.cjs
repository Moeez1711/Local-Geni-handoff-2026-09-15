const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');

const WHATSAPP_URL = 'https://web.whatsapp.com/';
const WHATSAPP_ZOOM = 0.75;
const configuredUrl = new URL(process.env.LOCAL_GENI_DESKTOP_URL || 'http://127.0.0.1:4013/');
if (configuredUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(configuredUrl.hostname) || configuredUrl.username || configuredUrl.password || configuredUrl.pathname !== '/' || configuredUrl.search) {
  throw new Error('LOCAL_GENI_DESKTOP_URL must be a loopback HTTP origin, such as http://127.0.0.1:4013/.');
}
configuredUrl.hash = 'whatsapp';
const LOCAL_ORIGIN = configuredUrl.origin;
app.setName('Local Geni');
app.setPath('userData', path.join(app.getPath('appData'), 'Local Geni Desktop'));

let window = null;
let whatsappView = null;
let whatsappSession = null;
let desiredBounds = null;
let wantsInbox = false;
let forgetting = false;
let externalPrompt = false;
let status = { phase: 'idle', error: '' };
let whatsappDocumentReady = false;
let loadingDeadline = null;
const grantedPermissions = new Set();
// Application suffixes can cause WhatsApp to misclassify current Chromium.
const browserPlatform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : `X11; Linux ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
const whatsappUserAgent = `Mozilla/5.0 (${browserPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

function originIs(value, expected) {
  try { const url = new URL(value); return url.origin === expected && !url.username && !url.password; }
  catch { return false; }
}
function trustedSender(event) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && originIs(event.senderFrame.url, LOCAL_ORIGIN));
}
function requireTrusted(event) {
  if (!trustedSender(event)) throw new Error('This action is only available inside Local Geni Desktop.');
}
function inWhatsAppWorkspace() {
  if (!window || window.isDestroyed()) return false;
  try { const url = new URL(window.webContents.getURL()); return url.origin === LOCAL_ORIGIN && url.hash.split('?')[0] === '#whatsapp'; }
  catch { return false; }
}
function publish(phase, error = '') {
  status = { phase, error };
  if (window && !window.isDestroyed() && originIs(window.webContents.getURL(), LOCAL_ORIGIN)) {
    window.webContents.send('local-geni:whatsapp:status', status);
  }
  positionInbox();
}
function positionInbox() {
  if (!whatsappView || whatsappView.webContents.isDestroyed() || !window || window.isDestroyed()) return;
  if (!wantsInbox || !desiredBounds?.visible || !inWhatsAppWorkspace() || status.phase !== 'ready') { whatsappView.setVisible(false); return; }
  const [width, height] = window.getContentSize();
  const zoom = window.webContents.getZoomFactor();
  const x = Math.max(0, Math.min(width, Math.round(desiredBounds.x * zoom)));
  const y = Math.max(0, Math.min(height, Math.round(desiredBounds.y * zoom)));
  const bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round(desiredBounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(desiredBounds.height * zoom))) };
  whatsappView.setBounds(bounds);
  whatsappView.setVisible(bounds.width > 0 && bounds.height > 0);
}
function hideInbox() { wantsInbox = false; whatsappView?.setVisible(false); }

function clearLoadingDeadline() {
  if (loadingDeadline) clearTimeout(loadingDeadline);
  loadingDeadline = null;
}
function awaitWhatsAppDocument(view) {
  if (loadingDeadline) return;
  loadingDeadline = setTimeout(() => {
    loadingDeadline = null;
    if (whatsappView === view && !view.webContents.isDestroyed() && !whatsappDocumentReady && status.phase === 'loading') {
      publish('error', 'WhatsApp is taking too long. Check your connection, then reload. Your sign-in is saved.');
    }
  }, 45000);
  loadingDeadline.unref();
}
function showWhatsAppDocument(view) {
  if (whatsappView !== view || view.webContents.isDestroyed() || !originIs(view.webContents.getURL(), 'https://web.whatsapp.com')) return;
  whatsappDocumentReady = true;
  view.webContents.setZoomFactor(WHATSAPP_ZOOM);
  clearLoadingDeadline();
  publish('ready');
}

async function openExternal(rawUrl) {
  if (externalPrompt || !window || window.isDestroyed()) return;
  let url;
  try { url = new URL(rawUrl); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
  externalPrompt = true;
  try {
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: 'Open external link?', message: `Open ${url.hostname} in your browser?`, detail: 'The WhatsApp inbox will stay inside Local Geni. Only this link opens outside the app.', buttons: ['Cancel', 'Open link'], defaultId: 0, cancelId: 0, noLink: true });
    if (response === 1) await shell.openExternal(url.href);
  } catch { /* A cancelled or unavailable browser must not crash the app. */ }
  finally { externalPrompt = false; }
}
function restrictNavigation(contents, allowedOrigin) {
  contents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (!originIs(url, allowedOrigin)) { event.preventDefault(); void openExternal(url); }
  });
  contents.on('will-redirect', (event, legacyUrl) => {
    if (!originIs(event.url || legacyUrl, allowedOrigin)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
}
function configureWhatsAppSession() {
  whatsappSession = session.fromPartition('persist:local-geni-whatsapp-v1');
  // Chromium compatibility without changing WhatsApp's security headers or TLS.
  whatsappSession.setUserAgent(whatsappUserAgent);
  whatsappSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (contents !== whatsappView?.webContents || !originIs(requestingOrigin, 'https://web.whatsapp.com') || details?.isMainFrame === false) return false;
    return permission === 'clipboard-sanitized-write' || grantedPermissions.has(permission);
  });
  whatsappSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (contents !== whatsappView?.webContents || !originIs(details.requestingUrl, 'https://web.whatsapp.com') || details.isMainFrame === false) { callback(false); return; }
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (!['notifications', 'media'].includes(permission) || !window || window.isDestroyed()) { callback(false); return; }
    if (grantedPermissions.has(permission)) { callback(true); return; }
    const resource = permission === 'media' ? 'your camera and microphone' : 'desktop notifications';
    dialog.showMessageBox(window, { type: 'question', title: 'WhatsApp permission', message: `Allow WhatsApp to use ${resource}?`, detail: 'This permission applies only to WhatsApp Web during this desktop session. Your operating system may also ask for permission.', buttons: ['Not now', 'Allow'], defaultId: 0, cancelId: 0, noLink: true }).then(({ response }) => {
      const allowed = response === 1 && contents === whatsappView?.webContents && !contents.isDestroyed();
      if (allowed) grantedPermissions.add(permission);
      callback(allowed);
    }).catch(() => callback(false));
  });
  whatsappSession.on('will-download', (event, item, contents) => {
    if (contents !== whatsappView?.webContents) { event.preventDefault(); return; }
    // Chromium displays a Save dialog; nothing is silently saved to the Desktop.
    item.setSaveDialogOptions({ title: 'Save WhatsApp attachment', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
}
function ensureWhatsAppView() {
  if (whatsappView && !whatsappView.webContents.isDestroyed()) return;
  const view = new WebContentsView({ webPreferences: { session: whatsappSession, nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false, navigateOnDragDrop: false } });
  whatsappView = view;
  view.webContents.setUserAgent(whatsappUserAgent);
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'k' && window && !window.isDestroyed()) {
      event.preventDefault();
      window.webContents.focus();
      window.webContents.send('local-geni:workspace:search');
    }
  });
  view.setVisible(false);
  window.contentView.addChildView(view);
  restrictNavigation(view.webContents, 'https://web.whatsapp.com');
  // Background loading must not hide a document the user can already operate.
  view.webContents.on('did-start-loading', () => {
    if (whatsappView === view && !whatsappDocumentReady) { publish('loading'); awaitWhatsAppDocument(view); }
  });
  view.webContents.on('dom-ready', () => showWhatsAppDocument(view));
  view.webContents.on('did-finish-load', () => showWhatsAppDocument(view));
  view.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (whatsappView === view && isMainFrame && code !== -3) {
      whatsappDocumentReady = false; clearLoadingDeadline();
      publish('error', 'WhatsApp could not load. Check your connection, then reload.');
    }
  });
  view.webContents.on('render-process-gone', () => {
    if (whatsappView === view) { whatsappDocumentReady = false; clearLoadingDeadline(); publish('error', 'WhatsApp stopped. Reload to reopen it.'); }
  });
}
function loadWhatsApp() {
  ensureWhatsAppView();
  const current = whatsappView;
  whatsappDocumentReady = false;
  clearLoadingDeadline();
  publish('loading');
  awaitWhatsAppDocument(current);
  void current.webContents.loadURL(WHATSAPP_URL).catch(error => {
    if (error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
    if (whatsappView === current && !current.webContents.isDestroyed() && !whatsappDocumentReady) {
      clearLoadingDeadline();
      publish('error', 'WhatsApp could not load. Check your connection, then reload.');
    }
  });
}
function closeWhatsAppView() {
  clearLoadingDeadline();
  whatsappDocumentReady = false;
  const previous = whatsappView;
  whatsappView = null;
  if (!previous) return;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(previous);
  if (!previous.webContents.isDestroyed()) previous.webContents.close();
}

ipcMain.handle('local-geni:whatsapp:open', event => {
  requireTrusted(event);
  if (!inWhatsAppWorkspace()) throw new Error('Open the WhatsApp workspace first.');
  wantsInbox = true;
  if (!forgetting && (!whatsappView || status.phase === 'idle')) loadWhatsApp();
  positionInbox();
  return status;
});
ipcMain.handle('local-geni:whatsapp:reload', event => {
  requireTrusted(event);
  if (forgetting || !inWhatsAppWorkspace()) return status;
  wantsInbox = true;
  loadWhatsApp();
  return status;
});
ipcMain.on('local-geni:whatsapp:hide', event => { if (trustedSender(event)) hideInbox(); });
ipcMain.on('local-geni:whatsapp:bounds', (event, bounds) => {
  if (!trustedSender(event) || !bounds || !['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)) return;
  desiredBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visible: bounds.visible === true };
  positionInbox();
});
ipcMain.handle('local-geni:whatsapp:forget', async event => {
  requireTrusted(event);
  if (forgetting || !inWhatsAppWorkspace()) return status;
  forgetting = true;
  try {
    const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Forget WhatsApp sign-in?', message: 'Remove the WhatsApp sign-in saved in Local Geni Desktop?', detail: 'You will need to scan a QR code again. This does not delete your phone chats or CRM data. To revoke the linked device on WhatsApp, also remove it under Linked devices on your phone.', buttons: ['Cancel', 'Forget sign-in'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return status;
    publish('resetting');
    closeWhatsAppView();
    grantedPermissions.clear();
    await whatsappSession.clearData();
    publish('idle');
    if (wantsInbox && inWhatsAppWorkspace()) loadWhatsApp();
    return status;
  } catch {
    publish('error', 'The local sign-in could not be fully cleared. Close the app and revoke this device in WhatsApp on your phone.');
    return status;
  } finally { forgetting = false; }
});

async function loadLocalGeni() {
  try { await window.loadURL(configuredUrl.href); }
  catch {
    if (!window || window.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(window, { type: 'info', title: 'Start Local Geni first', message: `Local Geni is not available at ${LOCAL_ORIGIN}.`, detail: 'Keep your Local Geni server running, then retry. The desktop app does not start servers or background campaigns automatically.', buttons: ['Close', 'Retry'], defaultId: 1, cancelId: 0 });
    if (response === 1) void loadLocalGeni(); else window.close();
  }
}
function createWindow() {
  window = new BrowserWindow({ title: 'Local Geni', width: 1440, height: 960, minWidth: 1100, minHeight: 780, backgroundColor: '#f7f8fa', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: 'persist:local-geni-workspace-v1', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false } });
  restrictNavigation(window.webContents, LOCAL_ORIGIN);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) hideInbox(); });
  window.webContents.on('did-navigate-in-page', () => { if (!inWhatsAppWorkspace()) hideInbox(); });
  window.webContents.on('render-process-gone', hideInbox);
  window.on('resize', positionInbox);
  window.on('closed', () => { closeWhatsAppView(); window = null; desiredBounds = null; wantsInbox = false; status = { phase: 'idle', error: '' }; });
  void loadLocalGeni();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(() => {
    configureWhatsAppSession();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'Local Geni', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch(error => { dialog.showErrorBox('Local Geni Desktop could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', closeWhatsAppView);
}
