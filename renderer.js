// renderer.js
const portInput = document.getElementById('portInput');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const serverStatusSpan = document.getElementById('serverStatus');
const currentPortSpan = document.getElementById('currentPort');
const dbPathSpan = document.getElementById('dbPath');
const logsDiv = document.getElementById('logs');

// 起動時の初期状態を設定
async function initializeStatus() {
    const status = await window.electron.getServerStatus();
    updateStatusDisplay(status);
    const dbPath = await window.electron.getDbPath();
    dbPathSpan.textContent = dbPath;
}

function updateStatusDisplay(status) {
    // ここを修正：status.isRunning ではなく status.status === 'running' をチェック
    if (status.status === 'running') {
        serverStatusSpan.textContent = `Running`;
        serverStatusSpan.style.color = 'green';
        currentPortSpan.textContent = status.port;
        startServerBtn.disabled = true;
        stopServerBtn.disabled = false;
        portInput.disabled = true;
    } else {
        serverStatusSpan.textContent = `Stopped`;
        serverStatusSpan.style.color = 'red';
        currentPortSpan.textContent = 'N/A';
        startServerBtn.disabled = false;
        stopServerBtn.disabled = true;
        portInput.disabled = false;
    }
}

function appendLog(log) {
    const logEntry = document.createElement('div');
    let levelClass = '';
    switch (log.level) {
        case 'info':
            levelClass = 'log-info';
            break;
        case 'warn':
            levelClass = 'log-warn';
            break;
        case 'error':
            levelClass = 'log-error';
            break;
        case 'fatal':
            levelClass = 'log-fatal';
            break;
        default:
            levelClass = '';
    }
    logEntry.classList.add('log-entry', levelClass);
    logEntry.textContent = `[${log.level.toUpperCase()}] ${log.message}`;
    logsDiv.appendChild(logEntry);
    logsDiv.scrollTop = logsDiv.scrollHeight; // スクロールを一番下へ
}

startServerBtn.addEventListener('click', async () => {
    const port = parseInt(portInput.value, 10);
    appendLog({ type: 'server-log', message: `Attempting to start server on port ${port}...`, level: 'info' });
    const result = await window.electron.startServer(port);
    if (!result.success) {
        appendLog({ type: 'server-log', message: `Failed to start server: ${result.error}`, level: 'error' });
    }
    // ステータス更新はIPCリスナーで処理される
});

stopServerBtn.addEventListener('click', async () => {
    appendLog({ type: 'server-log', message: 'Attempting to stop server...', level: 'info' });
    await window.electron.stopServer();
    // ステータス更新はIPCリスナーで処理される
});

// メインプロセスからのステータス更新を受信
window.electron.onServerStatusUpdate((status) => {
    updateStatusDisplay(status);
    appendLog({ type: 'server-log', message: `Server status updated to: ${status.status} ${status.port ? 'on port ' + status.port : ''}${status.error ? ' (Error: ' + status.error + ')' : ''}`, level: 'info' });
});

// メインプロセスからのサーバーログを受信
window.electron.onServerLog((log) => {
    appendLog(log);
});

// アプリケーション起動時に初期ステータスを取得
initializeStatus();