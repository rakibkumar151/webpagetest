const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── CORS ───────────────────────────────────────────────────────────────────
// In production on Render: set FRONTEND_ORIGIN=https://your-frontend.onrender.com
// In local dev: set FRONTEND_ORIGIN=http://localhost:3000 or leave unset for open CORS
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
const isProduction  = process.env.NODE_ENV === 'production';

if (isProduction && allowedOrigin === '*') {
    console.error('[CONFIG] FATAL: FRONTEND_ORIGIN must be set in production. origin:"*" is not allowed.');
    process.exit(1);
}

app.use(cors({
    origin: allowedOrigin,
    methods: ['GET'],
    credentials: false
}));

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// ─── CONFIG (never logged) ────────────────────────────────────────────────────
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_HOST   = process.env.TURN_HOST;
const PORT        = process.env.PORT || 3000;
const TURN_TTL    = parseInt(process.env.TURN_TTL || '3600', 10);

if (!TURN_SECRET || !TURN_HOST) {
    console.warn('[CONFIG] TURN_SECRET or TURN_HOST not set — TURN credentials will be unavailable.');
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

// ─── TURN CREDENTIAL ENDPOINT ─────────────────────────────────────────────────
app.get('/api/turn-credentials', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    if (!TURN_SECRET || !TURN_HOST) {
        return res.status(503).json({ error: 'TURN service unavailable' });
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiry           = currentTimestamp + TURN_TTL;
    const username         = `${expiry}:guest`;

    const hmac = crypto.createHmac('sha1', TURN_SECRET);
    hmac.update(username);
    const credential = hmac.digest('base64');

    // Log request without secrets
    console.log(`[TURN] Credential issued — expiry=${expiry} ttl=${TURN_TTL} ip=${req.ip}`);

    return res.json({
        ttl:                 TURN_TTL,
        current_server_time: currentTimestamp,
        expiry_timestamp:    expiry,
        username,
        credential,
        urls: [
            `turn:${TURN_HOST}:3478?transport=udp`,
            `turn:${TURN_HOST}:3478?transport=tcp`,
            `turns:${TURN_HOST}:5349?transport=tcp`
        ]
    });
});

// ─── SIGNALING ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
        methods: ['GET', 'POST']
    },
    // Prefer WebSocket, fall back to polling
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout:  5000
});

// Room cleanup: track which socket owns what room
const roomOwners = new Map(); // callId → Set of socketIds

io.on('connection', (socket) => {
    console.log(`[SOCKET] connect   id=${socket.id}`);

    socket.on('join_call', (callId) => {
        if (typeof callId !== 'string' || callId.length > 64) {
            socket.emit('error', { message: 'Invalid call ID' });
            return;
        }

        const room       = io.sockets.adapter.rooms.get(callId);
        const numClients = room ? room.size : 0;

        // Max 2 participants per room
        if (numClients >= 2) {
            socket.emit('error', { message: 'Room is full' });
            console.log(`[ROOM] full callId=${callId}`);
            return;
        }

        socket.join(callId);
        socket.data.callId = callId;

        // Track socket in room registry
        if (!roomOwners.has(callId)) roomOwners.set(callId, new Set());
        roomOwners.get(callId).add(socket.id);

        const isPolite = numClients === 1;
        socket.emit('peer_role', { polite: isPolite });
        console.log(`[ROOM] join callId=${callId} polite=${isPolite} count=${numClients + 1}`);

        if (numClients === 1) {
            io.to(callId).emit('peer_connected');
        }
    });

    socket.on('resume_call', (data, callback) => {
        if (typeof callback !== 'function') return;
        if (!data || typeof data.callId !== 'string') {
            callback({ status: 'resume_failed' });
            return;
        }
        const room = io.sockets.adapter.rooms.get(data.callId);
        if (room) {
            socket.join(data.callId);
            socket.data.callId = data.callId;
            callback({ status: 'resume_ok' });
            socket.to(data.callId).emit('peer_connected');
            console.log(`[ROOM] resumed callId=${data.callId} id=${socket.id}`);
        } else {
            callback({ status: 'resume_failed' });
        }
    });

    socket.on('offer', (data) => {
        if (!data || !data.callId) return;
        socket.to(data.callId).emit('offer', data);
    });

    socket.on('answer', (data) => {
        if (!data || !data.callId) return;
        socket.to(data.callId).emit('answer', data);
    });

    socket.on('ice_candidate', (data) => {
        if (!data || !data.callId) return;
        socket.to(data.callId).emit('ice_candidate', data);
    });

    socket.on('call_end', (data) => {
        if (!data || !data.callId) return;
        socket.to(data.callId).emit('call_end');
        console.log(`[ROOM] call_end callId=${data.callId} by=${socket.id}`);
    });

    socket.on('disconnecting', () => {
        const callId = socket.data.callId;
        if (callId) {
            socket.to(callId).emit('peer_disconnected');
            console.log(`[SOCKET] disconnect callId=${callId} id=${socket.id}`);

            // Room cleanup
            if (roomOwners.has(callId)) {
                roomOwners.get(callId).delete(socket.id);
                if (roomOwners.get(callId).size === 0) {
                    roomOwners.delete(callId);
                    console.log(`[ROOM] destroyed callId=${callId}`);
                }
            }
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[SOCKET] disconnected id=${socket.id} reason=${reason}`);
    });

    socket.on('error', (err) => {
        console.error(`[SOCKET] error id=${socket.id}`, err.message);
    });
});

// ─── STATIC FRONTEND (served for testing and local use) ─────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'web')));

// ─── START ────────────────────────────────────────────────────────────────────
// Bind to 0.0.0.0 explicitly — required for Docker and Render
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on 0.0.0.0:${PORT}`);
    // Do NOT log TURN_SECRET
    console.log(`[SERVER] TURN_HOST=${TURN_HOST || 'NOT SET'} FRONTEND_ORIGIN=${allowedOrigin} NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});
