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

        pageA.on('console', msg => console.log(`[A] ${msg.text()}`));
        pageB.on('console', msg => console.log(`[B] ${msg.text()}`));

        const pageUrl = 'http://localhost:3000/index.html';
        await pageA.goto(pageUrl);
        await pageB.goto(pageUrl);

        console.log('Joining calls...');
        await pageA.fill('#callIdInput', 'recoveryroom');
        await pageA.click('#joinBtn');

        await pageB.fill('#callIdInput', 'recoveryroom');
        await pageB.click('#joinBtn');

        console.log('Waiting for connection...');
        await pageA.waitForFunction(() => document.body.dataset.state === 'CONNECTED', { timeout: 15000 });
        await pageB.waitForFunction(() => document.body.dataset.state === 'CONNECTED', { timeout: 15000 });
        console.log('=> Two-way connection established.');

        // Test 1: Caller internet OFF -> ON (Signaling disconnect)
        console.log('Test 1: Simulating Caller Offline...');
        await contextA.setOffline(true);
        await pageA.waitForFunction(() => document.body.dataset.state === 'RECONNECTING', { timeout: 5000 });
        console.log('=> Caller shows RECONNECTING');
        
        await new Promise(r => setTimeout(r, 2000));
        
        console.log('Test 1: Restoring Caller Network...');
        await contextA.setOffline(false);
        
        console.log('Waiting for recovery...');
        await pageA.waitForFunction(() => document.body.dataset.state === 'CONNECTED', { timeout: 20000 });
        await pageB.waitForFunction(() => document.body.dataset.state === 'CONNECTED', { timeout: 20000 });
        console.log('=> Network offline/online recovery: PASS');

        // Clean hangup
        console.log('Testing manual hangup...');
        await pageA.click('#hangupBtn');
        await pageA.waitForFunction(() => ['IDLE', 'ENDED'].includes(document.body.dataset.state));
        await pageB.waitForFunction(() => ['IDLE', 'ENDED'].includes(document.body.dataset.state));
        console.log('=> Hangup cleanup: PASS');
        
        console.log('All recovery tests finished successfully.');
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        if (browser) await browser.close();
    }
})();
