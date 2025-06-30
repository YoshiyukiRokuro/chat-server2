// server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const multer = require('multer'); // --- 追加 ---
const csv = require('csv-parser'); // --- 追加 ---
const { Readable } = require('stream'); // --- 追加 ---

let server = null; // HTTPサーバーインスタンスを保持
let wss = null;    // WebSocketサーバーインスタンスを保持
let db = null;     // データベースインスタンスを保持

const onlineUsers = new Map();

// --- 定数 ---
const BCRYPT_SALT_ROUNDS = 12;
let SECRET_KEY = process.env.SECRET_KEY || 'your-default-secret-key'; 

// --- Multer設定 ---
const upload = multer({ storage: multer.memoryStorage() }); // CSVファイルをメモリに一時保存

// --- データベース設定関数 ---
function initializeDatabase(dbPath, callback) {
  _initDb();

  function _initDb() {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        if (process.send) process.send({ type: 'server-log', message: `Database opening error: ${err.message}`, level: 'error' });
        console.error('Database opening error: ', err);
        return callback(err);
      }
      if (process.send) process.send({ type: 'server-log', message: 'Database connected!', level: 'info' });
      console.log('Database connected!');
      db.run('PRAGMA foreign_keys = ON;', (pragmaErr) => {
        if (pragmaErr) {
          if (process.send) process.send({ type: 'server-log', message: `PRAGMA foreign_keys error: ${pragmaErr.message}`, level: 'error' });
          console.error('PRAGMA foreign_keys error:', pragmaErr);
        }
        db.serialize(() => {
          db.run(`
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY,
              username TEXT NOT NULL,
              password TEXT NOT NULL
            )
          `);

          db.run(`
            CREATE TABLE IF NOT EXISTS channels (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              is_deletable BOOLEAN DEFAULT 1
            )
          `);

          db.run(`
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              channelId INTEGER,
              user TEXT,
              text TEXT,
              timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
              replyToId INTEGER,
              FOREIGN KEY(channelId) REFERENCES channels(id) ON DELETE CASCADE,
              FOREIGN KEY(replyToId) REFERENCES messages(id) ON DELETE SET NULL
            )
          `);

          db.run(`
            CREATE TABLE IF NOT EXISTS read_receipts (
              user_id INTEGER NOT NULL,
              channel_id INTEGER NOT NULL,
              last_read_message_id INTEGER NOT NULL,
              PRIMARY KEY (user_id, channel_id),
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
            )
          `);

          const fixedChannels = ['連絡', '雑談'];
          fixedChannels.forEach(name => {
            db.run('INSERT OR IGNORE INTO channels (name, is_deletable) VALUES (?, 0)', [name]);
          });
          callback(null); // データベース初期化完了
        });
      });
    });
  }
}

// --- WebSocket 通信 ---
function setupWebSocketServer() {
  if (wss) wss.close(() => { console.log('Previous WebSocket server closed.'); });
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const parameters = new URL(req.url, `ws://${req.headers.host}`).searchParams;
    const token = parameters.get('token');

    if (!token) return ws.close(1008, "Token not provided");

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
      if (err) return ws.close(1008, "Invalid token");
      
      const username = decoded.username;
      onlineUsers.set(username, ws);
      broadcastOnlineUsers();

      ws.on('close', () => {
        onlineUsers.delete(username);
        broadcastOnlineUsers();
      });
      ws.on('error', (error) => {
        if (process.send) process.send({ type: 'server-log', message: `WebSocket error for user ${username}: ${error.message}`, level: 'error' });
        console.error(`WebSocket error for user ${username}:`, error);
      });
    });
  });

  wss.on('error', (error) => {
    if (process.send) process.send({ type: 'server-log', message: `WebSocket server error: ${error.message}`, level: 'error' });
    console.error('WebSocket server error:', error);
  });
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

function broadcastOnlineUsers() {
  const userList = Array.from(onlineUsers.keys());
  broadcast({ type: 'user_list_update', data: userList });
}

