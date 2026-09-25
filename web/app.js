// ─── CONFIG ───────────────────────────────────────────────────────────────────
// SIGNALING_URL is set in index.html from window.APP_CONFIG
// Falls back to same origin (works when server also serves the frontend)
const SIGNALING_URL = (window.APP_CONFIG && window.APP_CONFIG.SIGNALING_URL)
    || window.location.origin;

// ─── SOCKET ───────────────────────────────────────────────────────────────────
const socket = io(SIGNALING_URL, {
    transports: ['websocket', 'polling'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 16000,
    randomizationFactor: 0.5,
    timeout: 10000
});

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const joinScreen        = document.getElementById('joinScreen');
const callScreen        = document.getElementById('callScreen');
const callIdInput       = document.getElementById('callIdInput');
const joinBtn           = document.getElementById('joinBtn');
const hangupBtn         = document.getElementById('hangupBtn');
const muteBtn           = document.getElementById('muteBtn');
const muteIcon          = document.getElementById('muteIcon');
const statusSpan        = document.getElementById('status');
const statusIndicator   = document.getElementById('statusIndicator');
const callTimer         = document.getElementById('callTimer');
const errorNotification = document.getElementById('errorNotification');
const remoteAudio       = document.getElementById('remoteAudio');
const avatarCircle      = document.querySelector('.avatar-circle');
const qualityIndicator  = document.getElementById('qualityIndicator');
const qualityText       = document.getElementById('qualityText');

// ─── STATE ───────────────────────────────────────────────────────────────────
let localStream     = null;
let pc              = null;
let currentCallId   = null;
let sessionId       = crypto.randomUUID();

let polite                      = false;
let makingOffer                 = false;
let ignoreOffer                 = false;
let isSettingRemoteAnswerPending = false;
let pendingCandidates           = [];

let appState   = 'IDLE';
let manualHangup = false;
let isMuted    = false;

let timerInterval    = null;
let secondsConnected = 0;
let credentialsFetched = false;
let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let statsInterval = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg, ...args) {
    console.log(`[WEBRTC] ${msg}`, ...args);
}

let errorTimer = null;
function showError(msg, duration = 6000) {
    errorNotification.textContent = msg;
    errorNotification.classList.remove('hidden');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorNotification.classList.add('hidden'), duration);
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
        timerInterval = setInterval(() => { secondsConnected++; updateTimerDisplay(); }, 1000);
    }
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
}

function startStatsMonitor() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if (!pc || appState !== 'CONNECTED') { clearInterval(statsInterval); statsInterval = null; return; }
        try {
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    const rtt = report.currentRoundTripTime;
                    if (rtt !== undefined) {
                        let quality = 'Good';
                        if (rtt > 0.3) quality = 'Poor';
                        else if (rtt > 0.1) quality = 'Fair';
                        qualityText.textContent = quality;
                        qualityIndicator.classList.remove('hidden');
                    }
                }
            });
        } catch (_) { /* ignore */ }
    }, 5000);
}

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
function changeAppState(newState, uiMsg) {
    if (manualHangup && newState !== 'ENDED' && newState !== 'IDLE') return;
    appState = newState;

    statusSpan.textContent = uiMsg || newState;
    statusIndicator.className = 'status-dot ' + newState.toLowerCase();
    avatarCircle.className    = 'avatar-circle ' + newState.toLowerCase();
    document.body.dataset.state = newState;

    if (newState === 'CONNECTED') {
        startTimer();
        startStatsMonitor();
        qualityIndicator.classList.remove('hidden');
    } else if (['ENDED', 'FAILED', 'IDLE'].includes(newState)) {
        stopTimer();
        clearInterval(statsInterval);
        statsInterval = null;
        qualityIndicator.classList.add('hidden');
    }
}

// ─── TURN CREDENTIALS ─────────────────────────────────────────────────────────
async function fetchTurnCredentials() {
    if (credentialsFetched) return;
    try {
        const res  = await fetch(`${SIGNALING_URL}/api/turn-credentials`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls:       data.urls,
                    username:   data.username,
                    credential: data.credential
                }
            ]
        };
        credentialsFetched = true;
        log(`TURN credentials fetched, expiry=${data.expiry_timestamp}`);
    } catch (e) {
        log('TURN credential fetch failed:', e.message);
        showError('Voice relay service unavailable. Using direct connection.');
    }
}

