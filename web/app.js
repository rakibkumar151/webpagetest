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
const videoBtn          = document.getElementById('videoBtn');
const switchCameraBtn   = document.getElementById('switchCameraBtn');
const screenShareBtn    = document.getElementById('screenShareBtn');
const statusSpan        = document.getElementById('status');
const statusIndicator   = document.getElementById('statusIndicator');
const callTimer         = document.getElementById('callTimer');
const errorNotification = document.getElementById('errorNotification');
const remoteVideo       = document.getElementById('remoteVideo');
const localVideo        = document.getElementById('localVideo');
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
let isVideoMuted = false;
let currentFacingMode = 'user';
let isScreenSharing = false;
let screenStream = null;

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
    
    // Auto-save state for seamless reload
    if (currentCallId) {
        sessionStorage.setItem('activeCall', JSON.stringify({
            callId: currentCallId,
            sessionId: sessionId,
            secondsConnected: secondsConnected,
            isMuted: isMuted,
            isVideoMuted: isVideoMuted
        }));
    }
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
    
    const cached = sessionStorage.getItem('turn_credentials');
    if (cached) {
        try {
            const data = JSON.parse(cached);
            if (Date.now() < data.expiry) {
                rtcConfig = data.rtcConfig;
                credentialsFetched = true;
                log('Used cached TURN credentials');
                return;
            }
        } catch(e) {}
    }

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
        
        sessionStorage.setItem('turn_credentials', JSON.stringify({
            expiry: (data.expiry_timestamp * 1000) - 300000, // 5 minutes before expiry
            rtcConfig: rtcConfig
        }));
        
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
    uiWarningTimer: null,
    lock: false,

    reset() {
        this.retryCount   = 0;
        this.rebuildCount = 0;
        this.lock         = false;
        clearTimeout(this.graceTimer);
        clearTimeout(this.uiWarningTimer);
        this.graceTimer = null;
        this.uiWarningTimer = null;
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
        
        clearTimeout(this.graceTimer);
        clearTimeout(this.uiWarningTimer);
        
        this.uiWarningTimer = setTimeout(() => {
            if (appState !== 'ENDED' && appState !== 'FAILED') {
                changeAppState('DEGRADED', 'Connection unstable...');
            }
        }, 3000);
        
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
            try {
                // Default to AUDIO ONLY (Messenger style)
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false
                });
                
                isVideoMuted = true;
                videoBtn.classList.add('active'); // Show slashed icon
                videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
                
                // Hide PIP container initially
                const localContainer = document.querySelector('.local-video-container');
                if (localContainer) localContainer.style.display = 'none';
                
                localVideo.srcObject = localStream;
                localVideo.classList.remove('pip-active');
                
                videoBtn.disabled = false;
                switchCameraBtn.disabled = true; // No video initially
                
                // Hide Screen Share button if unsupported (e.g. mobile)
                if (!navigator.mediaDevices.getDisplayMedia) {
                    screenShareBtn.style.display = 'none';
                }
            } catch (err) {
                log('Camera not available or blocked, falling back to audio only', err.message);
                // Fallback to Audio only
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false
                });
                isVideoMuted = true;
                videoBtn.classList.add('active'); // Show disabled state
                videoBtn.disabled = true;
                switchCameraBtn.disabled = true;
                const localVideoStatus = document.getElementById('localVideoStatus');
                if (localVideoStatus) localVideoStatus.classList.remove('hidden');
                
                showError('Camera not found or blocked. Joined with Audio only.', 5000);
            }
        }
        switchScreen('call');
        changeAppState('CONNECTING', 'Connecting...');
        hangupBtn.disabled = false;
        
        // Save session for reload
        sessionStorage.setItem('activeCall', JSON.stringify({
            callId: currentCallId,
            sessionId: sessionId
        }));
        socket.emit('join_call', { callId: currentCallId, sessionId: sessionId });
        log('Joined call:', currentCallId);
    } catch (e) {
        log('Media error:', e.message);
        const msg = e.name === 'NotAllowedError'
            ? 'Camera/Microphone access denied. Please allow in browser settings.'
            : 'Could not access Camera/Microphone.';
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
muteBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    if (!isMuted) {
        // TRULY STOP HARDWARE MIC
        const track = localStream.getAudioTracks()[0];
        if (track) {
            track.enabled = false;
            track.stop();
        }
        isMuted = true;
        muteBtn.classList.add('active');
        muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    } else {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTrack = localStream.getAudioTracks()[0];
            
            if (oldTrack) localStream.removeTrack(oldTrack);
            localStream.addTrack(newTrack);
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    await sender.replaceTrack(newTrack);
                } else {
                    pc.addTrack(newTrack, localStream);
                }
            }
            isMuted = false;
            muteBtn.classList.remove('active');
            muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        } catch (e) {
            log('Failed to restart mic', e.message);
            isMuted = true;
            muteBtn.classList.add('active');
            showError('Could not access microphone');
        }
    }
    
    // Notify peer
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_audio', muted: isMuted });
    }
});

