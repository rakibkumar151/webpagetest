// web/screenshotDetector.js

(function() {
    let lastScreenshotTime = 0;

    function handleScreenshot() {
        const now = Date.now();
        if (now - lastScreenshotTime < 2000) return; // Debounce 2 seconds
        lastScreenshotTime = now;

        // Figure out who we are talking to
        let targetUid = null;
        let myName = 'Someone';

        try {
            const me = JSON.parse(localStorage.getItem('chet_user') || '{}');
            if (me && me.first_name) myName = me.first_name;
            else if (me && me.username) myName = me.username;

            const callPartner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
            const chatPartner = JSON.parse(sessionStorage.getItem('chatPartner') || 'null');

            if (window.location.pathname.includes('index.html') && callPartner) {
                targetUid = callPartner.uid;
            } else if (window.location.pathname.includes('chat.html') && chatPartner) {
                targetUid = chatPartner.uid;
            } else if (window.location.pathname.includes('profile.html')) {
                const pId = sessionStorage.getItem('profileViewUid');
                if (pId) targetUid = pId;
            }
        } catch(e) {}

        if (targetUid && window.socket && window.socket.connected) {
            window.socket.emit('screenshot_taken', { target_uid: targetUid, sender_name: myName });
        }
    }

    // 1. Keyboard Detection (Windows/Mac)
    document.addEventListener('keyup', (e) => {
        if (e.key === 'PrintScreen') {
            handleScreenshot();
        }
    });

    document.addEventListener('keydown', (e) => {
        // Mac: Cmd + Shift + 3 / 4 / 5
        if (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === '5')) {
            handleScreenshot();
        }
        // Windows: Win + Shift + S
        if (e.metaKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
            handleScreenshot();
        }
    });

    // 2. Mobile Heuristics
    // Browsers don't natively tell us about OS screenshots.
    // The closest heuristic is that taking a screenshot often blurs or briefly backgrounds the webview on mobile.
    let blurTimeout;
    window.addEventListener('blur', () => {
        blurTimeout = setTimeout(() => {
            // If it was just a split-second blur (like a screenshot OS popup)
            // we could trigger it, but for now blur is enough.
            handleScreenshot();
        }, 50);
    });
    
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            handleScreenshot();
        }
    });

    // 3. Listen for partner's screenshot
    function setupListener() {
        if (!window.socket) {
            setTimeout(setupListener, 1000);
            return;
        }
        // Only bind once
        if (!window.socket._screenshotBound) {
            window.socket._screenshotBound = true;
            window.socket.on('partner_took_screenshot', (data) => {
                showScreenshotAlert(data.by_name);
            });
        }
    }
    setupListener();

    function showScreenshotAlert(name) {
        let alertEl = document.getElementById('screenshotAlertUI');
        if (!alertEl) {
            alertEl = document.createElement('div');
            alertEl.id = 'screenshotAlertUI';
            alertEl.style.position = 'fixed';
            alertEl.style.top = '15%';
            alertEl.style.left = '50%';
            alertEl.style.transform = 'translate(-50%, -50%) scale(0.9)';
            alertEl.style.backgroundColor = 'rgba(239, 68, 68, 0.95)'; // Red danger
            alertEl.style.color = '#fff';
            alertEl.style.padding = '12px 24px';
            alertEl.style.borderRadius = '30px';
            alertEl.style.fontSize = '15px';
            alertEl.style.fontWeight = '700';
            alertEl.style.zIndex = '9999999';
            alertEl.style.boxShadow = '0 10px 25px rgba(239, 68, 68, 0.6)';
            alertEl.style.display = 'flex';
            alertEl.style.alignItems = 'center';
            alertEl.style.gap = '8px';
            alertEl.style.pointerEvents = 'none'; // Don't block clicks
            alertEl.style.transition = 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
            alertEl.style.opacity = '0';
            
            alertEl.innerHTML = `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                <span id="screenshotAlertText"></span>
            `;
            document.body.appendChild(alertEl);
        }
        
        document.getElementById('screenshotAlertText').textContent = `${name} took a screenshot!`;
        
        // Force reflow
        void alertEl.offsetWidth;
        
        alertEl.style.opacity = '1';
        alertEl.style.transform = 'translate(-50%, -50%) scale(1)';

        if (alertEl.timeoutId) clearTimeout(alertEl.timeoutId);
        alertEl.timeoutId = setTimeout(() => {
            alertEl.style.opacity = '0';
            alertEl.style.transform = 'translate(-50%, -50%) scale(0.9)';
        }, 2000); // Hide after 2 seconds
    }
})();