// ─── RECOVERY MANAGER ─────────────────────────────────────────────────────────
const RecoveryManager = {
    retryCount:   0,
    rebuildCount: 0,
    maxIceRestarts: 3,
    maxRebuilds:    2,
    graceTimer: null,
    lock: false,

    reset() {
        this.retryCount   = 0;
        this.rebuildCount = 0;
        this.lock         = false;
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
    },

    handleOffline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_OFFLINE');
        changeAppState('RECONNECTING', 'Internet lost. Reconnecting...');
    },

    handleOnline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_ONLINE');
        if (pc && ['connected', 'completed'].includes(pc.iceConnectionState)) {
            changeAppState('CONNECTED', 'Connected again');
        }
    },

    handleDisconnected() {
        if (manualHangup) return;
        log('[RECOVERY] WEBRTC_DISCONNECTED — grace period starting');
        changeAppState('DEGRADED', 'Connection unstable...');
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
            if (pc && !['connected', 'completed'].includes(pc.iceConnectionState)) {
                this.handleFailed();
            }
        }, 4000);
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
            const delay = (Math.pow(2, this.retryCount - 1) * 1000) + (Math.random() * 500);
            log(`[RECOVERY] ICE restart attempt ${this.retryCount} in ${Math.round(delay)}ms`);
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup || !pc) return;
                changeAppState('ICE_RESTARTING', 'Restoring call...');
                try { pc.restartIce(); } catch (e) { log('[RECOVERY] restartIce failed', e.message); }
            }, delay);

        } else if (this.rebuildCount < this.maxRebuilds) {
            this.rebuildCount++;
            const delay = 3000 + Math.random() * 1000;
            log(`[RECOVERY] Rebuild attempt ${this.rebuildCount} in ${Math.round(delay)}ms`);
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup) return;
                changeAppState('RECOVERING', 'Trying another route...');
                rebuildConnection();
            }, delay);

        } else {
            log('[RECOVERY] All attempts exhausted');
            changeAppState('FAILED', "Couldn't restore the call. Please try again.");
            cleanupCall(false);
        }
    }
};

window.addEventListener('offline', () => RecoveryManager.handleOffline());
window.addEventListener('online',  () => RecoveryManager.handleOnline());

// ─── JOIN ─────────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', async () => {
    const callId = callIdInput.value.trim();
    if (!callId) { showError('Enter a call code to continue.'); return; }

    currentCallId = callId;
    manualHangup  = false;
    sessionId     = crypto.randomUUID();
    secondsConnected = 0;
    updateTimerDisplay();
    RecoveryManager.reset();
    credentialsFetched = false;

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
        log('Joined call:', currentCallId);
    } catch (e) {
        log('Media error:', e.message);
        const msg = e.name === 'NotAllowedError'
            ? 'Microphone access denied. Please allow microphone in browser settings.'
            : 'Could not access microphone.';
        showError(msg);
        joinBtn.disabled = false;
    }
});

// ─── HANGUP ───────────────────────────────────────────────────────────────────
hangupBtn.addEventListener('click', () => {
    if (currentCallId && !manualHangup) socket.emit('call_end', { callId: currentCallId });
    cleanupCall(true);
});

// ─── MUTE ─────────────────────────────────────────────────────────────────────
muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    isMuted = !isMuted;
    track.enabled = !isMuted;
    muteIcon.textContent = isMuted ? '🔇' : '🎙️';
    muteBtn.classList.toggle('active', isMuted);
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanupCall(isManual = false) {
    log('cleanupCall isManual=' + isManual);
    if (isManual) {
        manualHangup = true;
        changeAppState('ENDED', 'Call ended');
    } else if (appState !== 'FAILED') {
        changeAppState('IDLE', 'Ready');
    }

    RecoveryManager.reset();

    if (pc) { pc.close(); pc = null; }

    if (localStream && (isManual || appState === 'FAILED')) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        isMuted = false;
        muteIcon.textContent = '🎙️';
        muteBtn.classList.remove('active');
    }

    pendingCandidates            = [];
    makingOffer                  = false;
    ignoreOffer                  = false;
    isSettingRemoteAnswerPending = false;
    currentCallId                = null;

    joinBtn.disabled   = false;
    hangupBtn.disabled = true;
    if (remoteAudio) remoteAudio.srcObject = null;

    setTimeout(() => switchScreen('join'), isManual ? 1500 : 2500);
}

