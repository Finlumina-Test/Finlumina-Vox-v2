# Finlumina-Vox-v2 (Node) — Twilio <> OpenAI Realtime (GA-ready)

Deploy target public host (example): https://finlumina-vox-v2.onrender.com

## Env (set in Render)
- OPENAI_API_KEY
- OPENAI_REALTIME_MODEL (defaults to `gpt-realtime`)
- PUBLIC_HOST (your render URL)
- SYSTEM_INSTRUCTIONS
- TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (optional for server-side hangup)
- SESSION_RENEW_INTERVAL_MS, MAX_CONCURRENT_CALLS, LOG_LEVEL

## Deploy
1. push to GitHub.
2. Render: New → Web Service → connect repo → build `npm install`, start `npm start`.
3. Add env vars in Render dashboard.
4. In Twilio console, set phone number voice webhook (A Call Comes In) to:
   `https://finlumina-vox-v2.onrender.com/incoming-call` (POST).

## Notes & references
- Model: `gpt-realtime` (OpenAI Realtime GA).  [oai_citation:6‡OpenAI](https://openai.com/index/introducing-gpt-realtime/?utm_source=chatgpt.com)
- Twilio Media Streams expects base64 `audio/x-mulaw` at 8000Hz for media messages (we use `audio/pcmu` in session).  [oai_citation:7‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages?utm_source=chatgpt.com)
- Session.update is sent with model + audio config; we renew the session every ~55 minutes to avoid stale sessions.

Test locally with `ngrok http 5050` before deploying to Render.