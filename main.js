// main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
// ★★★ server.jsから関数を直接インポート ★★★
const { startServer, stopServer } = require("./server.js");

let mainWindow;
let currentPort = 3001; // ポート番号のデフォルト値
let isServerRunning = false;

// --- 設定ファイルのパスとデフォルト値 ---
const settingsFilePath = path.join(app.getPath("userData"), "settings.json");
let appSettings = {
  port: 3001,
  dbPath: path.join(app.getPath("userData"), "chat-database.sqlite"),
};

// --- 設定の読み込み/保存関数 ---
function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, "utf8");
      const loadedSettings = JSON.parse(data);
      appSettings = { ...appSettings, ...loadedSettings };
      console.log("Settings loaded:", appSettings);
    }
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(
      settingsFilePath,
      JSON.stringify(appSettings, null, 2),
      "utf8"
    );
    console.log("Settings saved:", appSettings);
  } catch (error) {
    console.error("Failed to save settings:", error);
    dialog.showErrorBox(
      "設定保存エラー",
      `設定の保存に失敗しました: ${error.message}`
    );
  }
}

// --- サーバーログをウィンドウに送信する関数 ---
function logToServerWindow(message, level = "info") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("server-log", { message, level });
  }
  const logFunc =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : console.log;
  logFunc(`[Server Log] ${message}`);
}

// --- サーバーステータスをウィンドウに送信する関数 ---
function updateServerStatus(status, port, error = null) {
  isServerRunning = status === "running";
  currentPort = port;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("server-status-update", {
      status,
      port,
      error,
    });
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
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ★★★ アプリケーション終了時にサーバーを停止 ★★★
app.on("will-quit", async (event) => {
  event.preventDefault(); // 即時終了を一旦キャンセル
  logToServerWindow("Application quitting, stopping server...");
  try {
    await stopServer();
    logToServerWindow("Server stopped cleanly.");
  } catch (e) {
    logToServerWindow(`Error stopping server on quit: ${e.message}`, "error");
  }
  app.exit(); // サーバー停止後にアプリを終了
});

// --- IPCハンドラ (ここからがメインの修正) ---

ipcMain.handle("start-server", async (event, port) => {
  logToServerWindow(`IPC: Received start-server request on port ${port}`);
  if (isServerRunning) {
    logToServerWindow(
      `IPC: Server is already running on port ${currentPort}.`,
      "warn"
    );
    return { success: true, port: currentPort, status: "running" };
  }

  appSettings.port = port;
  saveSettings();

  try {
    // ★★★ server.js の startServer を直接呼び出す ★★★
    await startServer(appSettings.port, appSettings.dbPath, logToServerWindow);
    updateServerStatus("running", appSettings.port);
    logToServerWindow(
      `IPC: Server started successfully on port ${appSettings.port}`
    );
    return { success: true, port: appSettings.port, status: "running" };
  } catch (error) {
    logToServerWindow(`IPC: Failed to start server: ${error.message}`, "error");
    updateServerStatus("stopped", null, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("stop-server", async () => {
  logToServerWindow("IPC: Received stop-server request");
  if (!isServerRunning) {
    logToServerWindow("IPC: Server is not running.", "warn");
    return { success: true, status: "stopped" };
  }

  try {
    // ★★★ server.js の stopServer を直接呼び出す ★★★
    await stopServer();
    updateServerStatus("stopped", null);
    logToServerWindow("IPC: Server stopped successfully.");
    return { success: true, status: "stopped" };
  } catch (error) {
    logToServerWindow(`IPC: Error stopping server: ${error.message}`, "error");
    // 状態が不明確になるため、エラーが出ても停止扱いにする
    updateServerStatus("stopped", null, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-server-status", () => {
  return {
    isRunning: isServerRunning,
    port: isServerRunning ? currentPort : appSettings.port, // 停止中でも設定値を返す
    dbPath: appSettings.dbPath,
  };
});

ipcMain.handle("set-db-path", async (event, newPath) => {
  appSettings.dbPath = newPath;
  saveSettings();
  if (isServerRunning) {
    logToServerWindow(
      "Database path changed. Please restart the server for changes to take effect.",
      "warn"
    );
  }
  return { success: true, dbPath: appSettings.dbPath };
});

ipcMain.handle("open-file-dialog", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "SQLite Database", extensions: ["sqlite", "db", "sqlite3"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return canceled ? null : filePaths[0];
});
