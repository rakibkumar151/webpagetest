const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@libsql/client');

const app = express();

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
const isProduction  = process.env.NODE_ENV === 'production';

if (isProduction && allowedOrigin === '*') {
    console.warn('[CONFIG] WARNING: FRONTEND_ORIGIN not set — allowing all origins. Set FRONTEND_ORIGIN for security.');
}

const corsOptions = {
    origin: allowedOrigin === '*' ? '*' : (origin, cb) => {
        // Allow requests with no origin (mobile apps, Postman, server-to-server)
        if (!origin) return cb(null, true);
        if (origin === allowedOrigin) return cb(null, true);
        // Also allow same-origin requests from the signaling server itself
        cb(null, true); // Permissive for now; tighten with FRONTEND_ORIGIN env
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false,
    optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable pre-flight for all routes
app.use(express.json({ limit: '5mb' }));

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TURN_SECRET  = process.env.TURN_SECRET;
const TURN_HOST    = process.env.TURN_HOST;
const PORT         = process.env.PORT || 3000;
const TURN_TTL     = parseInt(process.env.TURN_TTL || '3600', 10);
const JWT_SECRET   = process.env.JWT_SECRET || 'chet_secret_change_in_prod_' + crypto.randomBytes(8).toString('hex');
const TURSO_URL    = process.env.TURSO_DB_URL;
const TURSO_TOKEN  = process.env.TURSO_AUTH_TOKEN;

if (!TURN_SECRET || !TURN_HOST) {
    console.warn('[CONFIG] TURN_SECRET or TURN_HOST not set.');
}

// ─── TURSO DATABASE ──────────────────────────────────────────────────────────
let db = null;
let dbReady = false;
let dbError  = null;

if (TURSO_URL && TURSO_TOKEN) {
    db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

    (async () => {
        try {
            await db.execute(`
                CREATE TABLE IF NOT EXISTS users (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    uid          TEXT UNIQUE NOT NULL,
                    username     TEXT UNIQUE NOT NULL,
                    first_name   TEXT NOT NULL,
                    last_name    TEXT NOT NULL,
                    email        TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at   TEXT DEFAULT (datetime('now')),
                    last_active  TEXT DEFAULT NULL,
                    profile_photo TEXT DEFAULT NULL
                )
            `);
            await db.execute(`
                CREATE TABLE IF NOT EXISTS messages (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_uid       TEXT NOT NULL,
                    to_uid         TEXT NOT NULL,
                    encrypted_text TEXT NOT NULL,
                    created_at     TEXT DEFAULT (datetime('now')),
                    read_at        TEXT DEFAULT NULL
                )
            `);
            // Add columns safely to existing tables
            try { await db.execute(`ALTER TABLE users ADD COLUMN last_active TEXT DEFAULT NULL`); } catch(e) {}
            try { await db.execute(`ALTER TABLE users ADD COLUMN profile_photo TEXT DEFAULT NULL`); } catch(e) {}
            try { await db.execute(`ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT NULL`); } catch(e) {}
            try { await db.execute(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT NULL`); } catch(e) {}
            
            dbReady = true;
            console.log('[DB] Turso connected and tables ready');
        } catch (e) {
            dbError = e.message;
            console.error('[DB] Init error:', e.message);
        }
    })();
} else {
    console.warn('[DB] TURSO_DB_URL or TURSO_AUTH_TOKEN not set — auth endpoints will be disabled.');
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, db: !!db, dbReady, dbError: dbError || null }));

// ─── DB TEST ──────────────────────────────────────────────────────────────────
app.get('/api/db-test', async (_req, res) => {
    if (!db) return res.json({ ok: false, error: 'No DB client. Check TURSO_DB_URL and TURSO_AUTH_TOKEN env vars.' });
    try {
        const r = await db.execute('SELECT 1 as ping');
        res.json({ ok: true, dbReady, rows: r.rows, dbError });
    } catch(e) {
        res.json({ ok: false, error: e.message, dbReady, dbError });
    }
});

// ─── CALLS: INITIATE ─────────────────────────────────────────────────────────
// Authenticated endpoint — generates a secure random callId server-side.
// callId is NEVER derived from UIDs so it can't be guessed or replayed.
// The caller stores it in sessionStorage only — never exposed in the URL.
app.post('/api/calls/initiate', authMiddleware, (req, res) => {
    const { target_uid } = req.body;
    if (!target_uid || typeof target_uid !== 'string') {
        return res.status(400).json({ error: 'target_uid required' });
    }
    // 128-bit random — unguessable, no UID fingerprint
    const callId    = crypto.randomBytes(16).toString('hex');
    const sessionId = crypto.randomBytes(12).toString('hex');
    console.log(`[CALL] initiated by=${req.user.uid} target=${target_uid} callId=${callId.slice(0,8)}…`);
    res.json({ callId, sessionId });
});



// ─── TURN CREDENTIALS ────────────────────────────────────────────────────────
app.get('/api/turn-credentials', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!TURN_SECRET || !TURN_HOST) return res.status(503).json({ error: 'TURN service unavailable' });
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiry           = currentTimestamp + TURN_TTL;
    const username         = `${expiry}:guest`;
    const hmac = crypto.createHmac('sha1', TURN_SECRET);
    hmac.update(username);
    const credential = hmac.digest('base64');
    console.log(`[TURN] Credential issued expiry=${expiry} ip=${req.ip}`);
    return res.json({
        ttl: TURN_TTL,
        current_server_time: currentTimestamp,
        expiry_timestamp: expiry,
        username,
        credential,
        urls: [
            `turn:${TURN_HOST}:3478?transport=udp`,
            `turn:${TURN_HOST}:3478?transport=tcp`,
            `turns:${TURN_HOST}:5349?transport=tcp`
        ]
    });
});

// ─── AUTH: REGISTER ──────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { username, first_name, last_name, email, password } = req.body;
    if (!username || !first_name || !last_name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ error: 'Username: 3-20 chars, letters/numbers/underscore only' });
    }
    try {
        const password_hash = await bcrypt.hash(password, 12);
        const uid = 'UID' + Math.floor(1000000 + Math.random() * 9000000);
        await db.execute({
            sql: `INSERT INTO users (uid, username, first_name, last_name, email, password_hash)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [uid, username.toLowerCase(), first_name.trim(), last_name.trim(), email.toLowerCase().trim(), password_hash]
        });
        const token = jwt.sign({ uid, username: username.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
        console.log(`[AUTH] Registered uid=${uid} username=${username}`);
        res.json({ token, uid, username: username.toLowerCase(), first_name: first_name.trim(), last_name: last_name.trim() });
    } catch (e) {
        if (e.message?.includes('UNIQUE') || e.message?.includes('SQLITE_CONSTRAINT')) {
            res.status(409).json({ error: 'Username or email is already taken' });
        } else {
            console.error('[AUTH] Register error:', e.message);
            // Return actual error for now to help diagnose
            res.status(500).json({ error: 'Registration failed: ' + e.message });
        }
    }
});

// ─── AUTH: LOGIN ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'All fields are required' });
    try {
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1`,
            args: [identifier.toLowerCase().trim(), identifier.toLowerCase().trim()]
        });
        if (!result.rows.length) return res.status(401).json({ error: 'Invalid email/username or password' });
        const user  = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email/username or password' });
        const token = jwt.sign({ uid: user.uid, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        console.log(`[AUTH] Login uid=${user.uid}`);
        res.json({ token, uid: user.uid, username: user.username, first_name: user.first_name, last_name: user.last_name, profile_photo: user.profile_photo });
    } catch (e) {
        console.error('[AUTH] Login error:', e.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ─── AUTH: ME ────────────────────────────────────────────────────────────────
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
        const result = await db.execute({
            sql: `SELECT uid, username, first_name, last_name, email, created_at, profile_photo FROM users WHERE uid = ? LIMIT 1`,
            args: [req.user.uid]
        });
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

// ─── USERS: LIST / SEARCH ────────────────────────────────────────────────────
app.get('/api/users', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const q = (req.query.q || '').trim();
    try {
        let result;
        if (q) {
            result = await db.execute({
                sql: `SELECT * FROM users
                      WHERE (username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR uid LIKE ?)
                      AND uid != ? LIMIT 40`,
                args: [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, req.user.uid]
            });
        } else {
            result = await db.execute({
                sql: `SELECT * FROM users
                      WHERE uid != ? ORDER BY created_at DESC LIMIT 40`,
                args: [req.user.uid]
            });
        }
        const users = result.rows.map(u => ({
            uid: u.uid,
            username: u.username,
            first_name: u.first_name,
            last_name: u.last_name,
            last_active: u.last_active || null,
            profile_photo: u.profile_photo || null,
            is_online: globalUserSockets.has(u.uid)
        }));
        res.json(users);
    } catch (e) {
        console.error('[USERS] List error:', e.message);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// ─── USERS: UPDATE PROFILE PHOTO ─────────────────────────────────────────────
app.post('/api/users/profile-photo', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { profile_photo } = req.body;
    
    // basic validation
    if (profile_photo && profile_photo.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large' });
    }

    try {
        await db.execute({
            sql: `UPDATE users SET profile_photo = ? WHERE uid = ?`,
            args: [profile_photo || null, req.user.uid]
        });

        // Broadcast real-time profile update to ALL connected users
        io.emit('profile_updated', {
            uid: req.user.uid,
            profile_photo: profile_photo || null
        });

        res.json({ success: true });
    } catch (e) {
        console.error('[USERS] Profile photo upload error:', e.message);
        res.status(500).json({ error: 'Failed to update profile photo' });
    }
});

// ─── CHAT ENCRYPTION ─────────────────────────────────────────────────────────
// Derive a 32-byte key from JWT_SECRET for AES-256-GCM encryption at rest
const CHAT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();

function encryptMessage(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CHAT_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    // Format: iv:authTag:encryptedText
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptMessage(encryptedStr) {
    try {
        const [ivHex, authTagHex, encryptedHex] = encryptedStr.split(':');
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            CHAT_KEY,
            Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return '[Message decryption failed]';
    }
}

// ─── MESSAGES: API ───────────────────────────────────────────────────────────
// Get chat history
app.get('/api/messages/:uid', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const otherUid = req.params.uid;
    const myUid = req.user.uid;
    try {
        const result = await db.execute({
            sql: `SELECT * FROM messages 
                  WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
                  ORDER BY created_at ASC LIMIT 100`,
            args: [myUid, otherUid, otherUid, myUid]
        });
        
        // Decrypt on the fly
        const messages = result.rows.map(row => ({
            id: row.id,
            from_uid: row.from_uid,
            to_uid: row.to_uid,
            text: decryptMessage(row.encrypted_text),
            created_at: row.created_at,
            read_at: row.read_at || null,
            reactions: row.reactions ? JSON.parse(row.reactions) : null
        }));
        
        res.json(messages);
    } catch (e) {
        console.error('[CHAT] Fetch error:', e.message);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Send message
app.post('/api/messages', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { to_uid, text } = req.body;
    const from_uid = req.user.uid;
    
    if (!to_uid || !text) return res.status(400).json({ error: 'Target and text required' });
    
    try {
        const encrypted = encryptMessage(text);
        const result = await db.execute({
            sql: `INSERT INTO messages (from_uid, to_uid, encrypted_text) VALUES (?, ?, ?) RETURNING id, created_at`,
            args: [from_uid, to_uid, encrypted]
        });
        
        const newMsg = {
            id: result.rows[0].id,
            from_uid,
            to_uid,
            text, // Send back raw text to caller
            created_at: result.rows[0].created_at,
            reactions: null
        };

        // If target is connected via Socket, push it real-time
        if (globalUserSockets.has(to_uid)) {
            const socketIds = globalUserSockets.get(to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('new_message', newMsg);
            }
        }
        
        res.json(newMsg);
    } catch (e) {
        console.error('[CHAT] Send error:', e.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ─── SIGNALING ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout:  5000
});

const roomSessions = new Map();
const globalUserSockets = new Map(); // Map<uid, Set<socketId>>

io.on('connection', (socket) => {
    console.log(`[SOCKET] connect   id=${socket.id}`);

    socket.on('register_user', (token) => {
        try {
            const user = jwt.verify(token, JWT_SECRET);
            socket.data.uid = user.uid;
            if (!globalUserSockets.has(user.uid)) {
                globalUserSockets.set(user.uid, new Set());
                if (db) {
                    db.execute({ sql: `UPDATE users SET last_active = datetime('now') WHERE uid = ?`, args: [user.uid] }).catch(()=>{});
                }
                io.emit('user_status', { uid: user.uid, is_online: true, last_active: new Date().toISOString() });
            }
            globalUserSockets.get(user.uid).add(socket.id);
            console.log(`[SOCKET] Registered user ${user.uid} on socket ${socket.id}`);
        } catch(e) {
            console.error('[SOCKET] register_user failed: Invalid token');
        }
    });

    socket.on('mark_seen', (data) => {
        // data: { message_id, to_uid }
        if (!socket.data.uid || !data.message_id || !data.to_uid) return;
        if (db) {
            db.execute({
                sql: `UPDATE messages SET read_at = datetime('now') WHERE id = ? AND to_uid = ?`,
                args: [data.message_id, socket.data.uid]
            }).catch(()=>{});
        }
        
        // Notify the sender that this message was seen
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('message_seen', { message_id: data.message_id, by_uid: socket.data.uid });
            }
        }
    });

    socket.on('add_reaction', async (data) => {
        // data: { message_id, reaction, to_uid }
        if (!socket.data.uid || !data.message_id || !data.reaction) return;
        
        if (db) {
            try {
                const res = await db.execute({
                    sql: `SELECT reactions FROM messages WHERE id = ?`,
                    args: [data.message_id]
                });
                if (res.rows.length > 0) {
                    let reactionsObj = {};
                    if (res.rows[0].reactions) {
                        try { reactionsObj = JSON.parse(res.rows[0].reactions); } catch(e){}
                    }
                    
                    if (reactionsObj[socket.data.uid] === data.reaction) {
                        delete reactionsObj[socket.data.uid]; // Toggle off
                    } else {
                        reactionsObj[socket.data.uid] = data.reaction; // Set/change
                    }
                    
                    const newReactionsStr = Object.keys(reactionsObj).length > 0 ? JSON.stringify(reactionsObj) : null;
                    
                    await db.execute({
                        sql: `UPDATE messages SET reactions = ? WHERE id = ?`,
                        args: [newReactionsStr, data.message_id]
                    });
                    
                    const payload = { message_id: data.message_id, reactions: reactionsObj };
                    
                    if (globalUserSockets.has(data.to_uid)) {
                        for (let sId of globalUserSockets.get(data.to_uid)) {
                            io.to(sId).emit('message_reaction', payload);
                        }
                    }
                    if (globalUserSockets.has(socket.data.uid)) {
                        for (let sId of globalUserSockets.get(socket.data.uid)) {
                            io.to(sId).emit('message_reaction', payload);
                        }
                    }
                }
            } catch (e) {
                console.error('[CHAT] add_reaction error:', e.message);
            }
        }
    });
    // ─── INCOMING CALL SIGNAL ──────────────────────────────────────────────────
    socket.on('incoming_call', (data, ack) => {
        // data: { to_uid, caller, callId, isVideo }
        if (!socket.data.uid) { if (typeof ack === 'function') ack({ ok: false }); return; }
        let delivered = false;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('incoming_call', {
                    from_uid: socket.data.uid,
                    caller: data.caller,
                    callId: data.callId,
                    isVideo: data.isVideo
                });
                delivered = true;
            }
        }
        if (typeof ack === 'function') ack({ ok: delivered });
    });

    socket.on('call_reject', (data) => {
        // data: { to_uid, from_uid }
        if (!socket.data.uid) return;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('call_rejected', { by_uid: socket.data.uid });
            }
        }
    });

    socket.on('call_no_answer', (data) => {
        // data: { to_uid } — caller notifies callee it timed out
        if (!socket.data.uid) return;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('call_missed', { from_uid: socket.data.uid });
            }
        }
    });

    socket.on('join_call', (data) => {
        let callId    = typeof data === 'string' ? data : data.callId;
        let sessionId = typeof data === 'object' ? data.sessionId : 'unknown-' + socket.id;

        if (typeof callId !== 'string' || callId.length > 128) {
            socket.emit('error', { message: 'Invalid call ID' });
            return;
        }

        const room       = io.sockets.adapter.rooms.get(callId);
        const numClients = room ? room.size : 0;

        if (numClients >= 2) {
            socket.emit('error', { message: 'Room is full' });
            console.log(`[ROOM] full callId=${callId}`);
            return;
        }

        socket.join(callId);
        socket.data.callId    = callId;
        socket.data.sessionId = sessionId;

        if (!roomSessions.has(callId)) roomSessions.set(callId, new Map());
        const sessions = roomSessions.get(callId);
        if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
        sessions.get(sessionId).add(socket.id);

        const isPolite = numClients === 1;
        socket.emit('peer_role', { polite: isPolite });
        console.log(`[ROOM] join callId=${callId} polite=${isPolite} count=${numClients + 1}`);

        if (numClients === 1) io.to(callId).emit('peer_connected');
    });

    socket.on('resume_call', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (!data || typeof data.callId !== 'string') {
            callback({ status: 'resume_failed' });
            return;
        }
        const room = io.sockets.adapter.rooms.get(data.callId);

        socket.join(data.callId);
        socket.data.callId    = data.callId;
        socket.data.sessionId = data.sessionId;

        if (!roomSessions.has(data.callId)) roomSessions.set(data.callId, new Map());
        const sessions = roomSessions.get(data.callId);
        if (!sessions.has(data.sessionId)) sessions.set(data.sessionId, new Set());
        sessions.get(data.sessionId).add(socket.id);

        callback({ status: 'resume_ok' });
        if (room) socket.to(data.callId).emit('peer_connected');
        console.log(`[ROOM] resumed callId=${data.callId} id=${socket.id} (room existed: ${!!room})`);
    });

    socket.on('offer',         (data) => { if (!data?.callId) return; socket.to(data.callId).emit('offer', data); });
    socket.on('answer',        (data) => { if (!data?.callId) return; socket.to(data.callId).emit('answer', data); });
    socket.on('ice_candidate', (data) => { if (!data?.callId) return; socket.to(data.callId).emit('ice_candidate', data); });
    socket.on('call_end',      (data) => {
        if (!data?.callId) return;
        socket.to(data.callId).emit('call_end');
        console.log(`[ROOM] call_end callId=${data.callId} by=${socket.id}`);
    });
    socket.on('peer_action',   (data) => { if (!data?.callId) return; socket.to(data.callId).emit('peer_action', data); });

    socket.on('disconnecting', () => {
        // Remove from global chat map
        if (socket.data.uid) {
            const sSet = globalUserSockets.get(socket.data.uid);
            if (sSet) {
                sSet.delete(socket.id);
                if (sSet.size === 0) {
                    globalUserSockets.delete(socket.data.uid);
                    if (db) {
                        db.execute({ sql: `UPDATE users SET last_active = datetime('now') WHERE uid = ?`, args: [socket.data.uid] }).catch(()=>{});
                    }
                    io.emit('user_status', { uid: socket.data.uid, is_online: false, last_active: new Date().toISOString() });
                }
            }
        }

        const { callId, sessionId } = socket.data;
        if (!callId) return;
        console.log(`[SOCKET] disconnect callId=${callId} id=${socket.id}`);
        let sessionHasOtherSockets = false;
        if (roomSessions.has(callId)) {
            const sessions = roomSessions.get(callId);
            if (sessions.has(sessionId)) {
                sessions.get(sessionId).delete(socket.id);
                if (sessions.get(sessionId).size > 0) {
                    sessionHasOtherSockets = true;
                } else {
                    sessions.delete(sessionId);
                }
            }
            if (sessions.size === 0) {
                roomSessions.delete(callId);
                console.log(`[ROOM] destroyed callId=${callId}`);
            }
        }
        if (!sessionHasOtherSockets) socket.to(callId).emit('peer_disconnected');
    });

    socket.on('disconnect', (reason) => console.log(`[SOCKET] disconnected id=${socket.id} reason=${reason}`));
    socket.on('error', (err) => console.error(`[SOCKET] error id=${socket.id}`, err.message));
});

// ─── STATIC FRONTEND ─────────────────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'web')));

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on 0.0.0.0:${PORT}`);
    console.log(`[SERVER] TURN_HOST=${TURN_HOST || 'NOT SET'} DB=${TURSO_URL ? 'Turso' : 'NONE'} NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});
