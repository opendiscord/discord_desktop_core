'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getMainWindowId = getMainWindowId;
exports.webContentsSend = webContentsSend;
exports.init = init;
exports.handleSingleInstance = handleSingleInstance;
exports.setMainWindowVisible = setMainWindowVisible;

var _electron = require('electron');

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _url = require('url');

var _url2 = _interopRequireDefault(_url);

var _Backoff = require('../common/Backoff');

var _Backoff2 = _interopRequireDefault(_Backoff);

var _appBadge = require('./appBadge');

var appBadge = _interopRequireWildcard(_appBadge);

var _appConfig = require('./appConfig');

var appConfig = _interopRequireWildcard(_appConfig);

var _appSettings = require('./appSettings');

var _buildInfo = require('./buildInfo');

var _buildInfo2 = _interopRequireDefault(_buildInfo);

var _ipcMain = require('./ipcMain');

var _ipcMain2 = _interopRequireDefault(_ipcMain);

var _moduleUpdater = require('./moduleUpdater');

var moduleUpdater = _interopRequireWildcard(_moduleUpdater);

var _notificationScreen = require('./notificationScreen');

var notificationScreen = _interopRequireWildcard(_notificationScreen);

var _popoutWindows = require('./popoutWindows');

var popoutWindows = _interopRequireWildcard(_popoutWindows);

var _splashScreen = require('./splashScreen');

var splashScreen = _interopRequireWildcard(_splashScreen);

var _systemTray = require('./systemTray');

var systemTray = _interopRequireWildcard(_systemTray);

var _Constants = require('./Constants');

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const settings = (0, _appSettings.getSettings)();
const connectionBackoff = new _Backoff2.default(1000, 20000);
const DISCORD_NAMESPACE = 'DISCORD_';

const getWebappEndpoint = () => {
  let endpoint = settings.get('WEBAPP_ENDPOINT');
  if (!endpoint) {
    if (_buildInfo2.default.releaseChannel === 'stable') {
      endpoint = 'https://discordapp.com';
    } else {
      endpoint = `https://${_buildInfo2.default.releaseChannel}.discordapp.com`;
    }
  }
  return endpoint;
};

const WEBAPP_ENDPOINT = getWebappEndpoint();

function getSanitizedPath(path) {
  // using the whatwg URL api, get a sanitized pathname from given path
  // this is because url.parse's `path` may not always have a slash
  // in front of it
  return new _url2.default.URL(path, WEBAPP_ENDPOINT).pathname;
}

function extractPathFromArgs(args, fallbackPath) {
  if (args.length === 3 && args[0] === '--url' && args[1] === '--') {
    try {
      const parsedURL = _url2.default.parse(args[2]);
      if (parsedURL.protocol === 'discord:') {
        return getSanitizedPath(parsedURL.path);
      }
    } catch (_) {} // protect against URIError: URI malformed
  }
  return fallbackPath;
}

// TODO: These should probably be thrown in constants.
const INITIAL_PATH = extractPathFromArgs(process.argv.slice(1), '/app');
const WEBAPP_PATH = settings.get('WEBAPP_PATH', `${INITIAL_PATH}?_=${Date.now()}`);
const URL_TO_LOAD = `${WEBAPP_ENDPOINT}${WEBAPP_PATH}`;
const MIN_WIDTH = settings.get('MIN_WIDTH', 940);
const MIN_HEIGHT = settings.get('MIN_HEIGHT', 500);
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// TODO: document this var's purpose
const MIN_VISIBLE_ON_SCREEN = 32;

let mainWindow = null;
let mainWindowId = _Constants.DEFAULT_MAIN_WINDOW_ID;

// whether we are in an intermediate auth process outside of our normal login screen (for e.g. internal builds)
let insideAuthFlow = false;

// last time the main app renderer has crashed ('crashed' event)
let lastCrashed = 0;

// whether we failed to load a page outside of the intermediate auth flow
// used to reload the page after a delay
let lastPageLoadFailed = false;

