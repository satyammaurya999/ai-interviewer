# 🚀 Vercel Deployment Guide — AI Interviewer

> **Read this first — it is critical.** This project is a **monorepo with two apps**:
>
> - **`frontend/`** — React 18 + Vite SPA → **deploys perfectly on Vercel (static site).**
> - **`backend/`** — Node.js + Express + **Socket.io** + MongoDB + background cron jobs → **NOT fully compatible with Vercel's serverless functions.**

The frontend and backend must be deployed **separately** and connected via API URL + env vars. Follow the layout below: **frontend on Vercel, backend on Render**. If you ignore this and push the whole repo to Vercel, the UI will load but logins, interviews, real-time follow-ups, and dashboards will fail.

---

## 1. What works on Vercel — and what does NOT

| Component | On Vercel? | Why |
|---|---|---|
| Frontend static site (Vite build) | ✅ Yes | Static files + the existing `frontend/vercel.json` SPA rewrites handle React Router routes. |
| REST API (Express `app.js`) | ❌ No (recommended: Render) | Vercel Functions are short-lived / stateless and would require code changes. Render runs the same Express app unchanged. |
| **Socket.io real-time follow-ups** | ❌ No | Vercel Functions are short-lived / stateless. Long-lived WebSocket connections used by `InterviewSessionPage` (import `socket.js`) do not hold on serverless. |
| Background cron jobs (`jobSyncScheduler`, `jobCleanupService`) | ❌ No | Scheduled `node-cron` loops never run in an ephemeral, request-based function. |
| **In-memory `sessionId` Map** (`interviewChat.service.js`) | ❌ No | Serverless instances are reset/duplicated per request; the in-memory Map holding `/api/interview` sessions is lost. |
| **Local HuggingFace embeddings** (`@huggingface/transformers` model `all-MiniLM-L6-v2`) | ⚠️ Risky | Downloads a ~90 MB model on first run. It can exceed the 50 MB function bundle/duration limits and slow cold starts (RAG falls back gracefully, though). |
| MongoDB / Redis / Cloudinary / Groq | ✅ As external services | They are just keys/URIs you provide via env vars. |

**Conclusion:** Use Vercel for the **frontend only**. Run the **backend on Render**, which supports a persistent Node.js process (WebSockets + cron included). A step-by-step path for both is below.

---

## 🏗 Architecture After Deployment

```
Vercel (frontend)                    Render (backend)
────────────────────────            ──────────────────────
┌───────────────────────┐           ┌───────────────────────────────┐
│  Vite React SPA        │  /api  →  │  Express :5000                │
│  (Vercel static)       │──────────→│  + Socket.io (real-time)      │
│                       │           │  + MongoDB, Redis, Cloudinary │
│  Socket.io client ✔    │──────────→│  + Groq + local embeddings    │
└───────────────────────┘           └───────────────────────────────┘
```

- Frontend build reads **`VITE_API_URL`** at build time → must be the backend's public URL.
- Backend **`CLIENT_URL`** (CORS) must be the frontend's public URL.

---

## Step 1 — Deploy the Backend on Render

### 1a. Push the repo to GitHub

```bash
git add -A
git commit -m "Ready for deployment"
git remote add origin https://github.com/<your-username>/AI-Interviewer.git
git push -u origin main
```

> Don't forget CI: the `.env`, `node_modules/`, and `logs/` folders are already git-ignored. `backend/data/` is committed, so `candidateProfiles.json` and `curriculum.json` ship with the repo.

### 1b. Create the backend service on Render

A persistent Node process on Render, WebSockets + cron included:

1. Go to [render.com](https://render.com) → **New** → **Web Service** → connect your GitHub repo.
2. Fill the form:
   - **Name:** `ai-interviewer-backend`
   - **Root Directory:** `backend`  *(only the backend subfolder)*
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.js`
   - **Instance Type:** Starter (or free for testing; free sleeps after 15 min of inactivity)
3. **Add the environment variables** (all of them — see the table in Step 4).
4. **Deploy.** The URL will look like `https://ai-interviewer-backend.onrender.com`.

---

## Step 2 — Deploy the Frontend (Vercel)

### 2a. Import the repo

1. Go to [vercel.com](https://vercel.com) → **Add New…** → **Project**.
2. Import your GitHub repo `AI-Interviewer`.
3. **Manual configuration needed:**
   - **Root Directory:** `frontend`   ← because the repo root is a monorepo
     - (If the field says "Detected: Vite", pick it. Vercel will detect the root.)
   - **Framework Preset:** `Vite`
   - **Build Command:** `npm run build` → make sure it's correctly `vite build`
   - **Output Directory:** `dist`

### 2b. Add the frontend env var (required)

In **Settings → Environment Variables**, add:

```
VITE_API_URL=https://ai-interviewer-backend.onrender.com/api
```

- This value is **baked into the JS bundle at build time** — set it **before** (or as part of) the first deployment.
- The axios client (`frontend/src/lib/axios.js`) uses it as the base URL; the Socket.io client (`InterviewSessionPage.jsx`) uses it for `io(...)`.
- If you use the free Vercel domains / custom domain, this stays the same; it points to **your backend**, not to the frontend.

### 2c. Deploy

Click **Deploy**. The frontend goes live at `https://<your-app>.vercel.app`.

The existing `frontend/vercel.json`:
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```
is automatically respected and makes React Router's `/dashboard`, `/interview/...`, etc. work without 404s.

---

## Step 3 — Wire Up CORS (Render Env)

The backend whitelists only ONE origin (its CORS is strict by design — see `backend/src/app.js`). So the backend's `CLIENT_URL` must be set to the frontend URL.

```
CLIENT_URL=https://<your-app>.vercel.app
```

> Only one exact origin is allowed (the backend's CORS is strict by design — see `backend/src/app.js`). If you later add a custom frontend domain, update `CLIENT_URL`, restart the backend, and redeploy the frontend. Do **not** use `*` as a value, since the app sends `credentials: true`. If you genuinely need multiple frontend origins, modify the CORS block in `app.js` to accept a comma-separated list:

```js
// backend/src/app.js — inside app.use(cors({...}))
const allowed = process.env.CLIENT_URL || 'http://localhost:5173';
const allowedList = allowed.split(',');
if (!origin || allowedList.includes(origin.replace(/\/$/, ''))) return callback(null, true);
```

---

## Step 4 — Env Vars: Backend (all under Render)

Create `backend/.env` locally first (copy `backend/.env.example`), use the same values in Render/your platform — both are shown:

```env
# Server — Render assigns the PORT; use this for both local + deploy
PORT=5000
NODE_ENV=production

# Database (MongoDB Atlas)
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/ai_interview_db

# JWT — use strong, long secrets (≥32 chars)
JWT_SECRET=<random_32+_chars>
JWT_EXPIRE=7d
JWT_REFRESH_SECRET=<another_random_32+_chars>
JWT_REFRESH_EXPIRE=30d

# Groq — required
GROQ_API_KEY=gsk_xxxx

# OpenAI — optional (legacy; the RAG pipeline uses local embeddings)
OPENAI_API_KEY=sk-xxxx

# Cloudinary — required for resume uploads
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# CORS origin of the deployed frontend
CLIENT_URL=https://your-app.vercel.app

# Rate limit
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100

# Redis — optional; set false if you don't have a host
REDIS_ENABLED=false
# REDIS_URL=redis://default:xxxx@xxxx.upstash.io:6379

# Optional (Job board) — Adzuna
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
ADZUNA_COUNTRY=in
```

**Minimum viable set:** `PORT`, `NODE_ENV`, `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GROQ_API_KEY`, `CLIENT_URL`. Redis can be left off (`REDIS_ENABLED=false`). Cloudinary only when resume upload is used.

> Keep the two JWT secrets distinct, delete the example `your_...` placeholder values, and never commit `.env`.

---

## Step 5 — Verify

After both are up:

1. **Health check** — open `https://ai-interviewer-backend.onrender.com/api/health` → `{ "success": true, "message": "OK" }`.
2. **Frontend loads** — open `https://your-app.vercel.app`.
3. **Sign-up / login** — should hit MongoDB through the backend (watch backend logs).
4. **Create + generate an interview** (proves GROQ key works).
5. **Jobs page** — without Redis and with Adzuna unset, should degrade gracefully.
6. **Live follow-ups happen only over Socket.io** — verify the WebSocket upgrade works: in devtools Network → WS shows a `io` connection to `wss://…onrender.com/socket.io/`.

---

## Step 6 — Troubleshooting

| Symptom | Fix |
|---|---|
| Frontend can't reach APIs (logs show `ERR_CONNECTION`, CORS errors) | `VITE_API_URL` is wrong/missing → set it and redeploy; backend must be public. Check `CLIENT_URL` on backend matches the frontend origin exactly. |
| Login works but dashboard empty | MongoDB missing (check `MONGO_URI`), or backend logs show "MongoDB connection error". |
| RAG / embeddings slow or time out on first use | Local model downloads on first run. Pre-warm (Hit a `/generate` once) or is benign. Fallback is automatic. |
| WebSocket live follow-up disconnect | Verify the backend is the persistent Render Web Service (`node src/server.js`), not a serverless host. Check Render logs for the socket.io boot lines. |
| `/api/interview` sessions reset | Expected on any restart/multi-instance (in-memory Map). Persist to a DB for production. |
| Custom domain CORS blocked | Set `CLIENT_URL` to the exact custom domain (no trailing `/`), restart backend, redeploy frontend. |

---

## Final Word

Fast and correct:

```
Vercel  : frontend/   → Vite SPA              → VITE_API_URL = https://your-backend.onrender.com/api
Render  : backend/    → node src/server.js    → CLIENT_URL   = https://your-app.vercel.app
```

That yields a working login, dashboard, RAG questions, live real-time interviews, and reports — with Vercel serving the free, always-on static frontend and Render running the full persistent backend.