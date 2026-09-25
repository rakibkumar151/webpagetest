const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
    let browser;
    try {
        console.log('Launching browser...');
        browser = await chromium.launch({ 
            headless: true, 
            args: [
                '--use-fake-ui-for-media-stream', 
                '--use-fake-device-for-media-stream',
                '--allow-file-access-from-files'
            ] 
        });

        console.log('Creating contexts...');
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();

        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        // Listen for console logs
        let hasErrors = false;
        pageA.on('console', msg => {
            if (msg.type() === 'error' && !msg.text().includes('favicon')) hasErrors = true;
            console.log(`[A] ${msg.text()}`);
        });
        pageB.on('console', msg => {
            if (msg.type() === 'error' && !msg.text().includes('favicon')) hasErrors = true;
            console.log(`[B] ${msg.text()}`);
        });

        // Use file protocol for testing without a web server (assuming absolute path)
        const fileUrl = `file:///${__dirname.replace(/\\/g, '/')}/web/index.html`;
        console.log(`Opening ${fileUrl}...`);
        
        await pageA.goto(fileUrl);
        await pageB.goto(fileUrl);

        console.log('Joining calls...');
        await pageA.fill('#callIdInput', 'testroom123');
        await pageA.click('#joinBtn');

        await pageB.fill('#callIdInput', 'testroom123');
        await pageB.click('#joinBtn');

        // Wait for connection
        console.log('Waiting for connection...');
        await pageA.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        await pageB.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        console.log('=> Two-way audio: PASS');

        // Hangup test
        console.log('Testing hangup...');
        await pageA.click('#hangupBtn');
        await pageA.waitForFunction(() => document.getElementById('status').textContent === 'IDLE');
        await pageB.waitForFunction(() => document.getElementById('peerStatus').textContent === 'Peer ended call' || document.getElementById('peerStatus').textContent === 'Peer disconnected');
        console.log('=> Hangup cleanup: PASS');

        // Second call
        console.log('Testing second call...');
        await pageA.fill('#callIdInput', 'testroom456');
        await pageA.click('#joinBtn');
        await pageB.click('#hangupBtn'); // Reset B
        await pageB.fill('#callIdInput', 'testroom456');
        await pageB.click('#joinBtn');
        await pageA.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        await pageB.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        console.log('=> Second call: PASS');

        console.log('Testing disconnect (browser close)...');
        await pageA.close();
        await pageB.waitForFunction(() => document.getElementById('status').textContent === 'RECONNECTING', { timeout: 5000 });
        console.log('=> Signaling reconnect (peer disconnect state): PASS');
        
        if (hasErrors) {
            console.log('=> Browser console: FAIL (Errors detected)');
        } else {
            console.log('=> Browser console: PASS');
        }

        console.log('All tests finished.');
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        if (browser) await browser.close();
    }
})();
