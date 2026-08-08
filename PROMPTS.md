# PROMPTS.md — AI Usage & Prompt Log

> This file logs the AI-assistive prompting process behind the **AI Cohort Interview Agent** challenge work in this repository. It is part of the hackathon submission and documents *how* the AI-driven changes were requested and verified.

---

## 1. Purpose

This document records the prompts and prompting methodology used to evolve the `AI Interviewer` application into a **curriculum-grounded, candidate-personalized, adaptively-probed interview system** with a challenge-required unauthenticated HTTP adapter.

**Evidence basis.** There are no prompt/transcript files stored in the repository itself. This log is reconstructed from:

1. The **repository working tree diff** vs. the single baseline commit `bc1b080` (`project-completed`). Only one commit exists in this repo, so the uncommitted working-tree changes *are* the challenge-phase evolution.
2. The **current source code** (file paths and line numbers cited below).
3. The **development session** that produced the uncommitted work, whose prompts are quoted where the original wording is preserved and clearly labeled as **reconstructed prompt summaries** where it is not.

---

## 2. AI-Assisted Development Approach

The work followed a consistent, evidence-first methodology:

- **Baseline reuse.** The pre-existing engine (`ai.service.js`, `rag.service.js`, `chunking.service.js`, `optimizer.service.js`, `SystemPrompt` model) already contained the interview planner, RAG pipeline, and evaluator. The challenge work **extended** these rather than rewriting them.
- **Data-first grounding.** Candidate profiles (`backend/data/candidateProfiles.json`) and the official 31-day AI curriculum (`backend/data/curriculum.json`) were introduced as first-class inputs, loaded through dedicated services (`candidateProfile.service.js`, `curriculum.service.js`).
- **Constraint enforcement via prompt design.** `generateInterviewQuestions` was asked to enforce ≥ 8 questions across ≥ 4 distinct curriculum days, with a corrective retry when the model misses the constraint (`ai.service.js:98-99, 146-151, 260, 325, 353`).
- **Adaptive runtime behavior.** The Socket.io `live_answer` handler was upgraded from a static follow-up to a STRONG/WEAK/PARTIAL-aware adaptive follow-up with bounded depth (`socket.js`).
- **Reuse-first adapter.** The challenge `POST /api/interview` endpoint was implemented as a thin orchestration layer (`interviewChat.service.js`) over the existing planner/evaluator/feedback generator rather than a from-scratch reimplementation.
- **Verification at each stage.** Unit tests for the adapter state machine (`backend/src/tests/interviewChat.service.test.js`), a live end-to-end HTTP run against the real Groq API, and a final read-only audit against the problem statement.

> **Note on embeddings.** The committed RAG pipeline already used **local Hugging Face Transformers embeddings** (`@langchain/community`, `Xenova/all-MiniLM-L6-v2`) at the baseline commit (`rag.service.js:1,34`). The challenge-phase diff does not modify `rag.service.js`, so the repository does **not** show a prompt-driven "transition away from OpenAI embeddings" within the logged challenge work — local embeddings were already in place. (This is a deliberate correction of any impression that the challenge prompts changed the embedding backend.)

---

## 3. Prompt Development Timeline

The development unfolded in the phases below. The **Prompt** column shows whether the original wording survives verbatim in the session log or is reconstructed from the resulting code/diff.

| Phase | Focus | Prompt availability | Key outcome (evidence) |
|---|---|---|---|
| 1 | Architecture analysis | Session start (verbatim) | Mapped existing engine before touching code |
| 2 | RAG pipeline & embeddings | Pre-baseline (no prompt log) | Already present at commit `bc1b080`; unchanged this phase |
| 3 | Candidate profile + handover | Reconstructed summary | `candidateProfile.service.js` + `candidateProfiles.json`; `candidateId` on `Interview` |
| 4 | Curriculum engine | Reconstructed summary | `curriculum.service.js` + `curriculum.json`; day/module/topic lookups |
| 5 | Personalized curriculum-grounded generation | Reconstructed summary | Constraints (≥8 Q, ≥4 days) + corrective retry in `ai.service.js` |
| 6 | Adaptive live conversation | Reconstructed summary | STRONG/WEAK/PARTIAL follow-ups + `liveHistory` in `socket.js` |
| 7 | Structured final feedback | Reconstructed summary | Structured fields on `Session` + render in `SessionResultPage.jsx` |
| 8 | Hackathon HTTP adapter | Verbatim opening | `POST /api/interview` adapter (`interviewChat.*`) |
| 9 | Testing, E2E verification & final audit | Verbatim openings | Unit tests, live E2E, 12/13 requirement audit |
| 10 | Documentation | Verbatim opening | `document.md` (project docs), then this `PROMPTS.md` |