function getMainWindowId() {
  return mainWindowId;
}

function webContentsSend(...args) {
  if (mainWindow != null && mainWindow.webContents != null) {
    const [event, ...options] = args;
    mainWindow.webContents.send(`${DISCORD_NAMESPACE}${event}`, ...options);
  }
}

function saveWindowConfig(browserWindow) {
  try {
    if (!browserWindow) {
      return;
    }

    settings.set('IS_MAXIMIZED', browserWindow.isMaximized());
    settings.set('IS_MINIMIZED', browserWindow.isMinimized());
    if (!settings.get('IS_MAXIMIZED') && !settings.get('IS_MINIMIZED')) {
      settings.set('WINDOW_BOUNDS', browserWindow.getBounds());
    }

    settings.save();
  } catch (e) {
    console.error(e);
  }
}

function setWindowVisible(isVisible, andUnminimize) {
  if (mainWindow == null) {
    return;
  }

  if (isVisible) {
    if (andUnminimize || !mainWindow.isMinimized()) {
      mainWindow.show();
      webContentsSend('MAIN_WINDOW_FOCUS');
    }
  } else {
    webContentsSend('MAIN_WINDOW_BLUR');
    mainWindow.hide();
    if (systemTray.hasInit) {
      systemTray.displayHowToCloseHint();
    }
  }

  mainWindow.setSkipTaskbar(!isVisible);
}

function doAABBsOverlap(a, b) {
  const ax1 = a.x + a.width;
  const bx1 = b.x + b.width;
  const ay1 = a.y + a.height;
  const by1 = b.y + b.height;
  // clamp a to b, see if it is non-empty
  const cx0 = a.x < b.x ? b.x : a.x;
  const cx1 = ax1 < bx1 ? ax1 : bx1;
  if (cx1 - cx0 > 0) {
    const cy0 = a.y < b.y ? b.y : a.y;
    const cy1 = ay1 < by1 ? ay1 : by1;
    if (cy1 - cy0 > 0) {
      return true;
    }
  }
  return false;
}

function applyWindowBoundsToConfig(mainWindowOptions) {
  if (!settings.get('WINDOW_BOUNDS')) {
    mainWindowOptions.center = true;
    return;
  }

  const bounds = settings.get('WINDOW_BOUNDS');
  bounds.width = Math.max(MIN_WIDTH, bounds.width);
  bounds.height = Math.max(MIN_HEIGHT, bounds.height);

  let isVisibleOnAnyScreen = false;
  const displays = _electron.screen.getAllDisplays();
  displays.forEach(display => {
    if (isVisibleOnAnyScreen) {
      return;
    }
    const displayBound = display.workArea;
    displayBound.x += MIN_VISIBLE_ON_SCREEN;
    displayBound.y += MIN_VISIBLE_ON_SCREEN;
    displayBound.width -= 2 * MIN_VISIBLE_ON_SCREEN;
    displayBound.height -= 2 * MIN_VISIBLE_ON_SCREEN;
    isVisibleOnAnyScreen = doAABBsOverlap(bounds, displayBound);
  });

  if (isVisibleOnAnyScreen) {
    mainWindowOptions.width = bounds.width;
    mainWindowOptions.height = bounds.height;
    mainWindowOptions.x = bounds.x;
    mainWindowOptions.y = bounds.y;
  } else {
    mainWindowOptions.center = true;
  }
}

// this can be called multiple times (due to recreating the main app window),
// so we only want to update existing if we already initialized it
function setupNotificationScreen(mainWindow) {
  if (!notificationScreen.hasInit) {
    notificationScreen.init({
      mainWindow,
      title: 'Discord Notifications',
      maxVisible: 5,
      screenPosition: 'bottom'
    });

    notificationScreen.events.on(notificationScreen.NOTIFICATION_CLICK, () => {
      setWindowVisible(true, true);
    });
  } else {
    notificationScreen.setMainWindow(mainWindow);
  }
}

