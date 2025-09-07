# Degen Scalper Bot — Phase 1 (Option A)

This repo contains Phase-1 of the Degen Scalper Bot: online dashboard (Vercel) + worker scanner (Render).
Follow the instructions in the project to deploy the UI (Vercel) and the worker (Render). No local installs required.

## Files
- `sniper-worker.js` — backend worker (scanning + Telegram alerts + simple API)
- `web/index.html` — frontend dashboard (Vercel static)
- `.env.example` — environment variable examples

## Env vars (for Render worker)
- RPC_URL
- TELEGRAM_TOKEN
- TELEGRAM_CHAT_ID
- CHECK_INTERVAL_MS (ms)
- DEV_LOOKBACK_LIMIT
- MIN_LIQ_SOL
- MIN_HOLDERS
- TOP10_LIMIT_PCT
- DEV_HOLDING_LIMIT_PCT
- PORT (Render will override)

## Frontend (Vercel) env (optional)
- BACKEND_URL — your Render worker base URL (eg: https://your-worker.onrender.com/)

## Deploy overview
1. Create GitHub repo and add files from this project (web/, sniper-worker.js, package.json, README.md).
2. Deploy `web/` to Vercel (Import GitHub project → select root).
   - Set BACKEND_URL in Vercel Environment Variables to your Render worker URL.
3. Deploy `sniper-worker.js` to Render as a Web Service or Background Worker (start: `node sniper-worker.js`).
   - Set all worker env variables on Render.
4. Configure UptimeRobot to ping `https://<your-render-service>/health` every 5 minutes.
5. Open Vercel URL for dashboard; set your Telegram token and chat id on Render env. Worker will start sending alerts.

If you want help with the GUI paste steps, tell me and I will walk you line-by-line.