---

## 4. Important Prompts / Prompt Summaries

Each entry lists the prompt (verbatim when available) and the follow-up verification instruction.

### Phase 1 — Architecture analysis

**Original prompt (verbatim, session opening):**
> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

**What was done:** inspected the route mounting in `backend/src/app.js`, the existing controllers/models/services, and the committed engine to determine where the challenge adapter should be wired. No code was changed in this phase.

---

### Phase 2 — RAG pipeline & embeddings

**Availability:** No prompt log exists for this phase; it predates the recorded session and is part of the baseline commit `bc1b080`.

**Evidence in repo:** `rag.service.js` implements a full in-process pipeline — semantic chunking (`chunking.service.js`), normalization (`utils/normalizer.js`), local `HuggingFaceTransformersEmbeddings` (`rag.service.js:1,34`), query optimization (`optimizer.service.js`), and cosine-similarity retrieval with section boosting. This phase was reused unchanged by the challenge work.

---

### Phase 3 — Candidate profile + handover logic

> Reconstructed from the implementation history; this is a summary and not the original wording.

**Reconstructed prompt summary:** Load candidate profiles from `backend/data/candidateProfiles.json`; expose a `getCandidateProfile(candidateId)` lookup with normalization; support a `candidateId` on the `Interview` model; and pass the candidate's role, experience, mission progress, attempts, and learning signals into question generation and final feedback so interviews are personalized to the learner.

**Evidence:** `backend/src/services/candidateProfile.service.js` (untracked, new); `backend/data/candidateProfiles.json`; `Interview.model.js` (`candidateId`); `interview.controller.js:54-57` and `session.controller.js:124-127` load the profile before generation/completion; `ai.service.js:25` (`buildCandidateProfileContext`); `socket.js` (`buildProfileBrief`).

---

### Phase 4 — Curriculum engine

> Reconstructed from the implementation history; this is a summary and not the original wording.

**Reconstructed prompt summary:** Load the official 31-day / 8-module AI curriculum from `backend/data/curriculum.json`; expose cached lookups (`getCurriculumDay`, `getCurriculumModule`, `getCurriculumDaysByTopic`, `reloadCurriculum`); and make the curriculum a grounding input to question generation, live follow-ups, and feedback.

**Evidence:** `backend/src/services/curriculum.service.js` (untracked, new); `backend/data/curriculum.json`; `ai.service.js:66` (`buildCurriculumContext`); `socket.js` (`resolveCurriculumDayContext`).

---

### Phase 5 — Personalized curriculum-grounded interview generation

> Reconstructed from the implementation history; this is a summary and not the original wording.

**Reconstructed prompt summary:** Enhance `generateInterviewQuestions` so the planner prompt combines RAG context, the candidate profile, and the full curriculum; require the output to contain **at least 8 questions** covering **at least 4 distinct curriculum days**; distribute ~2/3 technical / ~1/3 behavioral; anchor each question to a real curriculum day; and if the model's first response violates the constraints, run a single corrective retry before slicing to the effective target.

**Evidence:** `ai.service.js:98` `MIN_QUESTIONS = 8`; `:99` `MIN_CURRICULUM_DAYS = 4`; `:146-151` `meetsPlanningConstraints`; `:226-227` effective target `Math.max(MIN_QUESTIONS, ...)`; `:260` COVERAGE instruction; `:325` corrective-retry note; `:353` `Math.max(MIN_QUESTIONS, Math.min(...))`.

---

### Phase 6 — Adaptive live conversation (Socket.io)

> Reconstructed from the implementation history; this is a summary and not the original wording.

**Reconstructed prompt summary:** Upgrade the `live_answer` handler so the interviewer evaluates each answer and adapts: STRONG → acknowledge + deeper application-oriented probe; WEAK → simplify to a foundational conceptual probe; PARTIAL → probe the specific missing concept. Ground the follow-up in the candidate profile and the current curriculum day, keep responses to 1–3 conversational sentences, persist every user/assistant exchange into a `Session.liveHistory` array for cross-turn continuity, and bound depth (`MAX_LIVE_EXCHANGES_PER_QUESTION = 3`, `MAX_LIVE_TOTAL_EXCHANGES = 20`). The frontend should send `sessionId` + `questionId` with each `live_answer`.

