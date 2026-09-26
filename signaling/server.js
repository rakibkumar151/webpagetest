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
app.use(express.json({ limit: '1mb' }));

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
                    created_at   TEXT DEFAULT (datetime('now'))
                )
            `);
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
        res.json({ token, uid: user.uid, username: user.username, first_name: user.first_name, last_name: user.last_name });
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
            sql: `SELECT uid, username, first_name, last_name, email, created_at FROM users WHERE uid = ? LIMIT 1`,
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
                sql: `SELECT uid, username, first_name, last_name FROM users
                      WHERE (username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR uid LIKE ?)
                      AND uid != ? LIMIT 40`,
                args: [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, req.user.uid]
            });
        } else {
            result = await db.execute({
                sql: `SELECT uid, username, first_name, last_name FROM users
                      WHERE uid != ? ORDER BY created_at DESC LIMIT 40`,
                args: [req.user.uid]
            });
        }
        res.json(result.rows);
    } catch (e) {
        console.error('[USERS] List error:', e.message);
        res.status(500).json({ error: 'Failed to load users' });
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

io.on('connection', (socket) => {
    console.log(`[SOCKET] connect   id=${socket.id}`);

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