// ─── VIDEO TOGGLE ─────────────────────────────────────────────────────────────
videoBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    isVideoMuted = !isVideoMuted;
    videoBtn.classList.toggle('active', isVideoMuted);
    
    if (isVideoMuted) {
        const track = localStream.getVideoTracks()[0];
        if (track) {
            track.enabled = false;
            track.stop(); // Truly turn off the hardware camera
        }
        videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        
        // Hide PIP container when video is off
        const localContainer = document.querySelector('.local-video-container');
        if (localContainer) localContainer.style.display = 'none';
        switchCameraBtn.disabled = true;
    } else {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { 
                    facingMode: currentFacingMode,
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 24 }
                }
            });
            const newTrack = newStream.getVideoTracks()[0];
            const oldTrack = localStream.getVideoTracks()[0];
            
            if (oldTrack) localStream.removeTrack(oldTrack);
            localStream.addTrack(newTrack);
            
            localVideo.srcObject = localStream;
            localVideo.classList.add('pip-active');
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(newTrack);
                } else {
                    // Add video track if it didn't exist (started as audio-only)
                    pc.addTrack(newTrack, localStream);
                }
            }
            videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
            
            // Show PIP container when video is on
            const localContainer = document.querySelector('.local-video-container');
            if (localContainer) localContainer.style.display = 'block';
            switchCameraBtn.disabled = false;
        } catch (e) {
            log('Failed to restart camera', e.message);
            isVideoMuted = true;
            videoBtn.classList.add('active');
            showError('Could not restart camera');
        }
    }
    
    // We don't need local placeholder anymore since container is hidden entirely when off,
    // but we can ensure it's hidden just in case.
    const localVideoStatus = document.getElementById('localVideoStatus');
    if (localVideoStatus) localVideoStatus.classList.add('hidden');
    
    // Notify peer
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: isVideoMuted });
    }
});

// ─── CAMERA SWITCH ────────────────────────────────────────────────────────────
switchCameraBtn.addEventListener('click', async () => {
    if (!localStream) return;
    switchCameraBtn.disabled = true;
    
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { 
                facingMode: currentFacingMode,
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
            }
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        const oldVideoTrack = localStream.getVideoTracks()[0];
        
        // Replace in RTCPeerConnection if active
        if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(newVideoTrack);
            }
        }
        
        // Update localStream
        localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
        localStream.addTrack(newVideoTrack);
        
        // Restore mute state
        newVideoTrack.enabled = !isVideoMuted;
        
    } catch (e) {
        log('Switch camera error:', e.message);
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; // revert
    } finally {
        switchCameraBtn.disabled = false;
    }
});

