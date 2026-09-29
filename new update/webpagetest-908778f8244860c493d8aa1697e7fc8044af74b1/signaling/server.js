const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@libsql/client');
const nodemailer = require('nodemailer');
const net = require('net');

// ─── SMTP PROXY: Residential proxy tunnel to bypass Render SMTP block ─────────
const PROXY_HOST = 'change4.owlproxy.com';
const PROXY_PORT = 7778;
const PROXY_USER = 'izUU8KQkEm50_custom_zone_IN_st__city_sid_26821469_time_5';
const PROXY_PASS = '5559057';
const SMTP_HOST  = 'smtp.gmail.com';
const SMTP_PORT  = 587;

function createProxyTunnel() {
    return new Promise((resolve, reject) => {
        const socket = net.connect(PROXY_PORT, PROXY_HOST, () => {
            const auth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
            socket.write(
                `CONNECT ${SMTP_HOST}:${SMTP_PORT} HTTP/1.1\r\n` +
                `Host: ${SMTP_HOST}:${SMTP_PORT}\r\n` +
                `Proxy-Authorization: Basic ${auth}\r\n` +
                `Connection: keep-alive\r\n\r\n`
            );
        });
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('\r\n\r\n')) {
                if (buffer.includes('200')) {
                    socket.removeAllListeners('data');
                    resolve(socket);
                } else {
                    socket.destroy();
                    reject(new Error('Proxy failed: ' + buffer.split('\r\n')[0]));
                }
            }
        });
        socket.on('error', reject);
        socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Proxy timeout')); });
    });
}