// this can be called multiple times (due to recreating the main app window),
// so we only want to update existing if we already initialized it
function setupSystemTray() {
  if (!systemTray.hasInit) {
    systemTray.init({
      onCheckForUpdates: () => moduleUpdater.checkForUpdates(),
      onTrayClicked: () => setWindowVisible(true, true),
      onOpenVoiceSettings: openVoiceSettings,
      onToggleMute: toggleMute,
      onToggleDeafen: toggleDeafen,
      onLaunchApplication: launchApplication
    });
  }
}

// this can be called multiple times (due to recreating the main app window),
// so we only want to update existing if we already initialized it
function setupAppBadge() {
  if (!appBadge.hasInit) {
    appBadge.init();
  }
}

// this can be called multiple times (due to recreating the main app window),
// so we only want to update existing if we already initialized it
function setupAppConfig() {
  if (!appConfig.hasInit) {
    appConfig.init();
  }
}

// this can be called multiple times (due to recreating the main app window),
// so we only want to update existing if we already initialized it
function setupPopouts() {
  if (!popoutWindows.hasInit) {
    popoutWindows.init();
  }
}

function openVoiceSettings() {
  setWindowVisible(true, true);
  webContentsSend('SYSTEM_TRAY_OPEN_VOICE_SETTINGS');
}

function toggleMute() {
  webContentsSend('SYSTEM_TRAY_TOGGLE_MUTE');
}

function toggleDeafen() {
  webContentsSend('SYSTEM_TRAY_TOGGLE_DEAFEN');
}

function launchApplication(applicationId) {
  webContentsSend('LAUNCH_APPLICATION', applicationId);
}

const loadMainPage = () => {
  lastPageLoadFailed = false;
  mainWindow.loadURL(URL_TO_LOAD);
};

const DEFAULT_BACKGROUND_COLOR = '#2f3136';
const BACKGROUND_COLOR_KEY = 'BACKGROUND_COLOR';

function getBackgroundColor() {
  return settings.get(BACKGROUND_COLOR_KEY, DEFAULT_BACKGROUND_COLOR);
}

function setBackgroundColor(color) {
  settings.set(BACKGROUND_COLOR_KEY, color);
  mainWindow.setBackgroundColor(color);
  settings.save();
}