// ─── SCREEN SHARE ─────────────────────────────────────────────────────────────
screenShareBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    if (isScreenSharing) {
        stopScreenSharing();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Listen for native "Stop sharing" button
            screenTrack.onended = () => {
                stopScreenSharing();
            };
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(screenTrack);
                } else {
                    pc.addTrack(screenTrack, localStream);
                }
            }
            
            // Show it in PIP box
            const tempStream = new MediaStream([screenTrack]);
            localVideo.srcObject = tempStream;
            localVideo.classList.add('pip-active');
            
            const localContainer = document.querySelector('.local-video-container');
            if (localContainer) localContainer.style.display = 'block';
            
            const localVideoStatus = document.getElementById('localVideoStatus');
            if (localVideoStatus) localVideoStatus.classList.add('hidden');
            
            isScreenSharing = true;
            screenShareBtn.classList.add('active');
            
            // If camera was on, turn it off visually
            if (!isVideoMuted) {
                const camTrack = localStream.getVideoTracks()[0];
                if (camTrack) {
                    camTrack.stop();
                    localStream.removeTrack(camTrack);
                }
                isVideoMuted = true;
                videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
            }
            
            if (currentCallId) {
                socket.emit('peer_action', { callId: currentCallId, action: 'screen_share', active: true });
                socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: false });
            }
            switchCameraBtn.disabled = true; // Can't switch camera while sharing screen
        } catch (e) {
            log('Screen share failed', e.message);
        }
    }
});

