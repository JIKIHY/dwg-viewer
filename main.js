// DWG 뷰어 - 메인 프로세스
// DWG → DXF 변환은 LibreDWG(dwg2dxf, Homebrew)로 하고, 결과는 캐시에 보관한다.
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const zlib = require('zlib');

const CACHE_DIR = path.join(app.getPath('userData'), 'dxf-cache');
const RECENT_FILE = path.join(app.getPath('userData'), 'recent.json');
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const CTB_DIR = path.join(app.getPath('userData'), 'ctb');
const CTB_STATE = path.join(app.getPath('userData'), 'ctb.json');

let pendingOpen = [];
if (process.env.DWGV_TEST_OPEN) app.commandLine.appendSwitch('js-flags', '--expose-gc'); // 앱 준비 전에 Finder에서 넘어온 파일

// ───────────────────────── dwg2dxf ─────────────────────────
function findDwg2dxf() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'dwg2dxf'),
    '/opt/homebrew/bin/dwg2dxf',
    '/usr/local/bin/dwg2dxf',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function convertDwg(dwgPath) {
  return new Promise((resolve, reject) => {
    const bin = findDwg2dxf();
    if (!bin) {
      reject(new Error('DWG 변환기(dwg2dxf)가 없습니다.\n터미널에서 brew install libredwg 를 실행해 주세요.'));
      return;
    }
    const st = fs.statSync(dwgPath);
    const key = crypto.createHash('sha1').update(`${dwgPath}|${st.size}|${st.mtimeMs}|v1`).digest('hex');
    const out = path.join(CACHE_DIR, key + '.dxf');
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      resolve(out);
      return;
    }
    const tmp = out + '.tmp.dxf';
    execFile(bin, ['-y', '-o', tmp, dwgPath], { timeout: 180000, maxBuffer: 256 * 1024 * 1024 }, (err) => {
      // LibreDWG는 경고만 있어도 비정상 종료코드를 낼 수 있어 결과 파일 존재 여부로 판단한다.
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.renameSync(tmp, out);
        resolve(out);
      } else {
        reject(new Error('DWG 변환 실패: ' + (err ? err.message : '출력 없음')));
      }
    });
  });
}

function pruneCache() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      if (now - fs.statSync(p).mtimeMs > CACHE_MAX_AGE_MS) fs.unlinkSync(p);
    }
  } catch (e) { /* 무시 */ }
}

async function loadDrawing(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let dxfPath = filePath;
  if (ext === '.dwg') dxfPath = await convertDwg(filePath);
  else if (ext !== '.dxf') throw new Error('DWG 또는 DXF 파일만 열 수 있습니다.');
  const data = fs.readFileSync(dxfPath);
  return { path: filePath, name: path.basename(filePath), data };
}

// ───────────────────────── XREF 경로 찾기 ─────────────────────────
const nfc = (s) => s.normalize('NFC').toLowerCase();

function searchByName(root, wanted, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of entries) {
    if (e.isFile() && nfc(e.name) === wanted) return path.join(root, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const r = searchByName(path.join(root, e.name), wanted, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function resolveXref(hostPath, refPath) {
  if (!refPath) return null;
  const hostDir = path.dirname(hostPath);
  const norm = refPath.replace(/\\/g, '/');
  const base = norm.split('/').pop();
  const tries = [];
  if (norm.startsWith('/')) tries.push(norm);
  if (!/^[a-zA-Z]:/.test(norm)) tries.push(path.resolve(hostDir, norm));
  tries.push(path.join(hostDir, base));
  for (const t of tries) if (fs.existsSync(t)) return t;
  // 윈도우 절대경로 등으로 못 찾으면 상위 폴더 3단계까지 파일명으로 검색
  const wanted = nfc(base);
  let dir = hostDir;
  for (let i = 0; i < 3; i++) {
    const r = searchByName(dir, wanted, 4);
    if (r) return r;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ───────────────────────── 최근 파일 ─────────────────────────
function readRecent() {
  try { return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')).filter((p) => fs.existsSync(p)); } catch (e) { return []; }
}
function addRecent(p) {
  const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, 15);
  fs.writeFileSync(RECENT_FILE, JSON.stringify(list));
  app.addRecentDocument(p);
  buildMenu();
}

// ───────────────────────── 창 / 메뉴 ─────────────────────────
// 창(탭)마다 열린 도면 경로. 도면 하나 = macOS 탭 하나
const winPaths = new Map();
function createWindow(fileToOpen, tabOf) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1b1d21',
    title: 'DWG 뷰어',
    show: !process.env.DWGV_TEST_OPEN,
    paintWhenInitiallyHidden: true,
    tabbingIdentifier: 'dwg-viewer',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  if (tabOf && !tabOf.isDestroyed()) tabOf.addTabbedWindow(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (fileToOpen) {
    winPaths.set(win, fileToOpen);
    win.webContents.once('did-finish-load', () => win.webContents.send('open-path', fileToOpen));
  }
  win.on('closed', () => winPaths.delete(win));
  return win;
}

function sendToFocused(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send(channel, ...args);
}

async function openViaDialog() {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'CAD 도면', extensions: ['dwg', 'dxf'] }],
  });
  if (!r.canceled) r.filePaths.forEach((p) => openPath(p));
}

function openPathIn(win, p) {
  p = path.resolve(p);
  if ([...winPaths.values()].includes(p)) return;
  createWindow(p, win);
}

// 이미 열린 도면이면 그 탭으로, 빈 창이면 거기서, 아니면 새 탭으로 연다
function openPath(p) {
  p = path.resolve(p);
  for (const [w, q] of winPaths) {
    if (q === p && !w.isDestroyed()) { w.show(); w.focus(); return; }
  }
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !winPaths.has(win)) {
    winPaths.set(win, p);
    win.webContents.send('open-path', p);
  } else createWindow(p, win);
}