// ─── REBUILD ──────────────────────────────────────────────────────────────────
function rebuildConnection() {
    log('Rebuilding RTCPeerConnection');
    if (pc) pc.close();
    pc = null;
    pendingCandidates            = [];
    makingOffer                  = false;
    ignoreOffer                  = false;
    isSettingRemoteAnswerPending = false;
    setupWebRTC();
}

// ─── WEBRTC SETUP ─────────────────────────────────────────────────────────────
function setupWebRTC() {
    pc = new RTCPeerConnection(rtcConfig);

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = ({ track, streams }) => {
        log('Remote track received kind=' + track.kind);
        if (track.kind === 'audio') {
            remoteAudio.srcObject = streams[0];
            remoteAudio.play().catch(e => log('Autoplay blocked:', e.message));
        }
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate && !manualHangup) {
            socket.emit('ice_candidate', { callId: currentCallId, candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        log('ICE state:', s);
        if (s === 'connected' || s === 'completed') RecoveryManager.handleConnected();
        else if (s === 'disconnected')               RecoveryManager.handleDisconnected();
        else if (s === 'failed')                     RecoveryManager.handleFailed();
    };

    pc.onnegotiationneeded = async () => {
        try {
            makingOffer = true;
            await pc.setLocalDescription();
            if (!manualHangup) {
                socket.emit('offer', { callId: currentCallId, description: pc.localDescription });
                log('Offer sent');
            }
        } catch (err) {
            log('Negotiation error:', err.message);
        } finally {
            makingOffer = false;
        }
    };
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
socket.on('connect', () => {
    log('Signaling connected id=' + socket.id);
    if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup || !currentCallId) return;
    log('[RECOVERY] Attempting session resume');
    socket.emit('resume_call', { callId: currentCallId, sessionId }, (res) => {
        if (res && res.status === 'resume_ok') {
            log('[RECOVERY] Session resumed');
        } else {
            log('[RECOVERY] Resume failed — session expired');
            changeAppState('FAILED', 'Session expired. Please rejoin.');
            showError('Call session expired. Please start a new call.');
            cleanupCall(false);
        }
    });
});

socket.on('disconnect', (reason) => {
    log('Signaling disconnected:', reason);
    if (!['IDLE', 'ENDED', 'FAILED'].includes(appState) && !manualHangup) {
        changeAppState('RECONNECTING', 'Reconnecting...');
    }
});

socket.on('connect_error', (err) => {
    log('Signaling connection error:', err.message);
});

socket.on('error', (data) => {
    log('Server error:', data.message);
    showError(data.message || 'A server error occurred.');
    if (data.message === 'Room is full') {
        joinBtn.disabled = false;
        switchScreen('join');
    }
});

socket.on('peer_role', ({ polite: isPolite }) => {
    polite = isPolite;
    log('Role assigned polite=' + polite);
});

socket.on('peer_connected', () => {
    log('Peer connected — starting WebRTC');
    changeAppState('CONNECTING', 'Peer connected...');
    if (!pc) setupWebRTC();
});

socket.on('peer_disconnected', () => {
    if (manualHangup) return;
    log('Peer disconnected');
    changeAppState('DEGRADED', 'Peer disconnected...');
    RecoveryManager.handleDisconnected();
});

socket.on('offer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try {
        const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) { log('Offer collision — ignored (impolite)'); return; }

        isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        isSettingRemoteAnswerPending = false;
        log('Remote description set type=' + description.type);

        if (description.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit('answer', { callId: currentCallId, description: pc.localDescription });
            log('Answer sent');
        }

        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        if (pendingCandidates.length) log(`Flushed ${pendingCandidates.length} queued candidates`);
        pendingCandidates = [];
    } catch (err) {
        log('Error handling offer:', err.message);
    }
});

socket.on('answer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try { await pc.setRemoteDescription(description); log('Remote answer applied'); }
    catch (err) { log('Error applying answer:', err.message); }
});

socket.on('ice_candidate', async ({ candidate }) => {
    if (!pc || manualHangup) return;
    try {
        if (!pc.remoteDescription) {
            pendingCandidates.push(candidate);
            log('Candidate queued (no remote desc yet)');
            return;
        }
        await pc.addIceCandidate(candidate);
    } catch (err) {
        if (!ignoreOffer) log('ICE candidate error:', err.message);
    }
});

socket.on('call_end', () => {
    if (manualHangup) return;
    log('Peer ended call');
    changeAppState('ENDED', 'Call ended by peer');
    cleanupCall(false);
});
