// renderer.js
const portInput = document.getElementById('portInput');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const serverStatusSpan = document.getElementById('serverStatus');
const currentPortSpan = document.getElementById('currentPort');
const dbPathInput = document.getElementById('dbPathInput'); // 追加
const browseDbPathBtn = document.getElementById('browseDbPath'); // 追加
const saveDbPathBtn = document.getElementById('saveDbPath'); // 追加
const displayedDbPathSpan = document.getElementById('displayedDbPath'); // IDを変更
const logsDiv = document.getElementById('logs');

// 起動時の初期状態を設定
async function initializeStatus() {
    const status = await window.electron.getServerStatus();
    updateStatusDisplay(status);
    // 初期設定値としてポートとDBパスをUIに反映
    portInput.value = status.port || 3000; // ポートの初期値
    dbPathInput.value = status.dbPath; // 入力フィールドにDBパスをセット
    displayedDbPathSpan.textContent = status.dbPath; // 表示用UIにDBパスをセット
}

function updateStatusDisplay(status) {
    if (status.status === 'running') {
        serverStatusSpan.textContent = `Running`;
        serverStatusSpan.style.color = 'green';
        currentPortSpan.textContent = status.port;
        startServerBtn.disabled = true;
        stopServerBtn.disabled = false;
        portInput.disabled = true;
        dbPathInput.disabled = true; // サーバー実行中はDBパスも変更不可に
        browseDbPathBtn.disabled = true;
        saveDbPathBtn.disabled = true;
    } else {
        serverStatusSpan.textContent = `Stopped`;
        serverStatusSpan.style.color = 'red';
        currentPortSpan.textContent = 'N/A';
        startServerBtn.disabled = false;
        stopServerBtn.disabled = true;
        portInput.disabled = false;
        dbPathInput.disabled = false; // サーバー停止中はDBパス変更可能に
        browseDbPathBtn.disabled = false;
        saveDbPathBtn.disabled = false;
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
});

stopServerBtn.addEventListener('click', async () => {
    appendLog({ type: 'server-log', message: 'Attempting to stop server...', level: 'info' });
    await window.electron.stopServer();
});

// 【追加】参照ボタンのイベントリスナー
browseDbPathBtn.addEventListener('click', async () => {
    const filePath = await window.electron.openFileDialog();
    if (filePath) {
        dbPathInput.value = filePath;
        appendLog({ type: 'server-log', message: `Selected database path: ${filePath}`, level: 'info' });
    }
});

// 【追加】保存ボタンのイベントリスナー
saveDbPathBtn.addEventListener('click', async () => {
    const newPath = dbPathInput.value.trim();
    if (newPath) {
        appendLog({ type: 'server-log', message: `Saving new database path: ${newPath}...`, level: 'info' });
        const result = await window.electron.setDbPath(newPath);
        if (result.success) {
            displayedDbPathSpan.textContent = result.dbPath; // 表示用UIを更新
            appendLog({ type: 'server-log', message: `Database path successfully saved: ${result.dbPath}`, level: 'info' });
        } else {
            appendLog({ type: 'server-log', message: `Failed to save database path.`, level: 'error' });
        }
    } else {
        appendLog({ type: 'server-log', message: 'Database path cannot be empty.', level: 'warn' });
    }
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