function buildMenu() {
  const recent = readRecent();
  const cmd = (c) => () => sendToFocused('command', c);
  const template = [
    { role: 'appMenu' },
    {
      label: '파일',
      submenu: [
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: openViaDialog },
        {
          label: '최근 파일',
          submenu: recent.length
            ? recent.map((p) => ({ label: path.basename(p), click: () => openPath(p) }))
            : [{ label: '(없음)', enabled: false }],
        },
        { label: '새 탭', accelerator: 'CmdOrCtrl+T', click: () => createWindow(null, BrowserWindow.getFocusedWindow()) },
        { label: '새 창', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'XREF 부착…', accelerator: 'CmdOrCtrl+Shift+X', click: cmd('attach-xref') },
        { label: '도면 다시 불러오기', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
        { type: 'separator' },
        { label: '인쇄 / PDF…', accelerator: 'CmdOrCtrl+P', click: cmd('print') },
        { label: '현재 화면 PNG로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-png') },
        { type: 'separator' },
        { role: 'close', label: '탭 닫기' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '전체 보기 (F)', click: cmd('zoom-extents') },
        { label: '확대', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
        { label: '축소', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
        { type: 'separator' },
        { label: '배경색 전환(검정/흰색)', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-bg') },
        { label: '문자 검색', accelerator: 'CmdOrCtrl+F', click: cmd('search') },
        { label: '오른쪽 패널 보기/숨기기', accelerator: 'CmdOrCtrl+\\', click: cmd('toggle-panel') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    { role: 'windowMenu', label: '윈도우' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────── IPC ─────────────────────────
ipcMain.handle('open-dialog', () => openViaDialog());
ipcMain.handle('open-path', (_e, p) => openPath(p));
ipcMain.handle('pick-drawing', async (_e, title) => {
  const r = await dialog.showOpenDialog({
    title: title || '도면 선택',
    properties: ['openFile'],
    filters: [{ name: 'CAD 도면', extensions: ['dwg', 'dxf'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('load-drawing', async (_e, p, isMain) => {
  try {
    const r = await loadDrawing(p);
    if (isMain) addRecent(p);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('resolve-xref', (_e, hostPath, refPath) => resolveXref(hostPath, refPath));
ipcMain.handle('save-png', async (_e, dataUrl, suggested) => {
  const r = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('desktop'), suggested || 'capture.png'),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});
ipcMain.handle('check-converter', () => !!findDwg2dxf());

// ── CTB 플롯 스타일: 사용자가 고른 파일을 앱 보관함에 복사하고 선택을 기억한다 ──
function readCtbState() {
  try { return JSON.parse(fs.readFileSync(CTB_STATE, 'utf8')); } catch (e) { return { last: null, byName: {} }; }
}
function writeCtbState(st) { fs.writeFileSync(CTB_STATE, JSON.stringify(st, null, 2)); }
function ctbFiles() {
  fs.mkdirSync(CTB_DIR, { recursive: true });
  return fs.readdirSync(CTB_DIR).filter((f) => /\.ctb$/i.test(f)).sort((a, b) => a.localeCompare(b, 'ko'));
}
ipcMain.handle('ctb-list', () => ({ files: ctbFiles(), ...readCtbState() }));
ipcMain.handle('ctb-import', async () => {
  const r = await dialog.showOpenDialog({
    title: 'CTB 플롯 스타일 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '플롯 스타일 (CTB)', extensions: ['ctb'] }],
  });
  if (r.canceled) return [];
  fs.mkdirSync(CTB_DIR, { recursive: true });
  const names = [];
  for (const p of r.filePaths) {
    const name = path.basename(p).normalize('NFC');
    fs.copyFileSync(p, path.join(CTB_DIR, name));
    names.push(name);
  }
  return names;
});
ipcMain.handle('ctb-read', (_e, name) => {
  const buf = fs.readFileSync(path.join(CTB_DIR, path.basename(name)));
  if (!buf.subarray(0, 14).toString('latin1').startsWith('PIAFILEVERSION')) throw new Error('CTB 형식이 아닙니다');
  return zlib.inflateSync(buf.subarray(60)).toString('utf8');
});
ipcMain.handle('ctb-remember', (_e, choice, sheetName) => {
  const st = readCtbState();
  st.last = choice;
  st.byName = st.byName || {};
  if (sheetName) st.byName[sheetName.toUpperCase()] = choice;
  writeCtbState(st);
});
ipcMain.handle('ctb-remove', (_e, name) => {
  try { fs.unlinkSync(path.join(CTB_DIR, path.basename(name))); } catch (e) { /* 무시 */ }
});

// 인쇄: 렌더된 용지 이미지를 숨은 창에 올려 PDF로 저장하거나 macOS 인쇄 대화상자를 띄운다.
ipcMain.handle('print-page', async (_e, content, opt) => {
  const dir = path.join(app.getPath('temp'), 'dwgv-print');
  fs.mkdirSync(dir, { recursive: true });
  const orient = opt.landscape ? 'landscape' : 'portrait';
  let body;
  if (opt.kind === 'svg') {
    body = content; // 벡터 출력: 선·문자가 그대로 PDF/프린터로 전달된다
  } else {
    fs.writeFileSync(path.join(dir, 'page.png'), Buffer.from(content.split(',')[1], 'base64'));
    body = '<img src="page.png">';
  }
  fs.writeFileSync(
    path.join(dir, 'page.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${opt.paper} ${orient};margin:0}` +
      `html,body{margin:0;padding:0}img,svg{display:block;width:${opt.wmm}mm;height:${opt.hmm}mm}</style></head>` +
      `<body>${body}</body></html>`
  );
  // 프린터 인쇄는 보이는 창이 있어야 macOS 인쇄 대화상자가 확실히 붙는다.
  const toPrinter = opt.mode !== 'pdf';
  const win = new BrowserWindow({
    show: toPrinter,
    width: 900,
    height: 680,
    title: `인쇄 미리보기 — ${opt.name || ''}`,
    parent: BrowserWindow.getFocusedWindow() || undefined,
  });
  try {
    await win.loadFile(path.join(dir, 'page.html'));
    if (toPrinter) await win.webContents.insertCSS('@media screen{html{background:#555}img,svg{width:auto!important;height:94vh!important;max-width:96vw;margin:2vh auto;background:#fff;box-shadow:0 2px 12px #0008}}');
    if (opt.mode === 'pdf') {
      const pdf = await win.webContents.printToPDF({ pageSize: opt.paper, landscape: !!opt.landscape, printBackground: true, margins: { marginType: 'none' } });
      if (process.env.DWGV_TEST_PDF) { fs.writeFileSync(process.env.DWGV_TEST_PDF, pdf); return { saved: process.env.DWGV_TEST_PDF }; }
      const r = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('desktop'), `${opt.name || 'plot'}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return {};
      fs.writeFileSync(r.filePath, pdf);
      shell.showItemInFolder(r.filePath);
      return { saved: r.filePath };
    }
    return await new Promise((resolve) => {
      win.webContents.print(
        { silent: false, printBackground: true, landscape: !!opt.landscape, pageSize: opt.paper, margins: { marginType: 'none' } },
        (ok, reason) => resolve(ok || reason === 'cancelled' ? {} : { error: reason })
      );
    });
  } finally {
    win.destroy();
  }
});

// ───────────────────────── 앱 수명주기 ─────────────────────────
app.on('open-file', (event, p) => {
  event.preventDefault();
  if (app.isReady()) openPath(p);
  else pendingOpen.push(p);
});

app.whenReady().then(() => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  pruneCache();
  buildMenu();
  const argFile = process.argv.slice(1).find((a) => /\.(dwg|dxf)$/i.test(a) && fs.existsSync(a));
  if (argFile) pendingOpen.push(path.resolve(argFile));
  if (process.env.DWGV_TEST_OPEN) {
    // 개발용: 도면을 열고 화면을 캡처한 뒤 종료
    const win = createWindow(process.env.DWGV_TEST_OPEN);
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    setTimeout(async () => {
      if (process.env.DWGV_TEST_JS) {
        const r = await win.webContents.executeJavaScript(process.env.DWGV_TEST_JS).catch((err) => 'JS 오류: ' + err.message);
        console.log('[test-js]', typeof r === 'string' ? r : JSON.stringify(r));
        await new Promise((res) => setTimeout(res, 800));
        console.log('[test-tabs]', [...winPaths.values()].map((q) => path.basename(q)).join(' | '), '· 창', BrowserWindow.getAllWindows().length);
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.DWGV_TEST_SHOT || '/tmp/dwgv.png', img.toPNG());
      app.exit(0);
    }, +(process.env.DWGV_TEST_WAIT || 8000));
    return;
  }
  if (pendingOpen.length) {
    const first = createWindow(path.resolve(pendingOpen[0]));
    pendingOpen.slice(1).forEach((p) => openPathIn(first, p));
  } else createWindow();
  pendingOpen = [];
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
