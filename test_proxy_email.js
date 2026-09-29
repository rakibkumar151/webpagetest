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
                `Connection: keep-alive\r\n` +
                `\r\n`
            );
        });

        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('\r\n\r\n')) {
                if (buffer.includes('200')) {
                    console.log('[PROXY] Tunnel OK');
                    socket.removeAllListeners('data');
                    // Patch connect so nodemailer thinks it's a fresh socket
                    socket.connect = (port, host, cb) => { if (cb) cb(); };
                    resolve(socket);
                } else {
                    socket.destroy();
                    reject(new Error('Proxy CONNECT failed: ' + buffer.split('\r\n')[0]));
                }
            }
        });
        socket.on('error', (e) => reject(new Error('Socket error: ' + e.message)));
        socket.setTimeout(15000, () => {
            socket.destroy();
            reject(new Error('Proxy timeout'));
        });
    });
}

async function main() {
    console.log('[TEST] Connecting to proxy...');
    const socket = await createProxyTunnel();

    const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: false,
        auth: {
            user: 'rakibkumar151@gmail.com',
            pass: 'ziasmvxfmtaxrxbx'
        },
        tls: { rejectUnauthorized: false },
        socket: socket
    });

    console.log('[TEST] Sending email...');
    const info = await transport.sendMail({
        from: 'Chet <rakibkumar151@gmail.com>',
        to: 'kuanrhaisn@gmail.com',
        subject: 'Proxy Test OTP',
        text: 'Test OTP code: 999888'
    });

    console.log('[OK] Email sent! Response:', info.response);
}

main().catch(e => console.error('[FAIL]', e.message));