function stopScreenSharing() {
    if (!isScreenSharing) return;
    
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    
    isScreenSharing = false;
    screenShareBtn.classList.remove('active');
    
    // We revert to Camera OFF state. 
    const localContainer = document.querySelector('.local-video-container');
    if (localContainer) localContainer.style.display = 'none';
    
    localVideo.srcObject = localStream; // Back to localStream (which has no video track right now)
    
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'screen_share', active: false });
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: true });
    }
}

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
        isVideoMuted = false;
        currentFacingMode = 'user';
        
        muteBtn.classList.remove('active');
        videoBtn.classList.remove('active');
        
        muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
        
        videoBtn.disabled = false;
        switchCameraBtn.disabled = false;
        localVideo.style.display = 'block';
        
        localVideo.srcObject = null;
        localVideo.classList.remove('pip-active');
    }

    pendingCandidates            = [];
    makingOffer                  = false;
    ignoreOffer                  = false;
    isSettingRemoteAnswerPending = false;
    currentCallId                = null;

    joinBtn.disabled   = false;
    hangupBtn.disabled = true;
    if (remoteVideo) remoteVideo.srcObject = null;
    
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    if (screenShareBtn) {
        screenShareBtn.classList.remove('active');
        screenShareBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
    }
    
    const remoteVideoStatus = document.getElementById('remoteVideoStatus');
    const remoteMicStatus = document.getElementById('remoteMicStatus');
    const localVideoStatus = document.getElementById('localVideoStatus');
    if (remoteVideoStatus) remoteVideoStatus.classList.add('hidden');
    if (remoteMicStatus) remoteMicStatus.classList.add('hidden');
    if (localVideoStatus) localVideoStatus.classList.add('hidden');

    sessionStorage.removeItem('activeCall');

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

    if (localStream) {
        localStream.getTracks().forEach(t => {
            if (isScreenSharing && t.kind === 'video') return;
            pc.addTrack(t, localStream);
        });
    }

    if (isScreenSharing && screenStream) {
        screenStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    pc.ontrack = (event) => {
        log('Remote track received kind=' + event.track.kind);
        const stream = event.streams[0] || new MediaStream([event.track]);
        
        if (remoteVideo.srcObject !== stream) {
            remoteVideo.srcObject = stream;
        }
        
        // Ensure playback starts (iOS requires this)
        remoteVideo.play().catch(e => log('Autoplay blocked:', e.message));
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
            if (!pc) {
                log('[RECOVERY] PC is null. Requesting peer rebuild and setting up local WebRTC.');
                polite = true; // Always polite when requesting rebuild
                socket.emit('peer_action', { callId: currentCallId, action: 'rebuild_webrtc' });
                setupWebRTC();
            }
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
    if (!pc) {
        changeAppState('CONNECTING', 'Peer connected...');
        setupWebRTC();
    } else {
        log('Peer reconnected (socket only). Waiting for rebuild_webrtc if they reloaded.');
    }
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
        
        if (collision) {
            log('Collision resolved via rollback');
            await pc.setLocalDescription({ type: 'rollback' });
            await pc.setRemoteDescription(description);
        } else {
            await pc.setRemoteDescription(description);
        }
        
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

socket.on('peer_action', (data) => {
    if (data.action === 'mute_audio') {
        const remoteMicStatus = document.getElementById('remoteMicStatus');
        if (remoteMicStatus) {
            if (data.muted) remoteMicStatus.classList.remove('hidden');
            else remoteMicStatus.classList.add('hidden');
        }
    } else if (data.action === 'mute_video') {
        const remoteVideoStatus = document.getElementById('remoteVideoStatus');
        if (remoteVideoStatus) {
            if (data.muted) remoteVideoStatus.classList.remove('hidden');
            else remoteVideoStatus.classList.add('hidden');
        }
    } else if (data.action === 'screen_share') {
        if (data.active) {
            remoteVideo.classList.add('is-screen-share');
        } else {
            remoteVideo.classList.remove('is-screen-share');
        }
    } else if (data.action === 'rebuild_webrtc') {
        log('Peer requested WebRTC rebuild');
        rebuildConnection();
    }
});

// ─── AUTO-REJOIN ON RELOAD ────────────────────────────────────────────────────
window.addEventListener('load', async () => {
    const savedCall = sessionStorage.getItem('activeCall');
    if (savedCall) {
        try {
            const data = JSON.parse(savedCall);
            callIdInput.value = data.callId;
            sessionId = data.sessionId;
            
            currentCallId = data.callId;
            manualHangup = false;
            secondsConnected = data.secondsConnected || 0;
            isVideoMuted = data.isVideoMuted !== undefined ? data.isVideoMuted : true;
            isMuted = data.isMuted || false;
            
            updateTimerDisplay();
            RecoveryManager.reset();
            
            joinBtn.disabled = true;
            await fetchTurnCredentials();
            
            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: !isVideoMuted
                });
            } catch (err) {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                isVideoMuted = true;
            }
            
            if (isMuted) {
                const track = localStream.getAudioTracks()[0];
                if (track) { track.enabled = false; track.stop(); }
                muteBtn.classList.add('active');
                muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
            }
            
            if (isVideoMuted) {
                videoBtn.classList.add('active'); 
                videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
                const localContainer = document.querySelector('.local-video-container');
                if (localContainer) localContainer.style.display = 'none';
                switchCameraBtn.disabled = true;
            } else {
                const localContainer = document.querySelector('.local-video-container');
                if (localContainer) localContainer.style.display = 'block';
                switchCameraBtn.disabled = false;
            }
            
            localVideo.srcObject = localStream;
            localVideo.classList.remove('pip-active');
            videoBtn.disabled = false;
            
            if (!navigator.mediaDevices.getDisplayMedia) {
                screenShareBtn.style.display = 'none';
            }
            
            switchScreen('call');
            changeAppState('CONNECTED', 'Connected'); // Instantly look connected!
            hangupBtn.disabled = false;
            
            if (socket.connected) {
                log('[RECOVERY] Auto-rejoin firing resume_call');
                socket.emit('resume_call', { callId: currentCallId, sessionId }, (res) => {
                    if (res && res.status === 'resume_ok') {
                        log('[RECOVERY] Session resumed on reload');
                        polite = true; // Reloading peer is always polite
                        if (!pc) {
                            socket.emit('peer_action', { callId: currentCallId, action: 'rebuild_webrtc' });
                            setupWebRTC();
                        }
                    } else {
                        changeAppState('FAILED', 'Session expired. Please rejoin.');
                        cleanupCall(false);
                    }
                });
            }
        } catch (e) {
            log('Failed to auto-restore call:', e.message);
            sessionStorage.removeItem('activeCall');
        }
    }
});