// launch main app window; could be called multiple times for various reasons
function launchMainAppWindow(isVisible) {
  if (mainWindow) {
    // TODO: message here?
    mainWindow.destroy();
  }

  const mainWindowOptions = {
    title: 'Discord',
    backgroundColor: getBackgroundColor(),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    transparent: false,
    frame: false,
    resizable: true,
    show: isVisible,
    webPreferences: {
      blinkFeatures: 'EnumerateDevices,AudioOutputDevices',
      nodeIntegration: false,
      preload: _path2.default.join(__dirname, 'mainScreenPreload.js'),
      nativeWindowOpen: true
    }
  };

  if (process.platform === 'linux') {
    mainWindowOptions.icon = _path2.default.join(_path2.default.dirname(_electron.app.getPath('exe')), 'discord.png');
    mainWindowOptions.frame = true;
  }

  applyWindowBoundsToConfig(mainWindowOptions);

  mainWindow = new _electron.BrowserWindow(mainWindowOptions);
  mainWindowId = mainWindow.id;
  global.mainWindowId = mainWindowId;

  mainWindow.setMenuBarVisibility(false);

  if (settings.get('IS_MAXIMIZED')) {
    mainWindow.maximize();
  }

  if (settings.get('IS_MINIMIZED')) {
    mainWindow.minimize();
  }

  mainWindow.webContents.on('new-window', (e, windowURL, frameName, disposition, options) => {
    e.preventDefault();
    if (frameName.startsWith(DISCORD_NAMESPACE) && windowURL.startsWith(WEBAPP_ENDPOINT)) {
      popoutWindows.openOrFocusWindow(e, windowURL, frameName, options);
    } else {
      _electron.shell.openExternal(windowURL);
    }
  });

  mainWindow.webContents.on('did-fail-load', (e, errCode, errDesc, validatedUrl) => {
    if (insideAuthFlow) {
      return;
    }

    if (validatedUrl !== URL_TO_LOAD) {
      return;
    }

    // -3 (ABORTED) means we are reloading the page before it has finished loading
    // 0 (???) seems to also mean the same thing
    if (errCode === -3 || errCode === 0) return;

    lastPageLoadFailed = true;
    console.error('[WebContents] did-fail-load', errCode, errDesc, `retry in ${connectionBackoff.current} ms`);
    connectionBackoff.fail(() => {
      console.log('[WebContents] retrying load', URL_TO_LOAD);
      loadMainPage();
    });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (insideAuthFlow && mainWindow.webContents && mainWindow.webContents.getURL().startsWith(WEBAPP_ENDPOINT)) {
      insideAuthFlow = false;
    }

    webContentsSend(mainWindow != null && mainWindow.isFocused() ? 'MAIN_WINDOW_FOCUS' : 'MAIN_WINDOW_BLUR');
    if (!lastPageLoadFailed) {
      connectionBackoff.succeed();
      splashScreen.pageReady();
    }
  });

  mainWindow.webContents.on('crashed', (e, killed) => {
    if (killed) {
      _electron.app.quit();
      return;
    }

    // if we just crashed under 5 seconds ago, we are probably in a loop, so just die.
    const crashTime = Date.now();
    if (crashTime - lastCrashed < 5 * 1000) {
      console.error('[WebContents] double crashed... RIP =(');
      _electron.app.quit();
      return;
    }
    lastCrashed = crashTime;
    console.error('[WebContents] crashed... reloading');
    launchMainAppWindow(true);
  });

  // Prevent navigation when links or files are dropping into the app, turning it into a browser.
  // https://github.com/discord/discord/pull/278
  mainWindow.webContents.on('will-navigate', (evt, url) => {
    if (!insideAuthFlow && !url.startsWith(WEBAPP_ENDPOINT)) {
      evt.preventDefault();
    }
  });

  // track intermediate auth flow
  mainWindow.webContents.on('did-get-redirect-request', (event, oldUrl, newUrl) => {
    if (oldUrl.startsWith(WEBAPP_ENDPOINT) && newUrl.startsWith('https://accounts.google.com/')) {
      insideAuthFlow = true;
    }
  });

  mainWindow.on('focus', () => {
    webContentsSend('MAIN_WINDOW_FOCUS');
  });

  mainWindow.on('blur', () => {
    webContentsSend('MAIN_WINDOW_BLUR');
  });

  mainWindow.on('page-title-updated', (e, title) => {
    if (mainWindow === null) {
      return;
    }
    e.preventDefault();
    if (!title.endsWith('Discord')) {
      title += ' - Discord';
    }
    mainWindow.setTitle(title);
  });

  mainWindow.on('leave-html-full-screen', () => {
    // fixes a bug wherein embedded videos returning from full screen cause our menu to be visible.
    mainWindow.setMenuBarVisibility(false);
  });

  if (process.platform === 'win32') {
    setupNotificationScreen(mainWindow);
  }

  setupSystemTray();
  setupAppBadge();
  setupAppConfig();
  setupPopouts();

  if (process.platform === 'linux' || process.platform === 'win32') {
    systemTray.show();

    mainWindow.on('close', e => {
      if (mainWindow === null) {
        // this means we're quitting
        popoutWindows.closePopouts();
        return;
      }
      webContentsSend('MAIN_WINDOW_BLUR');

      // Save our app settings
      saveWindowConfig(mainWindow);

      // Quit app if that's the setting
      if (!settings.get('MINIMIZE_TO_TRAY', true)) {
        _electron.app.quit();
        return;
      }

      // Else, minimize to tray
      setWindowVisible(false);
      e.preventDefault();
    });
  }

  loadMainPage();
}

let updaterState = _Constants.UpdaterEvents.UPDATE_NOT_AVAILABLE;

