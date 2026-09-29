const net = require('net');
const nodemailer = require('nodemailer');

const PROXY_HOST = 'change4.owlproxy.com';
const PROXY_PORT = 7778;
const PROXY_USER = 'izUU8KQkEm50_custom_zone_IN_st__city_sid_26821469_time_5';
const PROXY_PASS = '5559057';
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;

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

// Create a local TCP server that pipes through the proxy tunnel
// nodemailer connects to localhost:randomPort → we tunnel it to smtp.gmail.com:587 via proxy
function createLocalProxy() {
    return new Promise((resolve, reject) => {
        const server = net.createServer(async (clientSocket) => {
            try {
                console.log('[PROXY-LOCAL] Client connected, opening proxy tunnel...');
                const proxySocket = await createProxyTunnel();
                console.log('[PROXY-LOCAL] Tunnel established, piping...');
                clientSocket.pipe(proxySocket);
                proxySocket.pipe(clientSocket);
                clientSocket.on('error', () => proxySocket.destroy());
                proxySocket.on('error', (e) => { console.error('[PROXY-LOCAL] Tunnel error:', e.message); clientSocket.destroy(); });
                clientSocket.on('close', () => proxySocket.destroy());
                proxySocket.on('close', () => clientSocket.destroy());
            } catch (e) {
                console.error('[PROXY-LOCAL] Tunnel setup failed:', e.message);
                clientSocket.destroy();
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            console.log(`[PROXY-LOCAL] Local SMTP proxy on port ${port}`);
            resolve({ server, port });
        });
        server.on('error', reject);
    });
}

async function main() {
    console.log('[TEST] Setting up local proxy...');
    const { server, port } = await createLocalProxy();

    try {
        const transport = nodemailer.createTransport({
            host: '127.0.0.1',
            port: port,
            secure: false,
            auth: {
                user: 'rakibkumar151@gmail.com',
                pass: 'ziasmvxfmtaxrxbx'
            },
            tls: { rejectUnauthorized: false }
        });

        console.log('[TEST] Sending email via proxy tunnel...');
        const info = await transport.sendMail({
            from: 'Chet <rakibkumar151@gmail.com>',
            to: 'kuanrhaisn@gmail.com',
            subject: 'Chet OTP Test via Proxy',
            text: 'Your OTP: 123456'
        });

        console.log('[OK] Email sent!', info.response);
    } finally {
        server.close();
    }
}

main().catch(e => console.error('[FAIL]', e.message));
