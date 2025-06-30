require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const app = express();
const onlineUsers = new Map();

// --- 定数 ---
const BCRYPT_SALT_ROUNDS = 12;
const SECRET_KEY = process.env.SECRET_KEY || 'your-default-secret-key';

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- データベース設定 ---
const dbPath = process.pkg ?
  path.join(path.dirname(process.execPath), 'chat-database.sqlite') :
  path.join(__dirname, 'chat-database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database opening error: ', err);
  } else {
    console.log('Database connected!');
    db.run('PRAGMA foreign_keys = ON;');
  }
});

db.serialize(() => {
  // ユーザーテーブル: ID(主キー), username(名前), password
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
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
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
});

// --- WebSocket 通信 ---
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
  });
});

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

// --- APIエンドポイント ---

// ユーザー登録
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
        return res.status(500).json({ error: '登録中にサーバーエラーが発生しました' });
      }
      res.status(201).json({ message: '登録が完了しました。' });
    });
    stmt.finalize();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '登録処理でサーバーエラーが発生しました' });
  }
});

// ログイン
app.post('/login', (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) {
    return res.status(400).json({ error: '職員IDとパスワードは必須です' });
  }

  db.get('SELECT * FROM users WHERE id = ?', [id], async (err, user) => {
    if (err) {
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

app.get('/channels', authenticateToken, (req, res) => {
  db.all('SELECT id, name, is_deletable FROM channels ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
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
    if (err) return res.status(500).json({ error: 'データベースエラーです' });
    if (!row) return res.status(404).json({ error: 'チャンネルが見つかりません' });
    if (row.is_deletable == 0) return res.status(403).json({ error: 'このチャンネルは削除できません' });

    db.run('DELETE FROM channels WHERE id = ?', [channelId], function(err) {
      if (err) return res.status(500).json({ error: 'チャンネルの削除に失敗しました' });
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

// 【追加】自動ログイン用エンドポイント
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
      // ユーザーが見つからなくても、意図的にエラーとはしない場合もあるが、
      // ここでは明確にエラーを返す
      return res.status(404).json({ error: '指定された職員IDのユーザーが見つかりません' });
    }

    // パスワードチェックをスキップしてトークンを発行
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });

    res.json({
      message: 'Automatic login successful',
      user: { id: user.id, username: user.username },
      token: token
    });
  });
});


// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});