function handleModuleUpdateCheckFinished(succeeded, updateCount, manualRequired) {
  if (!succeeded) {
    updaterState = _Constants.UpdaterEvents.UPDATE_NOT_AVAILABLE;
    webContentsSend(_Constants.UpdaterEvents.UPDATE_ERROR);
    return;
  }

  if (updateCount === 0) {
    updaterState = _Constants.UpdaterEvents.UPDATE_NOT_AVAILABLE;
  } else if (manualRequired) {
    updaterState = _Constants.UpdaterEvents.UPDATE_MANUALLY;
  } else {
    updaterState = _Constants.UpdaterEvents.UPDATE_AVAILABLE;
  }
  webContentsSend(updaterState);
}

function handleModuleUpdateDownloadProgress(name, progress) {
  if (mainWindow) {
    mainWindow.setProgressBar(progress);
  }
  webContentsSend(_Constants.UpdaterEvents.MODULE_INSTALL_PROGRESS, name, progress);
}

function handleModuleUpdateDownloadsFinished(succeeded, failed) {
  if (mainWindow) {
    mainWindow.setProgressBar(-1);
  }

  if (updaterState === _Constants.UpdaterEvents.UPDATE_AVAILABLE) {
    if (failed > 0) {
      updaterState = _Constants.UpdaterEvents.UPDATE_NOT_AVAILABLE;
      webContentsSend(_Constants.UpdaterEvents.UPDATE_ERROR);
    } else {
      updaterState = _Constants.UpdaterEvents.UPDATE_DOWNLOADED;
      webContentsSend(updaterState);
    }
  }
}

function handleModuleUpdateInstalledModule(name, current, total, succeeded) {
  if (mainWindow) {
    mainWindow.setProgressBar(-1);
  }
  webContentsSend(_Constants.UpdaterEvents.MODULE_INSTALLED, name, succeeded);
}

// sets up event listeners between the browser window and the app to send
// and listen to update-related events
function setupUpdaterIPC() {
  moduleUpdater.events.on(moduleUpdater.CHECKING_FOR_UPDATES, () => {
    updaterState = _Constants.UpdaterEvents.CHECKING_FOR_UPDATES;
    webContentsSend(updaterState);
  });

  // TODO(eiz): We currently still need to handle the old style non-object-based
  // updater events to allow discord_desktop_core to be newer than the host asar,
  // which contains the updater itself.
  //
  // Once all clients have updated to a sufficiently new host, we can delete this.
  if (moduleUpdater.supportsEventObjects) {
    moduleUpdater.events.on(moduleUpdater.UPDATE_CHECK_FINISHED, ({ succeeded, updateCount, manualRequired }) => {
      handleModuleUpdateCheckFinished(succeeded, updateCount, manualRequired);
    });

    moduleUpdater.events.on(moduleUpdater.DOWNLOADING_MODULE_PROGRESS, ({ name, progress }) => {
      handleModuleUpdateDownloadProgress(name, progress);
    });

    moduleUpdater.events.on(moduleUpdater.DOWNLOADING_MODULES_FINISHED, ({ succeeded, failed }) => {
      handleModuleUpdateDownloadsFinished(succeeded, failed);
    });

    moduleUpdater.events.on(moduleUpdater.INSTALLED_MODULE, ({ name, current, total, succeeded }) => {
      handleModuleUpdateInstalledModule(name, current, total, succeeded);
    });
  } else {
    moduleUpdater.events.on(moduleUpdater.UPDATE_CHECK_FINISHED, (succeeded, updateCount, manualRequired) => {
      handleModuleUpdateCheckFinished(succeeded, updateCount, manualRequired);
    });

    moduleUpdater.events.on(moduleUpdater.DOWNLOADING_MODULE_PROGRESS, (name, progress) => {
      handleModuleUpdateDownloadProgress(name, progress);
    });

    moduleUpdater.events.on(moduleUpdater.DOWNLOADING_MODULES_FINISHED, (succeeded, failed) => {
      handleModuleUpdateDownloadsFinished(succeeded, failed);
    });

    moduleUpdater.events.on(moduleUpdater.INSTALLED_MODULE, (name, current, total, succeeded) => {
      handleModuleUpdateInstalledModule(name, current, total, succeeded);
    });
  }

  _ipcMain2.default.on(_Constants.UpdaterEvents.CHECK_FOR_UPDATES, () => {
    if (updaterState === _Constants.UpdaterEvents.UPDATE_NOT_AVAILABLE) {
      moduleUpdater.checkForUpdates();
    } else {
      webContentsSend(updaterState);
    }
  });

  _ipcMain2.default.on(_Constants.UpdaterEvents.QUIT_AND_INSTALL, () => {
    saveWindowConfig(mainWindow);
    mainWindow = null;

    // TODO(eiz): This is a workaround for old Linux host versions whose host
    // updater did not have a quitAndInstall() method, which causes the module
    // updater to crash if a host update is available and we try to restart to
    // install modules. Remove when all hosts are updated.
    try {
      moduleUpdater.quitAndInstallUpdates();
    } catch (e) {
      _electron.app.relaunch();
      _electron.app.quit();
    }
  });

  _ipcMain2.default.on(_Constants.UpdaterEvents.MODULE_INSTALL, (_event, name) => {
    // NOTE: do NOT allow options to be passed in, as this enables a client to downgrade its modules to potentially
    // insecure versions.
    moduleUpdater.install(name, false);
  });

  _ipcMain2.default.on(_Constants.UpdaterEvents.MODULE_QUERY, (_event, name) => {
    webContentsSend(_Constants.UpdaterEvents.MODULE_INSTALLED, name, moduleUpdater.isInstalled(name));
  });

  _ipcMain2.default.on(_Constants.UpdaterEvents.UPDATER_HISTORY_QUERY_AND_TRUNCATE, () => {
    webContentsSend(_Constants.UpdaterEvents.UPDATER_HISTORY_RESPONSE, moduleUpdater.events.history);
    moduleUpdater.events.history = [];
  });
}