// Creates a local TCP server that pipes connections through the proxy tunnel
// nodemailer → localhost:port → proxy tunnel → smtp.gmail.com:587
function createLocalSmtpProxy() {
    return new Promise((resolve, reject) => {
        const server = net.createServer(async (clientSocket) => {
            try {
                const proxySocket = await createProxyTunnel();
                clientSocket.pipe(proxySocket);
                proxySocket.pipe(clientSocket);
                clientSocket.on('error', () => proxySocket.destroy());
                proxySocket.on('error', () => clientSocket.destroy());
                clientSocket.on('close', () => proxySocket.destroy());
                proxySocket.on('close', () => clientSocket.destroy());
            } catch (e) {
                console.error('[SMTP-PROXY] Tunnel failed:', e.message);
                clientSocket.destroy();
            }
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
        server.on('error', reject);
    });
}

async function sendOtpEmail(toEmail, otp, context = 'register') {
    const isReset = context === 'reset';
    const subject = isReset ? 'Reset Your Chet Password' : 'Your Chet Verification Code';
    const title = isReset ? 'Password Reset Request' : 'Welcome to Chet!';
    const bodyText = isReset ? 'You requested a password reset.' : 'We are excited to have you on board.';
    
    const mailOpts = {
        from: 'Chet <rakibkumar151@gmail.com>',
        to: toEmail,
        subject: subject,
        text: `${bodyText}\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
        html: `<h3>${title}</h3><p>${bodyText}</p><p>Your verification code is: <b style="font-size:24px;color:#7c6cff">${otp}</b></p><p>This code expires in 10 minutes.</p>`
    };

    // Try via residential proxy tunnel (bypasses Render SMTP block)
    try {
        const { server, port } = await createLocalSmtpProxy();
        const transport = nodemailer.createTransport({
            host: '127.0.0.1',
            port,
            secure: false,
            auth: { user: 'rakibkumar151@gmail.com', pass: 'ziasmvxfmtaxrxbx' },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 20000,
            greetingTimeout: 20000
        });
        const info = await transport.sendMail(mailOpts);
        server.close();
        return info;
    } catch (proxyErr) {
        console.error('[SMTP-PROXY] Proxy send failed, trying direct SMTP:', proxyErr.message);
        // Fallback: direct Gmail SMTP (works locally)
        const transport = nodemailer.createTransport({
            host: SMTP_HOST, port: SMTP_PORT, secure: false,
            auth: { user: 'rakibkumar151@gmail.com', pass: 'ziasmvxfmtaxrxbx' },
            tls: { rejectUnauthorized: false }
        });
        return transport.sendMail(mailOpts);
    }
}


const otpStore = new Map(); // email -> { otp, data, expiresAt }
setInterval(() => {
    const now = Date.now();
    for (const [email, entry] of otpStore.entries()) {
        if (now > entry.expiresAt) otpStore.delete(email);
    }
}, 60000);

const app = express();
app.set('trust proxy', 1); // Render is behind a reverse proxy

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
    validate: { xForwardedForHeader: false }, // disable X-Forwarded-For validation warning
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
            const migrationCols = [
                { t: 'users', c: 'last_active', d: 'TEXT' },
                { t: 'users', c: 'profile_photo', d: 'TEXT' },
                { t: 'messages', c: 'read_at', d: 'TEXT' },
                { t: 'messages', c: 'reactions', d: 'TEXT' },
                { t: 'users', c: 'is_verified', d: 'INTEGER DEFAULT 0' },
                { t: 'users', c: 'bio', d: 'TEXT' },
                { t: 'users', c: 'tagline', d: 'TEXT' },
                { t: 'users', c: 'location', d: 'TEXT' },
                { t: 'users', c: 'cover_photo', d: 'TEXT' }
            ];
            for (const col of migrationCols) {
                try {
                    await db.execute(`ALTER TABLE ${col.t} ADD COLUMN ${col.c} ${col.d}`);
                    console.log(`[DB] Migration added ${col.c} to ${col.t}`);
                } catch(e) {
                    // Ignored if column already exists
                }
            }

            // Create verified_uids table — paneer edits this directly in Turso dashboard
            await db.execute(`
                CREATE TABLE IF NOT EXISTS verified_uids (
                    uid        TEXT PRIMARY KEY,
                    added_at   TEXT DEFAULT (datetime('now'))
                )
            `);

            await db.execute(`
                CREATE TABLE IF NOT EXISTS email_domain_rules (
                    domain     TEXT PRIMARY KEY,
                    rule_type  TEXT NOT NULL DEFAULT 'allow', -- 'allow' or 'block'
                    added_at   TEXT DEFAULT (datetime('now'))
                )
            `);
            // Seed 'gmail.com' as an allowed domain by default so paneer can see it and edit later
            try {
                await db.execute(`INSERT OR IGNORE INTO email_domain_rules (domain, rule_type) VALUES ('gmail.com', 'allow')`);
            } catch (e) {}
            
            dbReady = true;
            console.log('[DB] Turso connected and tables ready');

            // ── Auto-sync verified badges every 30 seconds ──────────────────
            // Reads verified_uids table → syncs is_verified on users table
            // Broadcasts user_verified socket event for any change
            let lastVerifiedSnapshot = new Set();

            async function syncVerifiedBadges() {
                if (!db) return;
                try {
                    const res = await db.execute(`SELECT uid FROM verified_uids`);
                    const currentSet = new Set(res.rows.map(r => r.uid));

                    // Find newly verified UIDs
                    for (const uid of currentSet) {
                        if (!lastVerifiedSnapshot.has(uid)) {
                            await db.execute({ sql: `UPDATE users SET is_verified = 1 WHERE uid = ?`, args: [uid] });
                            if (io) io.emit('user_verified', { uid, is_verified: true });
                            console.log(`[VERIFY] Badge granted: ${uid}`);
                        }
                    }
                    // Find UIDs that were removed
                    for (const uid of lastVerifiedSnapshot) {
                        if (!currentSet.has(uid)) {
                            await db.execute({ sql: `UPDATE users SET is_verified = 0 WHERE uid = ?`, args: [uid] });
                            if (io) io.emit('user_verified', { uid, is_verified: false });
                            console.log(`[VERIFY] Badge revoked: ${uid}`);
                        }
                    }
                    lastVerifiedSnapshot = currentSet;
                } catch(e) {
                    console.error('[VERIFY] Sync error:', e.message);
                }
            }

            // Initial sync on startup, then every 30s
            setTimeout(syncVerifiedBadges, 3000);
            setInterval(syncVerifiedBadges, 30000);

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

// ─── DB SCHEMA CHECK (debug endpoint) ──────────────────────────────────────
app.get('/api/db-schema', async (_req, res) => {
    if (!db) return res.json({ ok: false, error: 'No DB' });
    try {
        const pragma = await db.execute(`PRAGMA table_info(users)`);
        const cols = pragma.rows.map(r => ({ name: r.name, type: r.type, default: r.dflt_value }));
        const wanted = ['bio', 'tagline', 'location', 'cover_photo', 'is_verified', 'profile_photo'];
        const existing = cols.map(c => c.name);
        const missing = wanted.filter(c => !existing.includes(c));
        res.json({ ok: true, columns: cols, missing });
    } catch(e) {
        res.json({ ok: false, error: e.message });
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
        const domainMatch = email.match(/@(.+)$/);
        if (domainMatch) {
            const domain = domainMatch[1].toLowerCase().trim();
            
            // Check if there are ANY allow rules
            const hasAllowRulesRes = await db.execute(`SELECT 1 FROM email_domain_rules WHERE rule_type = 'allow' LIMIT 1`);
            const hasAllowRules = hasAllowRulesRes.rows.length > 0;
            
            if (hasAllowRules) {
                // If there are allow rules, the domain MUST be in the allow list
                const isAllowedRes = await db.execute(`SELECT 1 FROM email_domain_rules WHERE domain = ? AND rule_type = 'allow'`, [domain]);
                if (isAllowedRes.rows.length === 0) {
                    return res.status(403).json({ error: `Only specific domains are allowed. Email domain @${domain} is not permitted.` });
                }
            }
            
            // Check if the domain is explicitly blocked
            const isBlockedRes = await db.execute(`SELECT 1 FROM email_domain_rules WHERE domain = ? AND rule_type = 'block'`, [domain]);
            if (isBlockedRes.rows.length > 0) {
                return res.status(403).json({ error: `Email domain @${domain} is blocked.` });
            }
        }

        const existing = await db.execute({
            sql: `SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1`,
            args: [username.toLowerCase(), email.toLowerCase().trim()]
        });
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Username or email is already taken' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP
        const password_hash = await bcrypt.hash(password, 12);
        
        otpStore.set(email.toLowerCase().trim(), {
            otp,
            data: { username: username.toLowerCase(), first_name: first_name.trim(), last_name: last_name.trim(), email: email.toLowerCase().trim(), password_hash },
            expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
        });

        // Log OTP to server console as fallback (check Render logs if email fails)
        console.log(`[OTP] email=${email.toLowerCase().trim()} otp=${otp}`);

        sendOtpEmail(email.toLowerCase().trim(), otp)
            .then(info => console.log('[AUTH] Email sent OK:', JSON.stringify(info)))
            .catch(err => console.error('[AUTH] Email send FAILED:', err.message));

        res.json({ success: true, requireOtp: true, message: 'OTP sent to your email.' });
    } catch (e) {
        console.error('[AUTH] Register error:', e.message);
        res.status(500).json({ error: 'Failed to send OTP email: ' + e.message });
    }
});

// ─── AUTH: VERIFY OTP ────────────────────────────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });
    
    const record = otpStore.get(email.toLowerCase().trim());
    if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
    
    try {
        const { username, first_name, last_name, password_hash } = record.data;
        const uid = 'UID' + Math.floor(1000000 + Math.random() * 9000000);
        await db.execute({
            sql: `INSERT INTO users (uid, username, first_name, last_name, email, password_hash)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [uid, username, first_name, last_name, email.toLowerCase().trim(), password_hash]
        });
        
        otpStore.delete(email.toLowerCase().trim()); // Clean up OTP
        
        const token = jwt.sign({ uid, username }, JWT_SECRET, { expiresIn: '30d' });
        console.log(`[AUTH] Registered & Verified uid=${uid} username=${username}`);
        res.json({ token, uid, username, first_name, last_name, is_verified: false });
    } catch (e) {
        if (e.message?.includes('UNIQUE') || e.message?.includes('SQLITE_CONSTRAINT')) {
            res.status(409).json({ error: 'Username or email is already taken' });
        } else {
            console.error('[AUTH] OTP verify error:', e.message);
            res.status(500).json({ error: 'Verification failed: ' + e.message });
        }
    }
});
// ─── AUTH: FETCH DOMAIN RULES ──────────────────────────────────────────────────
app.get('/api/auth/domain-rules', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
        const rules = await db.execute(`SELECT domain, rule_type FROM email_domain_rules`);
        const allowedDomains = rules.rows.filter(r => r.rule_type === 'allow').map(r => r.domain);
        const blockedDomains = rules.rows.filter(r => r.rule_type === 'block').map(r => r.domain);
        res.json({
            hasAllowRules: allowedDomains.length > 0,
            allowedDomains,
            blockedDomains
        });
    } catch (e) {
        console.error('[AUTH] Error fetching domain rules:', e.message);
        res.status(500).json({ error: 'Internal error' });
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
        res.json({ token, uid: user.uid, username: user.username, first_name: user.first_name, last_name: user.last_name, profile_photo: user.profile_photo, is_verified: user.is_verified === 1 || user.is_verified === true });
    } catch (e) {
        console.error('[AUTH] Login error:', e.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ─── AUTH: FORGOT PASSWORD ───────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        const result = await db.execute({
            sql: `SELECT id FROM users WHERE email = ? LIMIT 1`,
            args: [email.toLowerCase().trim()]
        });
        if (result.rows.length === 0) {
            // For security, do not reveal if email exists, just return success
            return res.json({ success: true, message: 'If an account exists, an OTP will be sent.' });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email.toLowerCase().trim(), {
            otp,
            type: 'reset',
            expiresAt: Date.now() + 10 * 60 * 1000
        });

        console.log(`[OTP-RESET] email=${email.toLowerCase().trim()} otp=${otp}`);
        
        sendOtpEmail(email.toLowerCase().trim(), otp, 'reset')
            .then(info => console.log('[AUTH] Reset email sent OK'))
            .catch(err => console.error('[AUTH] Reset email send FAILED:', err.message));

        res.json({ success: true, message: 'OTP sent to your email.' });
    } catch (e) {
        console.error('[AUTH] Forgot password error:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/verify-reset-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const emailKey = email.toLowerCase().trim();
    const entry = otpStore.get(emailKey);

    if (!entry || entry.otp !== otp || entry.type !== 'reset') {
        return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    if (Date.now() > entry.expiresAt) {
        otpStore.delete(emailKey);
        return res.status(401).json({ error: 'OTP expired' });
    }

    // OTP valid. Remove it, and generate a short-lived reset token
    otpStore.delete(emailKey);
    const resetToken = jwt.sign({ email: emailKey, type: 'reset' }, JWT_SECRET, { expiresIn: '15m' });
    
    res.json({ success: true, resetToken });
});

app.post('/api/auth/reset-password', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
        const decoded = jwt.verify(resetToken, JWT_SECRET);
        if (decoded.type !== 'reset' || !decoded.email) {
            return res.status(401).json({ error: 'Invalid token type' });
        }

        const email = decoded.email;
        const passwordHash = await bcrypt.hash(newPassword, 10);

        await db.execute({
            sql: `UPDATE users SET password_hash = ? WHERE email = ?`,
            args: [passwordHash, email]
        });

        console.log(`[AUTH] Password reset for email=${email}`);
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (e) {
        console.error('[AUTH] Reset password error:', e.message);
        if (e.name === 'TokenExpiredError' || e.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Token expired or invalid. Please request a new OTP.' });
        }
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ─── AUTH: ME ────────────────────────────────────────────────────────────────
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE uid = ? LIMIT 1`,
            args: [req.user.uid]
        });
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        const user = result.rows[0];
        delete user.password_hash;
        user.is_verified = user.is_verified === 1 || user.is_verified === true;
        user.is_online = globalUserSockets.has(user.uid);
        user.bio = user.bio || null;
        user.tagline = user.tagline || null;
        user.location = user.location || null;
        user.cover_photo = user.cover_photo || null;
        res.json(user);
    } catch (e) {
        console.error('[AUTH ME] Error loading profile:', e.message);
        res.status(500).json({ error: 'Failed to load profile: ' + e.message });
    }
});

// ─── USERS: GET SPECIFIC USER PROFILE ─────────────────────────────────────────
app.get('/api/users/:uid', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const targetUid = req.params.uid;
    try {
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE uid = ? LIMIT 1`,
            args: [targetUid]
        });
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        const u = result.rows[0];
        delete u.password_hash;
        u.is_verified = u.is_verified === 1 || u.is_verified === true;
        u.is_online = globalUserSockets.has(u.uid);
        u.bio = u.bio || null;
        u.tagline = u.tagline || null;
        u.location = u.location || null;
        u.cover_photo = u.cover_photo || null;
        res.json(u);
    } catch (e) {
        console.error('[USERS] Get profile error:', e.message);
        res.status(500).json({ error: 'Failed to load profile: ' + e.message });
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
        const users = result.rows.map(u => {
            delete u.password_hash;
            return {
                ...u,
                is_online: globalUserSockets.has(u.uid),
                is_verified: u.is_verified === 1 || u.is_verified === true,
                bio: u.bio || null,
                tagline: u.tagline || null,
                location: u.location || null,
                cover_photo: u.cover_photo || null
            };
        });
        res.json(users);
    } catch (e) {
        console.error('[USERS] List error:', e.message);
        res.status(500).json({ error: 'Failed to load users: ' + e.message });
    }
});

