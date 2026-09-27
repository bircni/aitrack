import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { APP_DIR } from 'aitrack-lib/paths';
import { getClaudePaths } from 'aitrack-lib/readers/claude';
import { getCodexPaths } from 'aitrack-lib/readers/codex';
import { getCursorStateDatabasePath } from 'aitrack-lib/readers/cursor/location';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  powerMonitor,
  session,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';

import { localDay } from './budget.js';
import { enabledProviders, ingestAll } from './ingest.js';
import { notify, registerIpc } from './ipc.js';
import { ratingReminder, unratedLabel } from './reminder.js';
import { startCatchUp, type CatchUp } from './scheduler.js';
import { DesktopStore } from './store.js';
import { pushDataRepo, syncStatus } from './sync.js';
import { watchSourceRoots } from './watcher.js';
import { shouldOpenWindow } from './windowPolicy.js';

const mainDir = import.meta.dirname;
if (process.env.AITRACK_USER_DATA) app.setPath('userData', process.env.AITRACK_USER_DATA);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let paused = false;
let store: DesktopStore | null = null;
let quitting = false;
let catchUp: CatchUp | null = null;

function trayImage(): Electron.NativeImage {
  const size = 22;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = distance > 6.2 && distance < 9.2 ? 255 : 0;
      const offset = (y * size + x) * 4;
      buffer[offset] = 0;
      buffer[offset + 1] = 0;
      buffer[offset + 2] = 0;
      buffer[offset + 3] = alpha;
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
  image.setTemplateImage(true);
  return image;
}

function createWindow(): BrowserWindow {
  const mac = process.platform === 'darwin';
  const win = process.platform === 'win32';
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'aitrack',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    transparent: mac,
    vibrancy: mac ? 'under-window' : undefined,
    backgroundMaterial: win ? 'mica' : undefined,
    backgroundColor: mac ? '#00000000' : '#100e18',
    webPreferences: {
      preload: join(mainDir, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.on('closed', () => {
    mainWindow = null;
    if (!quitting) applyBackground(store?.setting<boolean>('background', true) ?? true);
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(mainDir, '../renderer/index.html'));
  }
  window.once('ready-to-show', () => {
    const onboarded = store?.setting<boolean>('onboarded', false) ?? false;
    if (process.env.AITRACK_DESKTOP_SHOW === '1' || !onboarded) window.show();
  });
  return window;
}

function showWindow(): void {
  if (process.platform === 'darwin') void app.dock?.show();
  mainWindow ??= createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function applyBackground(background: boolean): void {
  if (process.platform !== 'darwin' || app.dock === undefined) return;
  if (background && process.env.AITRACK_DESKTOP_SHOW !== '1') app.dock.hide();
  else void app.dock.show();
}

function refreshTray(): void {
  if (tray === null || store === null) return;
  const days = store.usageDays();
  const today = localDay(new Date());
  const cost = days.filter((day) => day.day === today).reduce((sum, day) => sum + day.costUsd, 0);
  tray.setToolTip(`aitrack · today $${cost.toFixed(2)}`);
  const status = syncStatus();
  const unrated = store.unratedSessionCount();
  const remind = store.setting<boolean>('rateReminder', false);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Today $${cost.toFixed(2)}`, enabled: false },
      {
        label: 'Open aitrack',
        click: () => {
          showWindow();
        },
      },
      {
        label: unratedLabel(unrated),
        visible: remind && unrated > 0,
        click: () => {
          showWindow();
        },
      },
      { type: 'separator' },
      providerItem('Claude Code', 'claude'),
      providerItem('Codex', 'codex'),
      providerItem('Cursor', 'cursor'),
      {
        label: paused ? 'Resume watching' : 'Pause watching',
        click: () => {
          paused = !paused;
          store?.setSetting('paused', paused);
          refreshTray();
        },
      },
      { type: 'separator' },
      {
        label: 'Push to data repo…',
        visible: status.cloned,
        click: () => {
          void confirmPush();
        },
      },
      { label: 'Quit', role: 'quit' },
    ]),
  );
}

function providerItem(
  label: string,
  key: 'claude' | 'codex' | 'cursor',
): MenuItemConstructorOptions {
  return {
    label,
    type: 'checkbox',
    checked: store?.setting<boolean>(key, true) ?? true,
    click: (item) => {
      store?.setSetting(key, item.checked);
      void scan();
      refreshTray();
    },
  };
}

async function confirmPush(): Promise<void> {
  const status = syncStatus();
  if (!status.cloned || status.machineId === null) return;
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Push'],
    defaultId: 0,
    cancelId: 0,
    message: 'Push to your data repo',
    detail: `This writes data/${status.machineId}.json with this machine's Claude Code and Codex day totals, then pushes that commit. Cursor tokens stay on this machine.`,
  });
  if (choice.response !== 1) return;
  await pushDataRepo('push');
}

function maybeRateReminder(): void {
  if (store === null) return;
  const body = ratingReminder({
    enabled: store.setting<boolean>('rateReminder', false),
    unrated: store.unratedSessionCount(),
    lastAt: store.setting<string | null>('rateReminderAt', null),
    now: Date.now(),
  });
  if (body === null) return;
  store.setSetting('rateReminderAt', new Date().toISOString());
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title: 'aitrack', body });
  notice.on('click', () => {
    showWindow();
  });
  notice.show();
}

async function scan(): Promise<void> {
  if (store === null || paused) return;
  try {
    await ingestAll(store, enabledProviders(store));
    notify({
      store,
      window: () => mainWindow,
      paused: () => paused,
      setPaused: (value) => {
        paused = value;
      },
      setBackground: applyBackground,
    });
    refreshTray();
    maybeRateReminder();
  } catch (error) {
    store.log('ingest', error instanceof Error ? error.message : 'ingest failed');
  }
}

function sourceRoots(): string[] {
  const roots = [...getClaudePaths(), ...getCodexPaths(), join(homedir(), '.cursor', 'projects')];
  const database = getCursorStateDatabasePath();
  if (database !== null) roots.push(dirname(database));
  return roots;
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  store = DesktopStore.open(join(APP_DIR, 'desktop.sqlite'));
  paused = store.setting<boolean>('paused', false);
  registerIpc({
    store,
    window: () => mainWindow,
    paused: () => paused,
    setPaused: (value) => {
      paused = value;
      store?.setSetting('paused', value);
      refreshTray();
    },
    setBackground: applyBackground,
  });
  applyBackground(store.setting<boolean>('background', true));
  tray = new Tray(trayImage());
  tray.on('click', () => {
    showWindow();
  });
  refreshTray();
  if (
    shouldOpenWindow({
      forceShow: process.env.AITRACK_DESKTOP_SHOW === '1',
      onboarded: store.setting<boolean>('onboarded', false),
      menuBarOnly: store.setting<boolean>('background', true),
    })
  ) {
    showWindow();
  }
  void scan();
  catchUp = startCatchUp({
    scan: () => {
      void scan();
    },
    watch: (onChange) => watchSourceRoots(sourceRoots(), onChange),
    listenResume: (listener) => {
      powerMonitor.on('resume', listener);
    },
  });
});

app.on('second-instance', () => {
  showWindow();
});
app.on('window-all-closed', () => {
  // Stay in the tray.
});
app.on('before-quit', () => {
  quitting = true;
  catchUp?.stop();
  catchUp = null;
  store?.close();
});
