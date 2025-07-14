// Final Corrected Version: 4.0
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { promisify } = require("util");

let server = null;
let wss = null;
let db = null;
let log = () => {};

const onlineUsers = new Map();
const BCRYPT_SALT_ROUNDS = 12;
const SECRET_KEY = process.env.SECRET_KEY || "your-super-secret-key-for-qoler-chat";
const jwtVerifyAsync = promisify(jwt.verify);

function initializeDatabase(dbPath, callback) {
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      log(`Database opening error: ${err.message}`, "error");
      return callback(err);
    }
    log("Database connected!", "info");
    db.run("PRAGMA foreign_keys = ON;");
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL, UNIQUE(id))`);
      db.exec(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_deletable BOOLEAN DEFAULT 1, is_group BOOLEAN DEFAULT 0, creator_id INTEGER, FOREIGN KEY(creator_id) REFERENCES users(id) ON DELETE SET NULL)`);
      db.run(`CREATE TABLE IF NOT EXISTS channel_members (channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (channel_id, user_id), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
      db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channelId INTEGER, user TEXT, text TEXT, timestamp DATETIME DEFAULT (datetime('now', 'localtime')), replyToId INTEGER, FOREIGN KEY(channelId) REFERENCES channels(id) ON DELETE CASCADE, FOREIGN KEY(replyToId) REFERENCES messages(id) ON DELETE SET NULL)`);
      db.run(`CREATE TABLE IF NOT EXISTS read_receipts (user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, last_read_message_id INTEGER NOT NULL, PRIMARY KEY (user_id, channel_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE)`);
      ["連絡", "雑談"].forEach((name) => db.run("INSERT OR IGNORE INTO channels (name, is_deletable, is_group) VALUES (?, 0, 0)", [name]));
      callback(null);
    });
  });
}

function setupWebSocketServer() {
  if (wss) wss.close();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url, `ws://${req.headers.host}`).searchParams.get("token");
    if (!token) return ws.close(1008, "Token not provided");
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
      if (err) return ws.close(1008, "Invalid token");
      ws.username = decoded.username;
      onlineUsers.set(decoded.username, ws);
      broadcastOnlineUsers();
      ws.on("close", () => {
        onlineUsers.delete(decoded.username);
        broadcastOnlineUsers();
      });
    });
  });
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(message);
  });
}

function notifyUsers(userIds, message) {
    if (!userIds || userIds.length === 0) return;
    const placeholders = userIds.map(() => '?').join(',');
    const sql = `SELECT username FROM users WHERE id IN (${placeholders})`;
    db.all(sql, userIds, (err, users) => {
        if (err) return;
        users.forEach(user => {
            const ws = onlineUsers.get(user.username);
            if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        });
    });
}

function broadcastOnlineUsers() {
  broadcast({ type: "user_list_update", data: Array.from(onlineUsers.keys()) });
}

async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    try {
        const user = await jwtVerifyAsync(token, SECRET_KEY);
        req.user = user;
        next();
    } catch (err) {
        return res.sendStatus(403);
    }
}

const isChannelMember = (channelId, userId, callback) => {
    const sql = `SELECT 1 FROM channels c LEFT JOIN channel_members cm ON c.id = cm.channel_id WHERE c.id = ? AND (c.is_group = 0 OR cm.user_id = ?)`;
    db.get(sql, [channelId, userId], (err, row) => callback(err, !!row));
};