// ─── USERS: UPDATE PROFILE (FULL PROFILE & REALTIME) ──────────────────────────
app.post('/api/users/profile', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { first_name, last_name, bio, tagline, location, profile_photo, cover_photo } = req.body;
    
    if (profile_photo && profile_photo.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Profile image too large' });
    }
    if (cover_photo && cover_photo.length > 7 * 1024 * 1024) {
        return res.status(400).json({ error: 'Cover image too large' });
    }

    try {
        await db.execute({
            sql: `UPDATE users SET 
                    first_name = COALESCE(?, first_name),
                    last_name  = COALESCE(?, last_name),
                    bio        = ?,
                    tagline    = ?,
                    location   = ?,
                    profile_photo = COALESCE(?, profile_photo),
                    cover_photo   = COALESCE(?, cover_photo)
                  WHERE uid = ?`,
            args: [
                first_name ? first_name.trim() : null,
                last_name ? last_name.trim() : null,
                bio !== undefined ? (bio ? bio.trim() : null) : null,
                tagline !== undefined ? (tagline ? tagline.trim() : null) : null,
                location !== undefined ? (location ? location.trim() : null) : null,
                profile_photo || null,
                cover_photo || null,
                req.user.uid
            ]
        });

        // Get updated profile data
        const updatedRes = await db.execute({
            sql: `SELECT * FROM users WHERE uid = ? LIMIT 1`,
            args: [req.user.uid]
        });
        const updatedUser = updatedRes.rows[0];
        if (updatedUser) {
            delete updatedUser.password_hash;
            updatedUser.is_verified = updatedUser.is_verified === 1 || updatedUser.is_verified === true;
            updatedUser.is_online = true;

            // Broadcast real-time profile update to ALL connected users
            io.emit('profile_updated', updatedUser);
            res.json({ success: true, user: updatedUser });
        } else {
            res.json({ success: true });
        }
    } catch (e) {
        console.error('[USERS] Update profile error:', e.message);
        res.status(500).json({ error: 'Failed to update profile: ' + e.message });
    }
});

