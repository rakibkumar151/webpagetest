# Render Deployment Guide
# Follow these exact steps to deploy to Render.com

## STEP 1 — Signaling Server (Web Service)

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repository
3. Settings:
   - Root Directory: `webrtc-voice-call/signaling`
   - Runtime: Docker
   - Build Command: (auto from Dockerfile)
   - Start Command: `node server.js`
4. Environment Variables (set in Render dashboard):
   - TURN_SECRET     = (your strong random secret — must match coturn)
   - TURN_HOST       = (your VPS IP or domain where coturn runs)
   - FRONTEND_ORIGIN = https://your-frontend.onrender.com
   - PORT            = 3000

## STEP 2 — Frontend (Static Site)

1. Render → New → Static Site
2. Connect same repository
3. Settings:
   - Root Directory: `webrtc-voice-call/web`
   - Build Command: (none)
   - Publish Directory: `.`
4. After deploy, copy the frontend URL (e.g. https://securevoice.onrender.com)

## STEP 3 — Update Frontend Config

In `web/index.html`, update this line:
```js
: 'https://your-signaling-server.onrender.com'
```
Replace `your-signaling-server` with your actual Render Web Service URL.

Then go to Render Web Service → Environment → FRONTEND_ORIGIN
Set it to your Static Site URL.

## STEP 4 — Coturn on VPS (required for TURN)

On your Linux VPS:
```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone your repo
git clone <your-repo> /opt/securevoice
cd /opt/securevoice/webrtc-voice-call

# Create .env
echo "TURN_SECRET=<same secret as Render>" > .env
echo "TURN_HOST=<this VPS public IP>" >> .env

# Open firewall ports
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 49152:65535/udp

# Add SSL certs to infrastructure/coturn/ssl/
# (use certbot or your CA)

# Edit turnserver.conf — uncomment and set:
# external-ip=<this VPS public IP>

# Start coturn
docker compose up -d coturn
```

## PORTS THAT MUST BE OPEN

| Port         | Protocol | Service         | Required |
|-------------|----------|-----------------|----------|
| 3000        | TCP/WS   | Signaling       | Render handles |
| 3478        | UDP      | TURN UDP        | VPS firewall  |
| 3478        | TCP      | TURN TCP        | VPS firewall  |
| 5349        | TCP      | TURN TLS        | VPS firewall  |
| 49152-65535 | UDP      | Relay ports     | VPS firewall  |
