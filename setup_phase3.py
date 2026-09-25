import os

base_dir = r"C:\Users\abc\Desktop\my chet\webrtc-voice-call"

files = {
    r"signaling\server.js": """const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors()); // In production, configure specific origin

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', apiLimiter);

const TURN_SECRET = process.env.TURN_SECRET || 'dev_secret_key';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';

app.get('/api/turn-credentials', (req, res) => {
    // Generate short-lived ephemeral TURN credentials
    const ttl = 3600; 
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    const username = `${timestamp}:guest`;
    
    const hmac = crypto.createHmac('sha1', TURN_SECRET);
    hmac.update(username);
    const credential = hmac.digest('base64');
    
    res.json({
        ttl,
        username,
        credential,
        urls: [
            `turn:${TURN_HOST}:3478?transport=udp`,
            `turn:${TURN_HOST}:3478?transport=tcp`
        ]
    });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    socket.on('join_call', (callId) => {
        const room = io.sockets.adapter.rooms.get(callId);
        const numClients = room ? room.size : 0;
        socket.join(callId);
        
        if (numClients === 0) {
            socket.emit('peer_role', { polite: false });
        } else {
            socket.emit('peer_role', { polite: true });
            io.to(callId).emit('peer_connected');
        }
    });

    socket.on('resume_call', (data, callback) => {
        const room = io.sockets.adapter.rooms.get(data.callId);
        if (room) {
            socket.join(data.callId);
            callback({ status: 'resume_ok' });
            socket.to(data.callId).emit('peer_connected');
        } else {
            callback({ status: 'resume_failed' });
        }
    });

    socket.on('offer', data => socket.to(data.callId).emit('offer', data));
    socket.on('answer', data => socket.to(data.callId).emit('answer', data));
    socket.on('ice_candidate', data => socket.to(data.callId).emit('ice_candidate', data));
    socket.on('call_end', data => socket.to(data.callId).emit('call_end'));
    
    socket.on('disconnecting', () => {
        for (const room of socket.rooms) {
            if (room !== socket.id) socket.to(room).emit('peer_disconnected');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on ' + PORT));
""",
    r"web\index.html": """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Voice Call</title>
    <link rel="stylesheet" href="index.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body>
    <div class="app-container">
        <header class="app-header">
            <h1>SecureVoice</h1>
        </header>

        <main class="main-content">
            <!-- Error Notification -->
            <div id="errorNotification" class="error-notification hidden"></div>

            <!-- Join Screen -->
            <div id="joinScreen" class="screen active">
                <div class="card">
                    <h2>Join a Call</h2>
                    <p>Enter a code to connect securely</p>
                    <div class="input-group">
                        <input type="text" id="callIdInput" placeholder="Enter Call Code" autocomplete="off" />
                        <button id="joinBtn" class="btn primary">Join Call</button>
                    </div>
                </div>
            </div>

            <!-- Call Screen -->
            <div id="callScreen" class="screen hidden">
                <div class="call-card">
                    <div class="avatar-circle">
                        <div class="pulse-ring"></div>
                        <span class="avatar-icon">👤</span>
                    </div>
                    <div class="call-info">
                        <h2 id="peerName">Peer</h2>
                        <span id="callTimer" class="timer">00:00</span>
                    </div>
                    
                    <div class="status-container">
                        <span id="statusIndicator" class="status-dot idle"></span>
                        <span id="status" class="status-text idle">IDLE</span>
                    </div>
                    
                    <div class="quality-indicator hidden" id="qualityIndicator">
                        Signal: <span id="qualityText">Good</span>
                    </div>

                    <div class="controls">
                        <button id="muteBtn" class="btn control-btn">
                            <span id="muteIcon">🎙️</span>
                        </button>
                        <button id="hangupBtn" class="btn control-btn danger">
                            <span>📞</span>
                        </button>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <audio id="remoteAudio" autoplay></audio>
    <script src="http://localhost:3000/socket.io/socket.io.js"></script>
    <script src="app.js"></script>
</body>
</html>
""",
    r"web\index.css": """
:root {
    --bg-color: #0f172a;
    --card-bg: #1e293b;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --primary: #3b82f6;
    --primary-hover: #2563eb;
    --danger: #ef4444;
    --danger-hover: #dc2828;
    --success: #10b981;
    --warning: #f59e0b;
    --border: #334155;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: 'Inter', sans-serif;
    background-color: var(--bg-color);
    color: var(--text-primary);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 1rem;
}

.app-container {
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 2rem;
}

.app-header h1 {
    text-align: center;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: 1px;
    background: linear-gradient(to right, #60a5fa, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.screen { display: none; }
.screen.active { display: block; animation: fadeIn 0.3s ease; }

.hidden { display: none !important; }

.card, .call-card {
    background-color: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 2rem;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
}

.card h2 { font-size: 1.25rem; }
.card p { color: var(--text-secondary); font-size: 0.9rem; }

.input-group { width: 100%; display: flex; flex-direction: column; gap: 1rem; }

input[type="text"] {
    width: 100%;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background-color: rgba(15, 23, 42, 0.5);
    color: var(--text-primary);
    font-size: 1rem;
    outline: none;
    transition: border-color 0.2s;
}
input[type="text"]:focus { border-color: var(--primary); }

.btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 0.5rem;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s, transform 0.1s;
    display: flex;
    justify-content: center;
    align-items: center;
}
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn.primary { background-color: var(--primary); color: white; }
.btn.primary:hover:not(:disabled) { background-color: var(--primary-hover); }

.controls {
    display: flex;
    gap: 1.5rem;
    margin-top: 1rem;
}
.control-btn {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background-color: var(--border);
    color: white;
    font-size: 1.5rem;
}
.control-btn.active { background-color: var(--text-secondary); }
.control-btn.danger { background-color: var(--danger); }
.control-btn.danger:hover:not(:disabled) { background-color: var(--danger-hover); }

/* Avatar Animation */
.avatar-circle {
    position: relative;
    width: 100px;
    height: 100px;
    border-radius: 50%;
    background-color: var(--border);
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
}

.pulse-ring {
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid var(--primary);
    animation: pulse 2s infinite cubic-bezier(0.215, 0.61, 0.355, 1);
    opacity: 0;
    display: none;
}
.ringing .pulse-ring, .connecting .pulse-ring { display: block; }
.connected .pulse-ring { border-color: var(--success); display: block; animation: pulse-slow 3s infinite; }

.call-info { text-align: center; }
.call-info h2 { font-size: 1.25rem; margin-bottom: 0.25rem; }
.timer { font-size: 0.9rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

.status-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background-color: rgba(15, 23, 42, 0.5);
    border-radius: 2rem;
    font-size: 0.85rem;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; }
.status-dot.idle { background-color: var(--text-secondary); }
.status-dot.connecting { background-color: var(--primary); }
.status-dot.connected { background-color: var(--success); }
.status-dot.reconnecting, .status-dot.degraded, .status-dot.recovering { background-color: var(--warning); }
.status-dot.failed, .status-dot.ended { background-color: var(--danger); }

.status-text { color: var(--text-secondary); }
.quality-indicator { font-size: 0.8rem; color: var(--text-secondary); }

.error-notification {
    background-color: var(--danger);
    color: white;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    text-align: center;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
}

@keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0% { transform: scale(1); opacity: 0.8; } 100% { transform: scale(1.5); opacity: 0; } }
@keyframes pulse-slow { 0% { transform: scale(1); opacity: 0.3; } 100% { transform: scale(1.2); opacity: 0; } }
""",
    r"web\app.js": """const socket = io('http://localhost:3000', {
    reconnectionDelay: 1000,
    reconnectionDelayMax: 16000,
    randomizationFactor: 0.5
});

const joinScreen = document.getElementById('joinScreen');
const callScreen = document.getElementById('callScreen');
const callIdInput = document.getElementById('callIdInput');
const joinBtn = document.getElementById('joinBtn');
const hangupBtn = document.getElementById('hangupBtn');
const muteBtn = document.getElementById('muteBtn');
const muteIcon = document.getElementById('muteIcon');
const statusSpan = document.getElementById('status');
const statusIndicator = document.getElementById('statusIndicator');
const callTimer = document.getElementById('callTimer');
const errorNotification = document.getElementById('errorNotification');
const remoteAudio = document.getElementById('remoteAudio');
const avatarCircle = document.querySelector('.avatar-circle');

let localStream = null;
let pc = null;
let currentCallId = null;
let sessionId = Math.random().toString(36).substring(2);

let polite = false;
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;
let pendingCandidates = [];

let appState = 'IDLE';
let manualHangup = false;
let isMuted = false;

let timerInterval = null;
let secondsConnected = 0;
let hasFetchedCredentials = false;

let rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

function log(msg, ...args) {
    console.log(`[WEBRTC] ${msg}`, ...args);
}

function showError(msg, duration = 5000) {
    errorNotification.textContent = msg;
    errorNotification.classList.remove('hidden');
    setTimeout(() => errorNotification.classList.add('hidden'), duration);
}

function switchScreen(screen) {
    if (screen === 'call') {
        joinScreen.classList.remove('active');
        callScreen.classList.add('active');
    } else {
        callScreen.classList.remove('active');
        joinScreen.classList.add('active');
    }
}

function updateTimerDisplay() {
    const m = Math.floor(secondsConnected / 60).toString().padStart(2, '0');
    const s = (secondsConnected % 60).toString().padStart(2, '0');
    callTimer.textContent = `${m}:${s}`;
}

function startTimer() {
    if (!timerInterval) {
        timerInterval = setInterval(() => {
            secondsConnected++;
            updateTimerDisplay();
        }, 1000);
    }
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function changeAppState(newState, uiMsg) {
    if (manualHangup && newState !== 'ENDED' && newState !== 'IDLE') return;
    appState = newState;
    
    // UI mapping
    statusSpan.textContent = uiMsg || newState;
    
    // Update indicator dot
    statusIndicator.className = 'status-dot ' + newState.toLowerCase();
    
    // Update avatar animation
    avatarCircle.className = 'avatar-circle ' + newState.toLowerCase();
    
    if (newState === 'CONNECTED') {
        startTimer();
    } else if (newState === 'ENDED' || newState === 'FAILED' || newState === 'IDLE') {
        stopTimer();
    }
}

async function fetchTurnCredentials() {
    if (hasFetchedCredentials) return true;
    try {
        const response = await fetch('http://localhost:3000/api/turn-credentials');
        if (!response.ok) throw new Error('API failed');
        const data = await response.json();
        
        rtcConfig.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: data.urls,
                username: data.username,
                credential: data.credential
            }
        ];
        hasFetchedCredentials = true;
        return true;
    } catch (e) {
        log('Failed to fetch TURN credentials', e);
        showError('Voice connection service is temporarily unavailable. Using STUN only.');
        return false;
    }
}

const RecoveryManager = {
    retryCount: 0,
    rebuildCount: 0,
    maxIceRestarts: 3,
    maxRebuilds: 2,
    graceTimer: null,
    lock: false,
    
    reset() {
        this.retryCount = 0;
        this.rebuildCount = 0;
        this.lock = false;
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    },
    
    handleOffline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_OFFLINE');
        changeAppState('RECONNECTING', 'Internet connection lost. Reconnecting...');
    },
    
    handleOnline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_ONLINE');
        if (pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
            changeAppState('CONNECTED', 'Connected again');
        }
    },
    
    handleDisconnected() {
        if (manualHangup) return;
        log('[RECOVERY] WEBRTC_DISCONNECTED');
        changeAppState('DEGRADED', 'Connection unstable...');
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
            if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
                this.handleFailed();
            }
        }, 3000);
    },
    
    handleConnected() {
        log('[RECOVERY] WEBRTC_CONNECTED');
        this.reset();
        changeAppState('CONNECTED', 'Connected');
    },
    
    handleFailed() {
        if (manualHangup || this.lock || !pc) return;
        log('[RECOVERY] WEBRTC_FAILED');
        
        if (this.retryCount < this.maxIceRestarts) {
            this.retryCount++;
            const delay = Math.pow(2, this.retryCount - 1) * 1000 + Math.random() * 500;
            log(`[RECOVERY] ICE_RESTART_START (attempt ${this.retryCount}) in ${delay}ms`);
            
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup || !pc) return;
                changeAppState('ICE_RESTARTING', 'Trying to restore the call...');
                try {
                    pc.restartIce();
                } catch (e) {
                    log('[RECOVERY] ICE_RESTART_FAILED', e);
                }
            }, delay);
        } else if (this.rebuildCount < this.maxRebuilds) {
            this.rebuildCount++;
            const delay = 3000 + Math.random() * 1000;
            log(`[RECOVERY] CONNECTION_REBUILD_START (attempt ${this.rebuildCount}) in ${delay}ms`);
            
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup) return;
                changeAppState('RECOVERING', 'Trying another network route...');
                rebuildConnection();
            }, delay);
        } else {
            log('[RECOVERY] RECOVERY_FAILED');
            changeAppState('FAILED', 'We couldn\\'t restore the voice connection. Please try again.');
            cleanupCall(false);
        }
    }
};

window.addEventListener('offline', () => RecoveryManager.handleOffline());
window.addEventListener('online', () => RecoveryManager.handleOnline());

joinBtn.addEventListener('click', async () => {
    const callId = callIdInput.value.trim();
    if (!callId) return showError('Enter a valid call code');
    
    currentCallId = callId;
    manualHangup = false;
    sessionId = Math.random().toString(36).substring(2);
    RecoveryManager.reset();
    secondsConnected = 0;
    updateTimerDisplay();

    joinBtn.disabled = true;
    
    await fetchTurnCredentials();

    try {
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
                video: false 
            });
        }
        
        switchScreen('call');
        changeAppState('CONNECTING', 'Connecting...');
        hangupBtn.disabled = false;
        
        socket.emit('join_call', currentCallId);
        log('Local media acquired and joined call.');
    } catch (e) {
        log('Microphone error', e);
        showError('Microphone access is required for voice calls.');
        joinBtn.disabled = false;
    }
});

hangupBtn.addEventListener('click', () => {
    if (currentCallId && !manualHangup) {
        socket.emit('call_end', { callId: currentCallId });
    }
    cleanupCall(true);
});

muteBtn.addEventListener('click', () => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isMuted = !isMuted;
            audioTrack.enabled = !isMuted;
            muteIcon.textContent = isMuted ? '🔇' : '🎙️';
            if (isMuted) muteBtn.classList.add('active');
            else muteBtn.classList.remove('active');
        }
    }
});

function cleanupCall(isManual = false) {
    log('Cleaning up call state');
    if (isManual) {
        manualHangup = true;
        changeAppState('ENDED', 'Call Ended');
    } else if (appState !== 'FAILED') {
        changeAppState('IDLE', 'Idle');
    }
    
    RecoveryManager.reset();
    
    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream && (isManual || appState === 'FAILED')) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        isMuted = false;
        muteIcon.textContent = '🎙️';
        muteBtn.classList.remove('active');
    }
    
    pendingCandidates = [];
    makingOffer = false;
    ignoreOffer = false;
    isSettingRemoteAnswerPending = false;
    currentCallId = null;
    
    joinBtn.disabled = false;
    hangupBtn.disabled = true;
    if (remoteAudio) remoteAudio.srcObject = null;
    
    setTimeout(() => {
        switchScreen('join');
    }, isManual ? 1000 : 2000);
}

function rebuildConnection() {
    log('Rebuilding RTCPeerConnection...');
    if (pc) pc.close();
    pc = null;
    pendingCandidates = [];
    makingOffer = false;
    ignoreOffer = false;
    isSettingRemoteAnswerPending = false;
    setupWebRTC();
    log('[RECOVERY] CONNECTION_REBUILD_SUCCESS');
}

function setupWebRTC() {
    pc = new RTCPeerConnection(rtcConfig);

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = ({ track, streams }) => {
        log('Remote track received');
        if (track.kind === 'audio') {
            remoteAudio.srcObject = streams[0];
            remoteAudio.play().catch(e => console.error("Autoplay restricted:", e));
        }
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate && !manualHangup) {
            socket.emit('ice_candidate', { callId: currentCallId, candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        log('ICE Connection state:', state);
        
        if (state === 'connected' || state === 'completed') {
            RecoveryManager.handleConnected();
        } else if (state === 'disconnected') {
            RecoveryManager.handleDisconnected();
        } else if (state === 'failed') {
            RecoveryManager.handleFailed();
        }
    };

    pc.onnegotiationneeded = async () => {
        try {
            makingOffer = true;
            await pc.setLocalDescription();
            if (!manualHangup) {
                socket.emit('offer', { callId: currentCallId, description: pc.localDescription });
                log('Created and sent offer');
            }
        } catch (err) {
            log('Error during negotiation', err);
        } finally {
            makingOffer = false;
        }
    };
}

socket.on('connect', () => {
    log('Signaling CONNECTED');
    if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup || !currentCallId) return;
    
    log('[RECOVERY] Attempting to resume call on new socket connection...');
    socket.emit('resume_call', { callId: currentCallId, sessionId }, (res) => {
        if (res && res.status === 'resume_ok') {
            log('[RECOVERY] Signaling resumed');
        } else {
            log('[RECOVERY] Resume failed (session expired)');
            changeAppState('FAILED', 'Session expired');
            showError('Call session expired. Please rejoin.');
            cleanupCall(false);
        }
    });
});

socket.on('disconnect', () => log('Signaling DISCONNECTED'));
socket.on('peer_role', ({ polite: isPolite }) => { polite = isPolite; log(`Assigned role: polite=${polite}`); });
socket.on('peer_connected', () => {
    changeAppState('CONNECTING', 'Peer joined');
    log('Peer connected, setting up WebRTC');
    if (!pc) setupWebRTC();
});
socket.on('peer_disconnected', () => {
    if (manualHangup) return;
    log('Peer disconnected');
    changeAppState('DEGRADED', 'Peer disconnected. Waiting...');
    RecoveryManager.handleDisconnected();
});

socket.on('offer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try {
        const offerCollision = (description.type === 'offer') && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) return log('Offer collision, ignoring offer (impolite)');
        
        isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        isSettingRemoteAnswerPending = false;
        log('Remote description applied');

        if (description.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit('answer', { callId: currentCallId, description: pc.localDescription });
            log('Created and sent answer');
        }

        for (const candidate of pendingCandidates) await pc.addIceCandidate(candidate);
        if (pendingCandidates.length > 0) log(`Candidate queued flushed (${pendingCandidates.length})`);
        pendingCandidates = [];
    } catch (err) {
        log('Error handling offer', err);
    }
});

socket.on('answer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try { await pc.setRemoteDescription(description); log('Remote answer applied'); }
    catch (err) { log('Error handling answer', err); }
});

socket.on('ice_candidate', async ({ candidate }) => {
    if (!pc || manualHangup) return;
    try {
        if (!pc.remoteDescription) { pendingCandidates.push(candidate); log('Candidate queued'); return; }
        await pc.addIceCandidate(candidate);
        log('Candidate added');
    } catch (err) {
        if (!ignoreOffer) log('Error handling candidate', err);
        else log('Candidate error ignored due to offer collision');
    }
});

socket.on('call_end', () => {
    if (manualHangup) return;
    log('Peer ended call');
    changeAppState('ENDED', 'Peer ended call');
    cleanupCall(false);
});
"""
}

for path_rel, content in files.items():
    path_abs = os.path.join(base_dir, path_rel)
    os.makedirs(os.path.dirname(path_abs), exist_ok=True)
    with open(path_abs, "w", encoding="utf-8") as f:
        f.write(content)

print("Phase 3 complete.")
