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

        const contextA = await browser.newContext();
        const contextB = await browser.newContext();

        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        pageA.on('console', msg => console.log(`[A] ${msg.text()}`));
        pageB.on('console', msg => console.log(`[B] ${msg.text()}`));

        const fileUrl = `file:///${__dirname.replace(/\\/g, '/')}/web/index.html`;
        await pageA.goto(fileUrl);
        await pageB.goto(fileUrl);

        // Force TURN
        await pageA.evaluate(() => { rtcConfig.iceTransportPolicy = 'relay'; });
        await pageB.evaluate(() => { rtcConfig.iceTransportPolicy = 'relay'; });

        console.log('Forced ICE Transport Policy to relay.');
        console.log('Joining calls...');
        await pageA.fill('#callIdInput', 'turnroom');
        await pageA.click('#joinBtn');

        await pageB.fill('#callIdInput', 'turnroom');
        await pageB.click('#joinBtn');

        console.log('Waiting for connection...');
        await pageA.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        await pageB.waitForFunction(() => document.getElementById('status').textContent === 'CONNECTED', { timeout: 15000 });
        console.log('=> Two-way connection established.');

        // Get stats to prove it's a relay
        const stats = await pageA.evaluate(async () => {
            const statsArray = [];
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    statsArray.push(report);
                }
            });
            const localCandidateId = statsArray[0].localCandidateId;
            const localCandidate = stats.get(localCandidateId);
            return {
                pair: statsArray[0],
                localCandidateType: localCandidate.candidateType
            };
        });

        console.log(`=> stats check: candidateType = ${stats.localCandidateType}`);
        if (stats.localCandidateType === 'relay') {
            console.log('=> TURN relay validation: PASS');
        } else {
            console.log('=> TURN relay validation: FAIL (Type was ' + stats.localCandidateType + ')');
            throw new Error('Not using TURN relay');
        }

        console.log('All TURN tests finished successfully.');
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        if (browser) await browser.close();
    }
})();
