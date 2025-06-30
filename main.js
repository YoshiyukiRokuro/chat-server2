// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs'); // fsモジュールを追加

let serverProcess = null;
let currentPort = 3001;
let isServerRunning = false;
const SECRET_KEY = process.env.SECRET_KEY || 'your-default-secret-key';

// --- 設定ファイルのパスとデフォルト値 ---
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');

let appSettings = {
  port: 3001,
  dbPath: path.join(app.getPath('userData'), 'chat-database.sqlite')
};

// --- 設定の読み込み/保存関数 ---
function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, 'utf8');
      const loadedSettings = JSON.parse(data);
      // 既存の設定にロードした設定をマージ（デフォルト値を保持しつつ）
      appSettings = { ...appSettings, ...loadedSettings };
      // データベースパスが設定されていない場合はデフォルトに戻す
      if (!appSettings.dbPath) {
        appSettings.dbPath = path.join(app.getPath('userData'), 'chat-database.sqlite');
      }
      // ポートが設定されていない場合はデフォルトに戻す
      if (!appSettings.port) {
        appSettings.port = 3001;
      }
      console.log('Settings loaded:', appSettings);
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
    // ロードに失敗してもデフォルト設定で続行
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(appSettings, null, 2), 'utf8');
    console.log('Settings saved:', appSettings);
  } catch (error) {
    console.error('Failed to save settings:', error);
    dialog.showErrorBox('設定保存エラー', `設定の保存に失敗しました: ${error.message}`);
  }
}

function createWindow() {
  loadSettings(); // ウィンドウ作成時に設定を読み込む

  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // mainWindow.webContents.openDevTools(); // 開発時のみ有効にする

  mainWindow.on('closed', () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      serverProcess = null;
      isServerRunning = false;
      console.log('Server process terminated due to window close.');
    }
  });

  return mainWindow;
}

app.whenReady().then(() => {
  const mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // サーバーの起動リクエストを処理
  ipcMain.handle('start-server', async (event, port) => {
    // 起動前にポート設定を更新して保存
    appSettings.port = port;
    saveSettings();

    if (isServerRunning && port === currentPort) {
      const message = `Server is already running on port ${currentPort}.`;
      console.log(message);
      mainWindow.webContents.send('server-log', { message, level: 'warn' });
      return { success: true, port: currentPort, status: 'running' };
    }

    if (isServerRunning) {
      await stopServerInternal(mainWindow);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return new Promise((resolve) => {
      currentPort = parseInt(port, 10);
      if (isNaN(currentPort) || currentPort < 1024 || currentPort > 65535) {
        const error = 'Invalid port number. Please use a number between 1024 and 65535.';
        mainWindow.webContents.send('server-log', { message: error, level: 'error' });
        return resolve({ success: false, error });
      }

      // サーバープロセスに渡すdbPathは現在の設定値を使用
      const dbPathToUse = appSettings.dbPath; 
      
      serverProcess = fork(path.join(__dirname, 'server.js'), [], {
        env: { ...process.env, SECRET_KEY: SECRET_KEY },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      serverProcess.on('message', (msg) => {
        if (msg.type === 'server-status') {
          isServerRunning = (msg.status === 'running');
          currentPort = msg.port;
          mainWindow.webContents.send('server-status-update', { status: msg.status, port: msg.port, error: msg.error });
        } else if (msg.type === 'server-log') {
          mainWindow.webContents.send('server-log', msg);
        }
      });

      serverProcess.on('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
          const errorMessage = `Server process exited with code ${code} and signal ${signal}`;
          mainWindow.webContents.send('server-log', { message: errorMessage, level: 'error' });
          dialog.showErrorBox('サーバーエラー', errorMessage);
        }
        isServerRunning = false;
        mainWindow.webContents.send('server-status-update', { status: 'stopped', port: null });
        serverProcess = null;
        console.log(`Server process exited with code ${code} and signal ${signal}`);
      });

      serverProcess.on('error', (err) => {
        const errorMessage = `Failed to start server process: ${err.message}`;
        mainWindow.webContents.send('server-log', { message: errorMessage, level: 'error' });
        mainWindow.webContents.send('server-status-update', { status: 'stopped', port: null });
        dialog.showErrorBox('起動エラー', errorMessage);
        isServerRunning = false;
        serverProcess = null;
        console.error('Failed to start server process:', err);
        resolve({ success: false, error: errorMessage });
      });

      // 子プロセスに起動コマンドを送信。データベースパスも渡す
      serverProcess.send({ command: 'start', port: currentPort, dbPath: dbPathToUse, secretKey: SECRET_KEY });
      resolve({ success: true, port: currentPort, status: 'starting' });
    });
  });

  // サーバーの停止リクエストを処理
  ipcMain.handle('stop-server', async (event) => {
    return stopServerInternal(mainWindow);
  });

  // サーバーの現在の状態を返す
  ipcMain.handle('get-server-status', () => {
    return { isRunning: isServerRunning, port: currentPort, dbPath: appSettings.dbPath }; // dbPathも返す
  });

  // 【追加】データベースパスを変更するIPCハンドラ
  ipcMain.handle('set-db-path', async (event, newPath) => {
    appSettings.dbPath = newPath;
    saveSettings();
    // サーバーが実行中の場合は、一旦停止して再起動を促す、または警告を出す
    if (isServerRunning) {
      mainWindow.webContents.send('server-log', {
        message: 'Database path changed. Please stop and restart the server for changes to take effect.',
        level: 'warn'
      });
    }
    return { success: true, dbPath: appSettings.dbPath };
  });

  // 【追加】ファイル選択ダイアログを表示するIPCハンドラ
  ipcMain.handle('open-file-dialog', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'], // ファイルを選択可能
      filters: [
        { name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled) {
      return null;
    } else {
      return filePaths[0]; // 選択されたパスの最初のものを返す
    }
  });

});

// アプリケーションが閉じられたときにクリーンアップ
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      serverProcess = null;
      isServerRunning = false;
      console.log('Server process terminated due to app close (window-all-closed).');
    }
    app.quit();
  }
});

// サーバー停止の内部ロジック
async function stopServerInternal(mainWindow) {
  return new Promise((resolve) => {
    if (!serverProcess) {
      const message = 'Server is not running.';
      console.log(message);
      mainWindow.webContents.send('server-log', { message, level: 'warn' });
      return resolve({ success: true, status: 'stopped' });
    }

    serverProcess.send({ command: 'stop' });
    
    const timeout = setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL');
        const message = 'Server process did not respond to stop command, forcefully terminated.';
        console.warn(message);
        mainWindow.webContents.send('server-log', { message, level: 'warn' });
        isServerRunning = false;
        serverProcess = null;
        mainWindow.webContents.send('server-status-update', { status: 'stopped', port: null });
        resolve({ success: false, error: message });
      }
    }, 5000);

    serverProcess.once('message', (msg) => {
      if (msg.type === 'server-status' && msg.status === 'stopped') {
        clearTimeout(timeout);
        console.log('Server process confirmed stopped.');
        resolve({ success: true, status: 'stopped' });
      }
    });

    serverProcess.once('exit', () => {
      clearTimeout(timeout);
      console.log('Server process exited after stop command.');
      resolve({ success: true, status: 'stopped' });
    });
  });
}