// --- 認証ミドルウェア ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// --- APIエンドポイント設定関数 ---
function setupApiEndpoints(app) {
  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  // ユーザー登録 (既存)
  app.post('/register', async (req, res) => {
    const { id, username, password } = req.body;

    if (!id || !username || !password) {
      return res.status(400).json({ error: '職員ID、名前、パスワードは必須です' });
    }
    if (!/^\d{1,5}$/.test(id)) {
      return res.status(400).json({ error: '職員IDは1～5桁の数字で入力してください。' });
    }

    try {
      const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const stmt = db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)');
      stmt.run(id, username, hashedPassword, function (err) {
        if (err) {
          if (err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: 'その職員IDは既に使用されています。' });
          }
          if (process.send) process.send({ type: 'server-log', message: `Registration error: ${err.message}`, level: 'error' });
          return res.status(500).json({ error: '登録中にサーバーエラーが発生しました' });
        }
        res.status(201).json({ message: '登録が完了しました。' });
      });
      stmt.finalize();
    } catch (error) {
      if (process.send) process.send({ type: 'server-log', message: `Registration processing error: ${error.message}`, level: 'error' });
      console.error(error);
      res.status(500).json({ error: '登録処理でサーバーエラーが発生しました' });
    }
  });

  // ログイン (既存)
  app.post('/login', (req, res) => {
    const { id, password } = req.body;
    if (!id || !password) {
      return res.status(400).json({ error: '職員IDとパスワードは必須です' });
    }

    db.get('SELECT * FROM users WHERE id = ?', [id], async (err, user) => {
      if (err) {
        if (process.send) process.send({ type: 'server-log', message: `Login DB error: ${err.message}`, level: 'error' });
        return res.status(500).json({ error: err.message });
      }
      if (!user) {
        return res.status(401).json({ error: '職員IDまたはパスワードが無効です' });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: '職員IDまたはパスワードが無効です' });
      }
      
      const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });

      res.json({
        message: 'Login successful',
        user: { id: user.id, username: user.username },
        token: token
      });
    });
  });

  // --- 新しいエンドポイント: CSVからのユーザー登録 ---
  app.post('/import-users-csv', upload.single('usersCsv'), async (req, res) => {

    if (!req.file || req.file.mimetype !== 'text/csv') {
      return res.status(400).json({ error: 'CSVファイルが必要です' });
    }

    const users = [];
    const importErrors = [];
    let processedCount = 0;
    let successCount = 0;
    let duplicateCount = 0;
    let invalidDataCount = 0;

    // Readable.from() を使用してBufferからストリームを作成
    const csvStream = Readable.from(req.file.buffer.toString('utf8'));

    csvStream
      .pipe(csv({
        headers: ['id', 'username', 'password'], // CSVのヘッダーを明示的に指定
        skipHeaders: true, // もしCSVファイルにヘッダー行がない場合、falseに設定
        strict: true // ヘッダーと行の列数が一致しない場合にエラーを発生させる
      }))
      .on('data', (row) => {
        // パースされた行をユーザーリストに追加
        users.push(row);
      })
      .on('end', async () => {
        if (process.send) process.send({ type: 'server-log', message: `CSV data parsed. Found ${users.length} users. Starting import...`, level: 'info' });
        console.log(`CSV data parsed. Found ${users.length} users. Starting import...`);

        // データベーストランザクションを開始
        db.serialize(async () => {
          db.run('BEGIN TRANSACTION;');
          const stmt = db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)');

          for (const user of users) {
            processedCount++;
            const { id, username, password } = user;

            // データ検証
            if (!id || !username || !password || !/^\d{1,5}$/.test(id)) {
              importErrors.push(`Row ${processedCount}: Invalid data (ID: ${id || 'N/A'}, Username: ${username || 'N/A'}). ID must be 1-5 digits.`);
              invalidDataCount++;
              continue;
            }

            try {
              const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
              // Promise based run to await db operations in loop
              await new Promise((resolve, reject) => {
                stmt.run(id, username, hashedPassword, function (err) {
                  if (err) {
                    if (err.code === 'SQLITE_CONSTRAINT') {
                      importErrors.push(`Row ${processedCount}: User with ID ${id} already exists.`);
                      duplicateCount++;
                    } else {
                      importErrors.push(`Row ${processedCount}: Database error for ID ${id}: ${err.message}`);
                    }
                    return reject(err); // reject to catch in outer try/catch
                  }
                  successCount++;
                  resolve();
                });
              });
            } catch (error) {
                // Error handled by the promise reject, continue loop for next user
                // The specific error is already pushed to importErrors
            }
          }

          stmt.finalize();

          // トランザクションをコミットまたはロールバック
          if (importErrors.length > 0) {
            db.run('ROLLBACK;');
            if (process.send) process.send({ type: 'server-log', message: 'Import completed with errors. Transaction rolled back.', level: 'warn' });
            console.warn('Import completed with errors. Transaction rolled back.');
            return res.status(200).json({
              message: `Users import finished with ${successCount} successful, ${duplicateCount} duplicates, ${invalidDataCount} invalid, ${importErrors.length - duplicateCount - invalidDataCount} other errors.`,
              errors: importErrors
            });
          } else {
            db.run('COMMIT;');
            if (process.send) process.send({ type: 'server-log', message: `Successfully imported ${successCount} users.`, level: 'info' });
            console.log(`Successfully imported ${successCount} users.`);
            return res.status(201).json({ message: `Successfully imported ${successCount} users.` });
          }
        });
      })
      .on('error', (error) => {
        if (process.send) process.send({ type: 'server-log', message: `CSV parsing error: ${error.message}`, level: 'error' });
        console.error('CSV parsing error:', error);
        res.status(500).json({ error: `CSVファイルの処理中にエラーが発生しました: ${error.message}` });
      });
  });
  // --- 新しいエンドポイントここまで ---


  app.get('/channels', authenticateToken, (req, res) => {
    db.all('SELECT id, name, is_deletable FROM channels ORDER BY id ASC', [], (err, rows) => {
      if (err) {
        if (process.send) process.send({ type: 'server-log', message: `Channels DB error: ${err.message}`, level: 'error' });
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  app.post('/channels', authenticateToken, (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'チャンネル名は必須です' });
    }
    const stmt = db.prepare('INSERT INTO channels (name) VALUES (?)');
    stmt.run(name.trim(), function (err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: 'そのチャンネル名はすでに存在します' });
        if (process.send) process.send({ type: 'server-log', message: `Channel creation error: ${err.message}`, level: 'error' });
        return res.status(500).json({ error: 'チャンネルの作成に失敗しました' });
      }
      const newChannel = { id: this.lastID, name: name.trim(), is_deletable: 1 };
      broadcast({ type: 'channel_created', data: newChannel });
      res.status(201).json(newChannel);
    });
    stmt.finalize();
  });

  app.delete('/channels/:id', authenticateToken, (req, res) => {
    const channelId = req.params.id;
    db.get('SELECT is_deletable FROM channels WHERE id = ?', [channelId], (err, row) => {
      if (err) {
        if (process.send) process.send({ type: 'server-log', message: `Channel delete DB error: ${err.message}`, level: 'error' });
        return res.status(500).json({ error: 'データベースエラーです' });
      }
      if (!row) return res.status(404).json({ error: 'チャンネルが見つかりません' });
      if (row.is_deletable == 0) return res.status(403).json({ error: 'このチャンネルは削除できません' });

      db.run('DELETE FROM channels WHERE id = ?', [channelId], function(err) {
        if (err) {
          if (process.send) process.send({ type: 'server-log', message: `Channel deletion failed: ${err.message}`, level: 'error' });
          return res.status(500).json({ error: 'チャンネルの削除に失敗しました' });
        }
        broadcast({ type: 'channel_deleted', id: Number(channelId) });
        res.status(200).json({ message: 'チャンネルを削除しました' });
      });
    });
  });

  app.get('/messages/:channelId', authenticateToken, (req, res) => {
    const { channelId } = req.params;
    const sql = `
      SELECT
        m1.id, m1.channelId, m1.user, m1.text, m1.timestamp, m1.replyToId,
        m2.user as repliedToUser,
        m2.text as repliedToText
      FROM messages AS m1
      LEFT JOIN messages AS m2 ON m1.replyToId = m2.id
      WHERE m1.channelId = ?
      ORDER BY m1.timestamp ASC
    `;
    db.all(sql, [channelId], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(rows);
    });
  });

  app.post('/messages', authenticateToken, (req, res) => {
    const { channelId, text, replyToId } = req.body;
    const user = req.user.username;

    if (!channelId || !user || !text) {
      return res.status(400).json({ error: 'チャンネルID、ユーザー、テキストは必須です' });
    }

    const stmt = db.prepare('INSERT INTO messages (channelId, user, text, replyToId) VALUES (?, ?, ?, ?)');
    stmt.run(channelId, user, text, replyToId || null, function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const newId = this.lastID;
      const sql = `
        SELECT
          m1.id, m1.channelId, m1.user, m1.text, m1.timestamp, m1.replyToId,
          m2.user as repliedToUser, m2.text as repliedToText
        FROM messages AS m1
        LEFT JOIN messages AS m2 ON m1.replyToId = m2.id
        WHERE m1.id = ?
      `;
      db.get(sql, [newId], (err, newMessage) => {
        if (err) {
          console.error("Failed to fetch new message for broadcast:", err);
          return res.status(201).json({ id: newId, channelId, user, text, timestamp: new Date().toISOString(), replyToId });
        }
        if (newMessage) {
          broadcast({ type: 'new_message', data: newMessage });
          res.status(201).json(newMessage);
        }
      });
    });
    stmt.finalize();
  });


  app.delete('/messages/:id', authenticateToken, (req, res) => {
    const messageId = req.params.id;
    const user = req.user;

    db.get('SELECT user FROM messages WHERE id = ?', [messageId], (err, row) => {
      if (err) return res.status(500).json({ error: 'データベースエラー' });
      if (!row) return res.status(404).json({ error: 'メッセージが見つかりません' });
      if (row.user !== user.username) return res.status(403).json({ error: 'このメッセージを削除する権限がありません' });
      
      db.run('DELETE FROM messages WHERE id = ?', [messageId], function (err) {
        if (err) return res.status(500).json({ error: 'メッセージの削除に失敗しました' });
        broadcast({ type: 'message_deleted', id: Number(messageId) });
        res.status(200).json({ message: 'メッセージを削除しました' });
      });
    });
  });

  app.post('/messages/:channelId/read', authenticateToken, (req, res) => {
    const { channelId } = req.params;
    const userId = req.user.id;
    const { lastMessageId } = req.body;

    if (!lastMessageId) return res.status(400).json({ error: 'lastMessageIdは必須です' });

    const stmt = db.prepare(`
      INSERT INTO read_receipts (user_id, channel_id, last_read_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET
      last_read_message_id = excluded.last_read_message_id
    `);
    stmt.run(userId, channelId, lastMessageId, (err) => {
      if (err) return res.status(500).json({ error: '読み取りステータスの更新に失敗しました' });
      res.status(200).json({ message: 'Read status updated' });
    });
    stmt.finalize();
  });

  app.get('/messages/unread-counts', authenticateToken, (req, res) => {
    const userId = req.user.id;
    db.all('SELECT channelId, MAX(id) as max_id FROM messages GROUP BY channelId', [], (err, latestMessages) => {
      if (err) return res.status(500).json({ error: '最新のメッセージを取得できませんでした' });
      db.all('SELECT channel_id, last_read_message_id FROM read_receipts WHERE user_id = ?', [userId], (err, readReceipts) => {
        if (err) return res.status(500).json({ error: '開封確認を取得できませんでした' });
        const readReceiptsMap = new Map(readReceipts.map(r => [r.channel_id, r.last_read_message_id]));
        const unreadCounts = {};
        const promises = latestMessages.map(lm => {
          return new Promise((resolve, reject) => {
            const lastReadId = readReceiptsMap.get(lm.channelId) || 0;
            db.get('SELECT COUNT(*) as count FROM messages WHERE channelId = ? AND id > ?', [lm.channelId, lastReadId], (err, result) => {
              if (err) return reject(err);
              unreadCounts[lm.channelId] = result.count;
              resolve();
            });
          });
        });
        Promise.all(promises)
          .then(() => res.json(unreadCounts))
          .catch(error => res.status(500).json({ error: '未読数のカウント中にエラーが発生しました' }));
      });
    });
  });

  app.get('/channels/:channelId/last-read', authenticateToken, (req, res) => {
    const { channelId } = req.params;
    const userId = req.user.id;
    db.get('SELECT last_read_message_id FROM read_receipts WHERE user_id = ? AND channel_id = ?', [userId, channelId], (err, row) => {
      if (err) return res.status(500).json({ error: 'データベースエラーです' });
      res.json({ last_read_message_id: row ? row.last_read_message_id : 0 });
    });
  });

  app.get('/users/online', authenticateToken, (req, res) => {
    const userList = Array.from(onlineUsers.keys());
    res.json(userList);
  });

  app.post('/login/auto', (req, res) => {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: '職員IDは必須です' });
    }

    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!user) {
        return res.status(404).json({ error: '指定された職員IDのユーザーが見つかりません' });
      }

      const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });

      res.json({
        message: 'Automatic login successful',
        user: { id: user.id, username: user.username },
        token: token
      });
    });
  });
}

