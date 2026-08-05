# FRAME Backend

Small Node server that holds your Anthropic API key so app users never paste keys.
Two endpoints: `POST /api/generate` and `POST /api/rate`. Rate-limited to 10 req/min/IP.
Zero npm dependencies — it's one file of plain Node.js, nothing to break.

## Deploy free on Render (~10 minutes)

1. Put this `backend/` folder in a GitHub repo (free account at github.com — upload the files via the web UI, no git skills needed).
2. Go to [render.com](https://render.com) → sign up free → **New → Web Service** → connect the repo.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`. Free instance type.
4. Under **Environment**, add `ANTHROPIC_API_KEY` = your key from console.anthropic.com.
5. Deploy. You'll get a URL like `https://frame-backend.onrender.com`.
6. Test it: open `https://your-url.onrender.com/health` — you should see `{"ok":true,...}`.
7. Put that URL into `app/www/index.html` as `BACKEND_URL` (see the master README).

Note: Render's free tier sleeps after inactivity — the first request after a quiet spell
takes ~30s to wake. Fine for beta; the $7/mo tier removes it for launch.

## Optional hardening

- Set `APP_SECRET` to any random string here AND in the app's `APP_SECRET` constant —
  casual freeloaders hitting your API from curl get 401s.
- Costs: each generate/rate call costs a fraction of a cent. The rate limiter caps
  worst-case abuse; watch usage at console.anthropic.com.

## Run locally

```bash
cd backend
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# → http://localhost:3000/health
```