// ─── USERS: UPDATE PROFILE PHOTO (COMPATIBILITY) ─────────────────────────────
app.post('/api/users/profile-photo', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { profile_photo } = req.body;
    
    if (profile_photo && profile_photo.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large' });
    }

    try {
        await db.execute({
            sql: `UPDATE users SET profile_photo = ? WHERE uid = ?`,
            args: [profile_photo || null, req.user.uid]
        });

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

// ─── USERS: TOGGLE VERIFIED BADGE (Admin only via ADMIN_SECRET header) ────────
app.post('/api/users/verify', authMiddleware, async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { uid, is_verified } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    try {
        await db.execute({
            sql: `UPDATE users SET is_verified = ? WHERE uid = ?`,
            args: [is_verified ? 1 : 0, uid]
        });
        // Broadcast so all clients update instantly
        io.emit('user_verified', { uid, is_verified: !!is_verified });
        res.json({ success: true });
    } catch (e) {
        console.error('[USERS] Verify error:', e.message);
        res.status(500).json({ error: 'Failed to update verification' });
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
            sql: `SELECT * FROM (
                    SELECT * FROM messages 
                    WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
                    ORDER BY created_at DESC LIMIT 100
                  ) ORDER BY created_at ASC`,
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
    pingInterval: 8000,
    pingTimeout:  4000,
    connectTimeout: 10000,
    upgradeTimeout: 10000
});

const roomSessions   = new Map();
const globalUserSockets = new Map(); // Map<uid, Set<socketId>>

// Pending calls: if receiver is offline, queue the call for 30s
// Map<to_uid, { data, expiresAt, timeout }>
const pendingCalls = new Map();

function deliverPendingCall(uid) {
    if (!pendingCalls.has(uid)) return;
    const pending = pendingCalls.get(uid);
    clearTimeout(pending.timeout);
    pendingCalls.delete(uid);
    if (Date.now() < pending.expiresAt && globalUserSockets.has(uid)) {
        const socketIds = globalUserSockets.get(uid);
        for (let sId of socketIds) {
            io.to(sId).emit('incoming_call', pending.data);
        }
        console.log(`[CALL] Delivered pending call to ${uid} on reconnect`);
    }
}

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

            // Deliver pending call if any
            deliverPendingCall(user.uid);
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

    // ─── SUPER FAST TCP MESSAGE SEND ──────────────────────────────────────────
    socket.on('send_message', async (data, ack) => {
        const from_uid = socket.data.uid;
        if (!from_uid || !data.to_uid || !data.text) return;
        
        try {
            // 1. Immediately save to DB to get the real ID
            const encrypted = encryptMessage(data.text);
            const result = await db.execute({
                sql: `INSERT INTO messages (from_uid, to_uid, encrypted_text) VALUES (?, ?, ?) RETURNING id, created_at`,
                args: [from_uid, data.to_uid, encrypted]
            });
            
            const newMsg = {
                id: result.rows[0].id,
                from_uid,
                to_uid: data.to_uid,
                text: data.text,
                created_at: result.rows[0].created_at,
                reactions: null
            };

            // 2. Push to receiver instantly via TCP/WebSocket
            if (globalUserSockets.has(data.to_uid)) {
                const socketIds = globalUserSockets.get(data.to_uid);
                for (let sId of socketIds) {
                    io.to(sId).emit('new_message', newMsg);
                }
            }
            
            // 3. Return ack to sender instantly
            if (typeof ack === 'function') ack({ success: true, message: newMsg });
        } catch(e) {
            console.error('[CHAT] send_message error:', e.message);
            if (typeof ack === 'function') ack({ success: false, error: e.message });
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
            // Clear any existing pending call for this uid (stale)
            if (pendingCalls.has(data.to_uid)) {
                clearTimeout(pendingCalls.get(data.to_uid).timeout);
                pendingCalls.delete(data.to_uid);
            }
        } else {
            // Receiver offline — queue call for 30s
            const callPayload = {
                from_uid: socket.data.uid,
                caller: data.caller,
                callId: data.callId,
                isVideo: data.isVideo
            };
            const QUEUE_TTL = 30000;
            if (pendingCalls.has(data.to_uid)) {
                clearTimeout(pendingCalls.get(data.to_uid).timeout);
            }
            const expireTimeout = setTimeout(() => pendingCalls.delete(data.to_uid), QUEUE_TTL);
            pendingCalls.set(data.to_uid, {
                data: callPayload,
                expiresAt: Date.now() + QUEUE_TTL,
                timeout: expireTimeout
            });
            console.log(`[CALL] Receiver ${data.to_uid} offline — queued call for 30s`);
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

    socket.on('call_busy', (data) => {
        // data: { to_uid }
        if (!socket.data.uid) return;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('call_busy', { by_uid: socket.data.uid });
            }
        }
    });

    socket.on('call_ringing', (data) => {
        // data: { to_uid }
        if (!socket.data.uid) return;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('call_ringing', { by_uid: socket.data.uid });
            }
        }
    });

    socket.on('call_accepted', (data) => {
        // data: { to_uid, callId }
        if (!socket.data.uid) return;
        if (globalUserSockets.has(data.to_uid)) {
            const socketIds = globalUserSockets.get(data.to_uid);
            for (let sId of socketIds) {
                io.to(sId).emit('call_accepted', { by_uid: socket.data.uid, callId: data.callId });
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
app.use(express.static(path.join(__dirname, '..', 'web'), {
    setHeaders: (res, pathStr) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on 0.0.0.0:${PORT}`);
    console.log(`[SERVER] TURN_HOST=${TURN_HOST || 'NOT SET'} DB=${TURSO_URL ? 'Turso' : 'NONE'} NODE_ENV=${process.env.NODE_ENV || 'development'}`);

    // ─── KEEP-ALIVE: self-ping every 13 mins to prevent Render free tier sleep ──
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        const https = require('https');
        const http  = require('http');
        const mod   = serverUrl.startsWith('https') ? https : http;
        mod.get(`${serverUrl}/api/health`, (res) => {
            console.log(`[KEEP-ALIVE] ping OK status=${res.statusCode}`);
        }).on('error', (e) => {
            console.warn('[KEEP-ALIVE] ping failed:', e.message);
        });
    }, 13 * 60 * 1000); // every 13 minutes
});
