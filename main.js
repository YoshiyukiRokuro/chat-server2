// main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { startServer, stopServer } = require("./server.js");

let mainWindow;
let currentPort = 3001;
let isServerRunning = false;

const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
let appSettings = {
  port: 3001,
  dbPath: path.join(app.getPath("userData"), "chat-database.sqlite"),
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, "utf8");
      appSettings = { ...appSettings, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(appSettings, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

function logToServerWindow(message, level = "info") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("server-log", { message, level });
  }
  const logFunc = level === "error" ? console.error : console.log;
  logFunc(`[Server Log] ${message}`);
}

function updateServerStatus(status, port, error = null) {
  isServerRunning = status === "running";
  currentPort = port;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("server-status-update", { status, port, error });
  }
}

function createWindow() {
  loadSettings();
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", async (event) => {
  event.preventDefault();
  try {
    await stopServer();
  } finally {
    app.exit();
  }
});

ipcMain.handle("start-server", async (event, port) => {
  if (isServerRunning) {
    return { success: true, port: currentPort, status: "running" };
  }
  appSettings.port = port;
  saveSettings();
  try {
    await startServer(appSettings.port, appSettings.dbPath, logToServerWindow);
    updateServerStatus("running", appSettings.port);
    return { success: true, port: appSettings.port, status: "running" };
  } catch (error) {
    updateServerStatus("stopped", null, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("stop-server", async () => {
  if (!isServerRunning) {
    return { success: true, status: "stopped" };
  }
  try {
    await stopServer();
    updateServerStatus("stopped", null);
    return { success: true, status: "stopped" };
  } catch (error) {
    updateServerStatus("stopped", null, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-server-status", () => ({
    isRunning: isServerRunning,
    port: isServerRunning ? currentPort : appSettings.port,
    dbPath: appSettings.dbPath,
}));

ipcMain.handle("set-db-path", async (event, newPath) => {
  appSettings.dbPath = newPath;
  saveSettings();
  return { success: true, dbPath: appSettings.dbPath };
});

ipcMain.handle("open-file-dialog", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "SQLite Database", extensions: ["sqlite", "db"] }],
  });
  return canceled ? null : filePaths[0];
});