// --- サーバー起動関数 ---
function startServer(port, dbFilePath, secretKey) {
  return new Promise((resolve, reject) => {
    if (server && server.listening) {
      if (process.send) process.send({ type: 'server-log', message: `Server already running on port ${port}.`, level: 'warn' });
      console.warn(`Server already running on port ${port}.`);
      return resolve();
    }

    SECRET_KEY = secretKey || process.env.SECRET_KEY || 'your-default-secret-key';
    const app = express();
    setupApiEndpoints(app); // APIエンドポイントを設定

    server = http.createServer(app);
    setupWebSocketServer(); // WebSocketサーバーを設定

    const currentDbPath = path.resolve(dbFilePath);
    initializeDatabase(currentDbPath, (err) => {
      if (err) {
        if (process.send) process.send({ type: 'server-log', message: `Failed to initialize database: ${err.message}`, level: 'error' });
        return reject(new Error(`Failed to initialize database: ${err.message}`));
      }

      server.listen(port, () => {
        if (process.send) process.send({ type: 'server-status', status: 'running', port: port });
        if (process.send) process.send({ type: 'server-log', message: `Server is listening on port ${port}`, level: 'info' });
        console.log(`Server is listening on port ${port}`);
        resolve();
      }).on('error', (err) => {
        if (process.send) process.send({ type: 'server-log', message: `Server failed to start on port ${port}: ${err.message}`, level: 'error' });
        if (process.send) process.send({ type: 'server-status', status: 'stopped', error: err.message });
        console.error(`Server failed to start on port ${port}:`, err);
        reject(err);
      });
    });
  });
}