function setupApiEndpoints(app) {
  app.use(cors());
  app.use(express.json());

  app.post("/register", async (req, res) => {
    const { id, username, password } = req.body;
    if (!id || !username || !password) return res.status(400).json({ error: "職員ID、名前、パスワードは必須です" });
    try {
      const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      db.run("INSERT OR IGNORE INTO users (id, username, password) VALUES (?, ?, ?)", [id, username, hashedPassword], (err) => {
        if (err) return res.status(409).json({ error: "その職員IDは既に使用されています。" });
        res.status(201).json({ message: "登録が完了しました。" });
      });
    } catch (error) {
      res.status(500).json({ error: "登録処理でサーバーエラーが発生しました" });
    }
  });

  app.post("/login", (req, res) => {
    const { id, password } = req.body;
    db.get("SELECT * FROM users WHERE id = ?", [id], async (err, user) => {
      if (err || !user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "職員IDまたはパスワードが無効です" });
      const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: "1h" });
      res.json({ user: { id: user.id, username: user.username }, token });
    });
  });

  app.get("/users", authenticateToken, (req, res) => {
    db.all("SELECT id, username FROM users", [], (err, rows) => {
      if (err) return res.status(500).json({ error: "ユーザー一覧の取得に失敗しました" });
      res.json(rows);
    });
  });

  app.get("/channels", authenticateToken, (req, res) => {
    const sql = `SELECT DISTINCT c.id, c.name, c.is_deletable, c.is_group FROM channels c LEFT JOIN channel_members cm ON c.id = cm.channel_id WHERE c.is_group = 0 OR cm.user_id = ? ORDER BY c.id ASC`;
    db.all(sql, [req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });

  app.post("/channels", authenticateToken, (req, res) => {
    db.run("INSERT INTO channels (name, is_group) VALUES (?, 0)", [req.body.name], function(err) {
        if(err) return res.status(500).json({ error: "チャンネル作成に失敗しました"});
        const newChannel = { id: this.lastID, name: req.body.name, is_group: 0, is_deletable: 1 };
        broadcast({ type: "channel_created", data: newChannel });
        res.status(201).json(newChannel);
    });
  });
  
  app.post("/channels/group", authenticateToken, (req, res) => {
    const { name, memberIds } = req.body;
    const finalMemberIds = [...new Set([req.user.id, ...memberIds])];
    db.run("INSERT INTO channels (name, is_group, creator_id) VALUES (?, 1, ?)", [name, req.user.id], function(err) {
        if(err) return res.status(500).json({ error: "グループ作成に失敗しました" });
        const channelId = this.lastID;
        const stmt = db.prepare("INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)");
        finalMemberIds.forEach(userId => stmt.run(channelId, userId));
        stmt.finalize(err => {
            if(err) return res.status(500).json({ error: "メンバー追加に失敗しました" });
            const newChannel = { id: channelId, name, is_group: 1, is_deletable: 1 };
            broadcast({ type: "channel_created", data: newChannel });
            res.status(201).json(newChannel);
        });
    });
  });
  
  app.put("/channels/:id/name", authenticateToken, (req, res) => {
    db.run("UPDATE channels SET name = ? WHERE id = ?", [req.body.name, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: "名前の変更に失敗しました" });
        const updatedChannel = { id: Number(req.params.id), name: req.body.name };
        broadcast({ type: "channel_updated", data: updatedChannel });
        res.status(200).json(updatedChannel);
    });
  });

  app.delete("/channels/:id", authenticateToken, (req, res) => {
    db.run("DELETE FROM channels WHERE id = ? AND is_deletable = 1", [req.params.id], function (err) {
        if (err || this.changes === 0) return res.status(500).json({ error: "チャンネルの削除に失敗しました" });
        broadcast({ type: "channel_deleted", id: Number(req.params.id) });
        res.status(200).json({ message: "チャンネルを削除しました" });
    });
  });
  
  app.get("/channels/:id/members", authenticateToken, (req, res) => {
    const sql = `SELECT u.id, u.username FROM users u JOIN channel_members cm ON u.id = cm.user_id WHERE cm.channel_id = ?`;
    db.all(sql, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
  });

  app.post("/channels/:id/members", authenticateToken, (req, res) => {
    const userIdsToAdd = req.body.userIds;
    const stmt = db.prepare("INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)");
    userIdsToAdd.forEach(userId => stmt.run(req.params.id, userId));
    stmt.finalize(err => {
        if (err) return res.status(500).json({ error: "メンバー追加に失敗しました" });
        broadcast({ type: "members_updated", data: { channelId: Number(req.params.id) }});
        notifyUsers(userIdsToAdd, { type: 'refetch_channels' });
        res.status(200).json({ message: "メンバーを追加しました" });
    });
  });

  app.delete("/channels/:id/members", authenticateToken, (req, res) => {
    const userIdsToRemove = req.body.userIds;
    const placeholders = userIdsToRemove.map(() => '?').join(',');
    const sql = `DELETE FROM channel_members WHERE channel_id = ? AND user_id IN (${placeholders})`;
    db.run(sql, [req.params.id, ...userIdsToRemove], function (err) {
        if (err) return res.status(500).json({ error: "メンバー削除に失敗しました" });
        broadcast({ type: "members_updated", data: { channelId: Number(req.params.id) }});
        notifyUsers(userIdsToRemove, { type: 'refetch_channels' });
        res.status(200).json({ message: "メンバーを削除しました" });
    });
  });
  
  app.get("/messages/unread-counts", authenticateToken, (req, res) => {
    const sql = `SELECT c.id as channelId, (SELECT COUNT(*) FROM messages m WHERE m.channelId = c.id AND m.id > IFNULL(rr.last_read_message_id, 0)) as count FROM channels c LEFT JOIN read_receipts rr ON c.id = rr.channel_id AND rr.user_id = ?`;
    db.all(sql, [req.user.id], (err, rows) => {
        if(err) return res.status(500).json({});
        const counts = rows.reduce((acc, row) => ({...acc, [row.channelId]: row.count}), {});
        res.json(counts);
    });
  });

  app.get("/messages/:channelId", authenticateToken, (req, res) => {
    isChannelMember(req.params.channelId, req.user.id, (err, isMember) => {
        if (err || !isMember) return res.status(403).json({ error: "アクセス権がありません" });
        const sql = `SELECT m1.*, m2.user as repliedToUser, m2.text as repliedToText FROM messages AS m1 LEFT JOIN messages AS m2 ON m1.replyToId = m2.id WHERE m1.channelId = ? ORDER BY m1.timestamp ASC`;
        db.all(sql, [req.params.channelId], (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(rows);
        });
    });
  });

  app.post("/messages", authenticateToken, (req, res) => {
    const { channelId, text, replyToId } = req.body;
    isChannelMember(channelId, req.user.id, (err, isMember) => {
        if (err || !isMember) return res.status(403).json({ error: "投稿権限がありません" });
        const stmt = db.prepare("INSERT INTO messages (channelId, user, text, replyToId) VALUES (?, ?, ?, ?)");
        stmt.run(channelId, req.user.username, text, replyToId || null, function (err) {
            if (err) return res.status(500).json({ error: err.message });
            db.get(`SELECT m1.*, m2.user as repliedToUser, m2.text as repliedToText FROM messages AS m1 LEFT JOIN messages AS m2 ON m1.replyToId = m2.id WHERE m1.id = ?`, [this.lastID], (err, newMessage) => {
              if (newMessage) broadcast({ type: "new_message", data: newMessage });
              res.status(201).json(newMessage);
            });
        });
    });
  });

  app.delete("/messages/:id", authenticateToken, (req, res) => {
    db.get("SELECT user FROM messages WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row || row.user !== req.user.username) return res.status(403).json({ error: "削除権限がありません" });
        db.run("DELETE FROM messages WHERE id = ?", [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: "メッセージの削除に失敗しました" });
            broadcast({ type: "message_deleted", id: Number(req.params.id) });
            res.status(200).json({ message: "メッセージを削除しました" });
        });
    });
  });
  
  app.post("/messages/:channelId/read", authenticateToken, (req, res) => {
    const { channelId } = req.params;
    const { lastMessageId } = req.body;
    if (!lastMessageId) return res.status(400).json({ error: "lastMessageIdは必須です" });
    const stmt = db.prepare(`INSERT INTO read_receipts (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`);
    stmt.run(req.user.id, channelId, lastMessageId, (err) => {
      if (err) return res.status(500).json({ error: "読み取りステータスの更新に失敗しました" });
      res.status(200).json({ message: "Read status updated" });
    });
    stmt.finalize();
  });
  
  app.get("/channels/:channelId/last-read", authenticateToken, (req, res) => {
    db.get("SELECT last_read_message_id FROM read_receipts WHERE user_id = ? AND channel_id = ?", [req.user.id, req.params.channelId], (err, row) => {
        if (err) return res.status(500).json({ error: "データベースエラーです" });
        res.json({ last_read_message_id: row ? row.last_read_message_id : 0 });
    });
  });
}

function startServer(port, dbFilePath, logFunction) {
  log = logFunction;
  return new Promise((resolve, reject) => {
    if (server && server.listening) return resolve();
    const app = express();
    server = http.createServer(app);
    initializeDatabase(path.resolve(dbFilePath), (err) => {
      if (err) return reject(new Error(`Failed to initialize database: ${err.message}`));
      setupApiEndpoints(app);
      setupWebSocketServer();
      server.listen(port, () => {
          log(`Server is now listening on port ${port}`, "info");
          resolve();
      }).on("error", (err) => {
          log(`Server failed to start on port ${port}: ${err.message}`, "error");
          reject(err);
      });
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (wss) { wss.clients.forEach(c => c.close()); wss.close(() => { wss = null; }); }
    if (server) server.close(() => { server = null; });
    if (db) db.close(() => { db = null; });
    log("All services stopped.", "info");
    resolve();
  });
}

module.exports = { startServer, stopServer };