function init() {
  // electron default behavior is to app.quit here, so long as there are no other listeners. we handle quitting
  // or minimizing to system tray ourselves via mainWindow.on('closed') so this is simply to disable the electron
  // default behavior.
  _electron.app.on('window-all-closed', () => {});

  _electron.app.on('before-quit', () => {
    saveWindowConfig(mainWindow);
    mainWindow = null;
    notificationScreen.close();
  });

  // TODO: move this to main startup
  _electron.app.on('gpu-process-crashed', (e, killed) => {
    if (killed) {
      _electron.app.quit();
    }
  });

  _electron.app.on('accessibility-support-changed', (_event, accessibilitySupportEnabled) => webContentsSend('ACCESSIBILITY_SUPPORT_CHANGED', accessibilitySupportEnabled));

  _electron.app.on(_Constants.MenuEvents.OPEN_HELP, () => webContentsSend('HELP_OPEN'));
  _electron.app.on(_Constants.MenuEvents.OPEN_SETTINGS, () => webContentsSend('USER_SETTINGS_OPEN'));
  _electron.app.on(_Constants.MenuEvents.CHECK_FOR_UPDATES, () => moduleUpdater.checkForUpdates());

  _ipcMain2.default.on('SETTINGS_UPDATE_BACKGROUND_COLOR', (_event, backgroundColor) => {
    if (getBackgroundColor() !== backgroundColor) {
      setBackgroundColor(backgroundColor);
    }
  });

  setupUpdaterIPC();
  launchMainAppWindow(false);
}

function handleSingleInstance(args) {
  if (mainWindow != null) {
    const appPath = extractPathFromArgs(args);
    if (appPath != null) {
      webContentsSend('MAIN_WINDOW_PATH', appPath);
    }
    setWindowVisible(true, false);
    mainWindow.focus();
  }
}

function setMainWindowVisible(visible) {
  setWindowVisible(visible, false);
}