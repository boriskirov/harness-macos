const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");

const APP_URL = "https://chat.mistral.ai";
const TITLE_PREFIX = "Harness"; // window title = "Mistral AI - {current page}"
const MAX_RECENTS = 4;

// Keep references alive to avoid garbage collection on macOS
let mainWindow = null;
let tray = null;

// ---------- Recent chats (local history) ----------
const RECENTS_FILE = path.join(app.getPath("userData"), "recent-chats.json");

let recents = [];
try {
  recents = JSON.parse(fs.readFileSync(RECENTS_FILE, "utf8"));
} catch {
  recents = [];
}

function saveRecents() {
  try {
    fs.writeFileSync(
      RECENTS_FILE,
      JSON.stringify(recents.slice(0, MAX_RECENTS)),
    );
  } catch {}
}

function isChatUrl(url) {
  if (!url.startsWith("https://chat.mistral.ai/")) return false;
  // Root / new-chat pages are not conversations
  const p = url.replace("https://chat.mistral.ai", "").split(/[?#]/)[0];
  return p.length > 1 && !p.startsWith("/new");
}

function labelForUrl(url) {
  const entry = recents.find((r) => r.url === url);
  return entry && entry.title
    ? entry.title
    : `Chat ${new Date().toLocaleDateString()}`;
}

function recordVisit(url, title) {
  if (!isChatUrl(url)) return;
  const prevLabel = labelForUrl(url);
  const cleanTitle = (title || "").replace(/\s*[-–|]\s*Mistral.*$/i, "").trim();
  recents = recents.filter((r) => r.url !== url); // move to top
  recents.unshift({ url, title: cleanTitle || prevLabel });
  recents = recents.slice(0, MAX_RECENTS);
  saveRecents();
  refreshTray();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    title: TITLE_PREFIX,
    backgroundColor: "#0F1117",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Persistent partition keeps your Vibe login session across restarts
      partition: "persist:vibe",
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Dynamic title: "Mistral Vibe AI - {current page}"
  // Take the page title from Mistral, strip their branding suffix, add our prefix
  mainWindow.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const clean = (title || "")
      .replace(/\s*[-–|]\s*(Mistral|Vibe).*$/i, "")
      .trim();
    mainWindow.setTitle(clean ? `${TITLE_PREFIX} - ${clean}` : TITLE_PREFIX);
  });

  // Login and any Mistral-owned page must stay INSIDE the app window.
  // Only send genuinely foreign links (docs, privacy policy, downloads) to the browser.
  const INTERNAL_DOMAINS = ["mistral.ai"];
  const isInternal = (url) => {
    try {
      const host = new URL(url).hostname;
      return INTERNAL_DOMAINS.some((d) => host === d || host.endsWith("." + d));
    } catch {
      return false;
    }
  };

  const handleRedirect = (event, url) => {
    if (isInternal(url)) return; // let it navigate inside the window
    event.preventDefault();
    shell.openExternal(url);
  };
  mainWindow.webContents.on("will-navigate", handleRedirect);

  // Same rule for new windows: Mistral/SSO windows open in-app (sharing the
  // session via the same partition), everything else goes to the browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          webPreferences: { partition: "persist:vibe", sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Track visited conversations for the tray's "Recent chats" menu
  mainWindow.webContents.on("did-navigate", (_e, url) => recordVisit(url, ""));
  mainWindow.webContents.on("did-navigate-in-page", (_e, url) =>
    recordVisit(url, ""),
  );
  // Try to capture a nicer label from the page title
  mainWindow.webContents.on("page-title-updated", (_e, title) => {
    const url = mainWindow.webContents.getURL();
    if (isChatUrl(url)) recordVisit(url, title);
  });

  // macOS habit: hide instead of close so the session stays warm
  mainWindow.on("close", (event) => {
    if (app.quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function toggleWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function refreshTray() {
  if (!tray) return;
  const recentItems = recents.slice(0, MAX_RECENTS).map((r) => ({
    label: `•  ${r.title}`,
    click: () => {
      if (!mainWindow) createWindow();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.loadURL(r.url);
    },
  }));

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Harness", click: toggleWindow },
      { type: "separator" },
      {
        label: "Recent chats",
        enabled: recentItems.length > 0,
        submenu: recentItems.length
          ? recentItems
          : [{ label: "No chats yet", enabled: false }],
      },
      ...(recentItems.length ? [{ type: "separator" }] : []),
      {
        label: "Clear recent chats",
        enabled: recents.length > 0,
        click: () => {
          recents = [];
          saveRecents();
          refreshTray();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  // Filename ending in "Template.png" makes macOS render it as a
  // monochrome menu-bar glyph (black in light mode, white in dark mode)
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "trayTemplate.png"),
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(TITLE_PREFIX);
  refreshTray();
  tray.on("click", toggleWindow);
}

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(
      path.join(__dirname, "build", "icon.png"),
    );

    console.log("Dock icon path:", path.join(__dirname, "build", "icon.png"));
    console.log("Dock icon empty:", dockIcon.isEmpty());

    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  createWindow();
  createTray();

  globalShortcut.register("CommandOrControl+Shift+M", toggleWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else toggleWindow();
  });
});

app.on("before-quit", () => {
  app.quitting = true;
  globalShortcut.unregisterAll();
});

// Keep running in the background when all windows are closed (macOS convention)
app.on("window-all-closed", () => {});