// --- サーバー停止関数 ---
function stopServer() {
  return new Promise((resolve, reject) => {
    if (!server && !wss && !db) {
      if (process.send) process.send({ type: 'server-log', message: 'Server is not running or already stopped. [stopServer]', level: 'warn' });
      console.warn('Server is not running or already stopped.');
      return resolve();
    }

    const closePromises = [];

    // 1. WebSocketサーバーのクローズ
    if (wss) {
      closePromises.push(new Promise(wsResolve => {
        wss.clients.forEach(client => {
          if (client.readyState === client.OPEN) {
            client.close(1001, "Server shutting down");
          }
        });
        wss.close(() => {
          if (process.send) process.send({ type: 'server-log', message: 'WebSocket server successfully closed. [stopServer]', level: 'info' });
          console.log('WebSocket server closed.');
          wss = null;
          wsResolve();
        });
      }));
      onlineUsers.clear();
    } else {
      closePromises.push(Promise.resolve().then(() => {
        if (process.send) process.send({ type: 'server-log', message: 'WebSocket server was not active. [stopServer]', level: 'info' });
      }));
    }

    // 2. HTTPサーバーのクローズ
    if (server) {
      closePromises.push(new Promise((httpResolve, httpReject) => {
        server.close((err) => {
          if (err) {
            if (process.send) process.send({ type: 'server-log', message: `Error stopping HTTP server: ${err.message}. [stopServer]`, level: 'error' });
            console.error('Error stopping HTTP server:', err);
            httpReject(err);
          } else {
            if (process.send) process.send({ type: 'server-log', message: 'HTTP server successfully closed. [stopServer]', level: 'info' });
            console.log('HTTP server closed.');
            server = null;
            httpResolve();
          }
        });
      }));
    } else {
      closePromises.push(Promise.resolve().then(() => {
        if (process.send) process.send({ type: 'server-log', message: 'HTTP server was not active. [stopServer]', level: 'info' });
      }));
    }

    // 3. データベースのクローズ (タイムアウトを追加)
    if (db) {
      closePromises.push(new Promise((dbResolve) => {
        let dbClosed = false;
        const dbTimeout = setTimeout(() => {
          if (!dbClosed) {
            if (process.send) process.send({ type: 'server-log', message: 'Database close timed out. Forcing resolution of DB close promise. [stopServer]', level: 'warn' });
            console.warn('Database close timed out. Forcing resolution of DB close promise.');
            db = null;
            dbResolve();
          }
        }, 4000); // データベースクローズのタイムアウトを4秒に設定

        db.close((err) => {
          clearTimeout(dbTimeout);
          dbClosed = true;
          if (err) {
            if (process.send) process.send({ type: 'server-log', message: `Error closing database: ${err.message}. [stopServer]`, level: 'error' });
            console.error('Error closing database:', err.message);
            db = null;
            dbResolve();
          } else {
            if (process.send) process.send({ type: 'server-log', message: 'Database successfully closed. [stopServer]', level: 'info' });
            console.log('Database closed.');
            db = null;
            dbResolve();
          }
        });
      }));
    } else {
      closePromises.push(Promise.resolve().then(() => {
        if (process.send) process.send({ type: 'server-log', message: 'Database was not active. [stopServer]', level: 'info' });
      }));
    }

    // 全てのクローズ処理が完了するのを待つ
    Promise.allSettled(closePromises)
      .then((results) => {
        const hasError = results.some(result => result.status === 'rejected');
        if (hasError) {
            if (process.send) process.send({ type: 'server-log', message: 'Some components failed to stop gracefully. Check logs for details. [stopServer]', level: 'error' });
            console.error('Some components failed to stop gracefully. Check logs for details.');
        }

        if (process.send) process.send({ type: 'server-log', message: 'All components attempted to close. Sending final status. [stopServer]', level: 'info' });
        if (process.send) process.send({ type: 'server-status', status: 'stopped', port: null });
        if (process.send) process.send({ type: 'server-log', message: 'Server successfully stopped and child process preparing to exit. [stopServer]', level: 'info' });
        console.log('Server successfully stopped.');
        resolve();
      })
      .catch(error => {
        if (process.send) process.send({ type: 'server-log', message: `Unexpected error during server stop: ${error.message}. [stopServer]`, level: 'fatal' });
        console.error('Unexpected error during server stop:', error);
        reject(error);
      });
  });
}

