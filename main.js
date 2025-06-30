// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let serverProcess = null; // サーバーの子プロセスを保持する変数
let currentPort = 3000;   // 現在のポート番号
let isServerRunning = false; // サーバーが実行中かどうかのフラグ
const SECRET_KEY = process.env.SECRET_KEY || 'your-default-secret-key'; // 環境変数から取得

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // セキュリティのため推奨
      nodeIntegration: false, // セキュリティのため推奨
    },
  });

  mainWindow.loadFile('index.html');

  // 開発ツールを開く (開発時のみ)
  // mainWindow.webContents.openDevTools();

  // ウィンドウが閉じられるときにサーバープロセスを終了
  mainWindow.on('closed', () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM'); // SIGTERMで優雅に終了を試みる
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
    console.log(`Received start-server request for port: ${port}`); // これを追加
    if (isServerRunning && port === currentPort) {
      console.log("Received message from server child process:", msg); // これを追加
      const message = `Server is already running on port ${currentPort}.`;
      console.log(message);
      mainWindow.webContents.send('server-log', { message, level: 'warn' });
      return { success: true, port: currentPort, status: 'running' };
    }

    // サーバーが異なるポートで実行中の場合、まず停止を試みる
    if (isServerRunning) {
      await stopServerInternal(mainWindow);
      await new Promise(resolve => setTimeout(resolve, 1000)); // 停止を待つ
    }

    return new Promise((resolve) => {
      currentPort = parseInt(port, 10);
      if (isNaN(currentPort) || currentPort < 1024 || currentPort > 65535) {
        const error = 'Invalid port number. Please use a number between 1024 and 65535.';
        mainWindow.webContents.send('server-log', { message: error, level: 'error' });
        return resolve({ success: false, error });
      }

      const dbPath = path.join(app.getPath('userData'), 'chat-database.sqlite');
      
      serverProcess = fork(path.join(__dirname, 'server.js'), [], {
        env: { ...process.env, SECRET_KEY: SECRET_KEY }, // SECRET_KEYを環境変数として子プロセスに渡す
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'] // stdout, stderr, ipc
      });

      // 子プロセスからのメッセージをリッスン
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
        if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') { // 意図しない終了の場合
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

      // 子プロセスに起動コマンドを送信
      serverProcess.send({ command: 'start', port: currentPort, dbPath: dbPath, secretKey: SECRET_KEY });
      resolve({ success: true, port: currentPort, status: 'starting' });
    });
  });

  // サーバーの停止リクエストを処理
  ipcMain.handle('stop-server', async (event) => {
    return stopServerInternal(mainWindow);
  });

  // サーバーの現在の状態を返す
  ipcMain.handle('get-server-status', () => {
    return { isRunning: isServerRunning, port: currentPort };
  });

  // データベースパスの取得
  ipcMain.handle('get-db-path', () => {
    return path.join(app.getPath('userData'), 'chat-database.sqlite');
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

    // `exit` イベントハンドラがクリーンアップを行うので、ここではメッセージを送るだけ
    serverProcess.send({ command: 'stop' });
    
    // 子プロセスからの 'server-status' メッセージを待つためのタイムアウトを設定
    const timeout = setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL'); // 強制終了
        const message = 'Server process did not respond to stop command, forcefully terminated.';
        console.warn(message);
        mainWindow.webContents.send('server-log', { message, level: 'warn' });
        isServerRunning = false;
        serverProcess = null;
        mainWindow.webContents.send('server-status-update', { status: 'stopped', port: null });
        resolve({ success: false, error: message });
      }
    }, 5000); // 5秒後に強制終了

    serverProcess.once('message', (msg) => {
      if (msg.type === 'server-status' && msg.status === 'stopped') {
        clearTimeout(timeout);
        console.log('Server process confirmed stopped.');
        resolve({ success: true, status: 'stopped' });
      }
    });

    // forkされたプロセスが終了するまで待つ
    serverProcess.once('exit', () => {
      clearTimeout(timeout);
      console.log('Server process exited after stop command.');
      resolve({ success: true, status: 'stopped' });
    });
  });
}