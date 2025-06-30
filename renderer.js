// renderer.js
const portInput = document.getElementById('portInput');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const serverStatusSpan = document.getElementById('serverStatus');
const currentPortSpan = document.getElementById('currentPort');
const dbPathInput = document.getElementById('dbPathInput');
const browseDbPathBtn = document.getElementById('browseDbPath');
const saveDbPathBtn = document.getElementById('saveDbPath');
const displayedDbPathSpan = document.getElementById('displayedDbPath');
const logsDiv = document.getElementById('logs');

// --- ユーザーインポート関連のUI要素を追加 ---
const csvFileInput = document.getElementById('csvFileInput');
const importUsersBtn = document.getElementById('importUsersBtn');

// 起動時の初期状態を設定
async function initializeStatus() {
    const status = await window.electron.getServerStatus();
    updateStatusDisplay(status);
    portInput.value = status.port || 3000;
    dbPathInput.value = status.dbPath;
    displayedDbPathSpan.textContent = status.dbPath;
}

function updateStatusDisplay(status) {
    if (status.status === 'running') {
        serverStatusSpan.textContent = `Running`;
        serverStatusSpan.style.color = 'green';
        currentPortSpan.textContent = status.port;
        startServerBtn.disabled = true;
        stopServerBtn.disabled = false;
        portInput.disabled = true;
        dbPathInput.disabled = true;
        browseDbPathBtn.disabled = true;
        saveDbPathBtn.disabled = true;
        
        // サーバー起動中はインポートボタンを有効化
        importUsersBtn.disabled = false; 
        csvFileInput.disabled = false;
    } else {
        serverStatusSpan.textContent = `Stopped`;
        serverStatusSpan.style.color = 'red';
        currentPortSpan.textContent = 'N/A';
        startServerBtn.disabled = false;
        stopServerBtn.disabled = true;
        portInput.disabled = false;
        dbPathInput.disabled = false;
        browseDbPathBtn.disabled = false;
        saveDbPathBtn.disabled = false;

        // サーバー停止中はインポートボタンを無効化
        importUsersBtn.disabled = true;
        csvFileInput.disabled = true;
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
    logsDiv.scrollTop = logsDiv.scrollHeight;
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

browseDbPathBtn.addEventListener('click', async () => {
    const filePath = await window.electron.openFileDialog();
    if (filePath) {
        dbPathInput.value = filePath;
        appendLog({ type: 'server-log', message: `Selected database path: ${filePath}`, level: 'info' });
    }
});

saveDbPathBtn.addEventListener('click', async () => {
    const newPath = dbPathInput.value.trim();
    if (newPath) {
        appendLog({ type: 'server-log', message: `Saving new database path: ${newPath}...`, level: 'info' });
        const result = await window.electron.setDbPath(newPath);
        if (result.success) {
            displayedDbPathSpan.textContent = result.dbPath;
            appendLog({ type: 'server-log', message: `Database path successfully saved: ${result.dbPath}`, level: 'info' });
        } else {
            appendLog({ type: 'server-log', message: `Failed to save database path.`, level: 'error' });
        }
    } else {
        appendLog({ type: 'server-log', message: 'Database path cannot be empty.', level: 'warn' });
    }
});

// --- ユーザーインポートボタンのイベントリスナーを追加 ---
importUsersBtn.addEventListener('click', async () => {
    const file = csvFileInput.files[0];
    if (!file) {
        appendLog({ type: 'server-log', message: 'Please select a CSV file.', level: 'warn' });
        return;
    }

    if (file.type !== 'text/csv') {
        appendLog({ type: 'server-log', message: 'Selected file is not a CSV. Please select a .csv file.', level: 'warn' });
        return;
    }

    // サーバーが起動しているか確認
    const status = await window.electron.getServerStatus();
    if (!status.isRunning) {
        appendLog({ type: 'server-log', message: 'Server is not running. Please start the server before importing users.', level: 'error' });
        return;
    }

    appendLog({ type: 'server-log', message: `Importing users from ${file.name}...`, level: 'info' });
    importUsersBtn.disabled = true; // 多重クリック防止
    csvFileInput.disabled = true;

    const formData = new FormData();
    formData.append('usersCsv', file); // サーバー側の `upload.single('usersCsv')` に対応

    try {
        const response = await fetch(`http://localhost:${status.port}/import-users-csv`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (response.ok) {
            appendLog({ type: 'server-log', message: `User import successful: ${data.message}`, level: 'info' });
            if (data.errors && data.errors.length > 0) {
                data.errors.forEach(err => appendLog({ type: 'server-log', message: `Import Warning/Error: ${err}`, level: 'warn' }));
            }
        } else {
            appendLog({ type: 'server-log', message: `User import failed: ${data.error || response.statusText}`, level: 'error' });
            if (data.errors && data.errors.length > 0) {
                data.errors.forEach(err => appendLog({ type: 'server-log', message: `Import Details: ${err}`, level: 'error' }));
            }
        }
    } catch (error) {
        appendLog({ type: 'server-log', message: `Network or server error during import: ${error.message}`, level: 'error' });
    } finally {
        importUsersBtn.disabled = false; // ボタンを再有効化
        csvFileInput.disabled = false;
        csvFileInput.value = ''; // ファイル選択をクリア
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