// このスクリプトが子プロセスとして実行された場合
if (require.main === module) {
  process.on('message', async (message) => {
    if (message.command === 'start') {
      try {
        await startServer(message.port, message.dbPath, message.secretKey);
      } catch (e) {
        // startServer内でエラーハンドリングはしているので、ここでは何もしない
      }
    } else if (message.command === 'stop') {
      try {
        await stopServer();
      } catch (e) {
        // stopServer内でエラーハンドリングはしているので、ここでは何もしない
      }
    }
  });

  // 親プロセスが終了したら子プロセスも終了
  process.on('disconnect', () => {
    console.log('Parent disconnected, shutting down server child process.');
    stopServer().finally(() => process.exit(0));
  });

  // エラーハンドリング
  process.on('unhandledRejection', (reason, promise) => {
    if (process.send) process.send({ type: 'server-log', message: `Unhandled Rejection at: ${promise}, reason: ${reason}`, level: 'error' });
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (err) => {
    if (process.send) process.send({ type: 'server-log', message: `Uncaught Exception: ${err.message}\n${err.stack}`, level: 'fatal' });
    console.error('Uncaught Exception:', err);
    stopServer().finally(() => process.exit(1)); // 強制終了ではなく、クリーンアップ後に終了
  });

  if (process.send) process.send({ type: 'server-log', message: 'Server child process initialized, waiting for commands...', level: 'info' });
  console.log('Server child process initialized, waiting for commands...');
}

// Electronのメインプロセスから直接importして使う場合のためにエクスポート
module.exports = { startServer, stopServer };