**Evidence:** `socket.js` (entire adaptive rewrite; diff vs. baseline shows the static handler replaced by `handleLiveAnswer` with STRONG/WEAK/PARTIAL branching); `Session.model.js` (`liveExchangeSchema`, `liveHistory`); `frontend/src/pages/interview/InterviewSessionPage.jsx:60-61` (emits `sessionId`/`questionId`).

---

### Phase 7 — Structured final feedback

> Reconstructed from the implementation history; this is a summary and not the original wording.

**Reconstructed prompt summary:** Extend `generateOverallFeedback` (and the `Session` model) to produce structured fields — `overallAssessment`, `curriculumDaysAssessed`, `demonstratedStrongTopics`, `needsImprovementTopics`, `technicalReasoning`, `actionableRecommendations` — derived from answers, the live follow-up history, the planned curriculum coverage, and the candidate profile. Persist these on the completed session and render a "Structured Interview Feedback" card on the results page.

**Evidence:** `session.controller.js:149-155` (persists structured fields); `Session.model.js` (new fields); `frontend/src/pages/interview/SessionResultPage.jsx` (Structured Interview Feedback block); `ai.service.js:409` (`generateOverallFeedback`), `:428` (profile brief reused).

---

### Phase 8 — Hackathon HTTP adapter (`POST /api/interview`)

**Original prompt (verbatim opening; the remainder of the message — the full Technical Specification and response contracts — was elided from the session log):**
> Continue the current backend task: implement the challenge-required HTTP API adapter.

**What was requested (as executed):** implement an unauthenticated `POST /api/interview` endpoint keyed by a caller-supplied `sessionId`:
- `{ sessionId, candidate }` → create a session, plan 8+ curriculum-grounded questions via the existing generator, reply with a welcome (`done: false`).
- `{ sessionId, message }` → walk through the planned questions; the final answer triggers per-answer evaluation and `generateOverallFeedback`, returning `{ reply, done: true, feedback: { summary, strengths, gaps, next } }`.
- `400` missing `sessionId` / invalid shape; `404` unknown `sessionId`; completed sessions replay the report.

**Evidence:** `backend/src/routes/interviewChat.routes.js` (no auth middleware); `backend/src/controllers/interviewChat.controller.js`; `backend/src/services/interviewChat.service.js` (in-memory `Map` state machine, `createSession` → `continueSession` → `finalizeFeedback` → `mapFeedbackPayload`); mounted at `backend/src/app.js:111` (`app.use('/api/interview', interviewChatRoutes)`).

---

### Phase 9 — Testing, end-to-end verification & final audit

**Original prompt (verbatim opening; specific steps elided):**
> Now perform an end-to-end test of the newly implemented POST /api/interview adapter.

**What was done:** ran the live server against the real Groq API and exercised the full contract — session creation, the complete 8-question walk, final feedback payload, unknown-session 404, missing-`sessionId` 400, and completed-session replay. All returned the documented status codes and shapes.

**Verification prompt (verbatim opening; checklist elided):**
> Perform a FINAL READ-ONLY audit of the project against the AI Cohort problem statement and Technical Specification.

**Audit result:** **12 of 13** challenge requirements verified as fully met; 1 requirement (**adaptive follow-up within the adapter itself**) scored **partial** — the STRONG/WEAK/PARTIAL adaptive follow-up lives in the Socket.io flow (`socket.js`) while the HTTP adapter advances through the planned question set without per-turn adaptive branching (also documented as a limitation in `document.md` §19).

**Unit tests:** `backend/src/tests/interviewChat.service.test.js` — 6 tests (mocked AI + curriculum services): welcome reply; first question; full walk-through to completion with feedback; completed-report replay; unknown session 404; missing `sessionId` 400. All pass.

---

### Phase 10 — Documentation

**Original prompt (verbatim opening; contents elided):**
> Create a complete project documentation file named document.md for this repository.

**Evidence:** `document.md` — full project documentation (architecture, data flows, API reference, problem-statement mapping, setup, testing checklist, design decisions, limitations).

**Current prompt (verbatim):** *Create ONLY a PROMPTS.md file at the repository root to log the AI usage and prompts for this hackathon submission.* — this document is the result.
