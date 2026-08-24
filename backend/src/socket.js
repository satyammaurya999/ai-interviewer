const { Server } = require("socket.io");
const Groq = require("groq-sdk");
require("dotenv").config();
const SystemPrompt = require('./models/SystemPrompt.model');
const Session = require('./models/Session.model');
const Interview = require('./models/Interview.model');
const { DEFAULT_GROQ_MODEL } = require('./config/aiModel');
const { getCandidateProfile } = require('./services/candidateProfile.service');
const {
  loadCurriculum,
  getCurriculumDay,
  getCurriculumModule,
  getCurriculumDaysByTopic,
} = require('./services/curriculum.service');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_LIVE_EXCHANGES_PER_QUESTION = 3;
const MAX_LIVE_TOTAL_EXCHANGES = 20;

// ── Context builders ─────────────────────────────────────────────────────────

const buildProfileBrief = (profile) => {
  if (!profile) return 'No candidate profile provided.';
  const missions = Array.isArray(profile.missions) ? profile.missions : [];
  const completed = missions.filter((m) => m.passed && !m.skipped).map((m) => m.title);
  const skipped = missions.filter((m) => m.skipped).map((m) => m.title);
  const failed = missions.filter((m) => !m.passed && !m.skipped).map((m) => m.title);

  const lines = [
    `Name: ${profile.name || 'N/A'}`,
    `Job Role: ${profile.jobRole || 'N/A'}`,
    `Years of Experience: ${profile.yearsExperience ?? 0}`,
  ];
  if (profile.education) lines.push(`Education: ${profile.education}`);
  if (completed.length) lines.push(`Completed missions: ${completed.join('; ')}`);
  if (failed.length) lines.push(`Unpassed/failed missions: ${failed.join('; ')}`);
  if (skipped.length) lines.push(`Skipped missions: ${skipped.join('; ')}`);
  if (profile.signals) lines.push(`Learning signals: ${JSON.stringify(profile.signals)}`);
  return lines.join('\n');
};

const resolveCurriculumDayContext = (question, curriculum) => {
  let dayNumber = Number(question?.curriculumDay);
  if (!(Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 31)) {
    const keyword = Array.isArray(question?.expectedKeywords) && question.expectedKeywords.length
      ? question.expectedKeywords[0]
      : null;
    if (keyword) {
      const matches = getCurriculumDaysByTopic(keyword);
      if (matches.length) dayNumber = Number(matches[0].day);
    }
  }

  if (!dayNumber) return null;

  const day = getCurriculumDay(dayNumber);
  const module = getCurriculumModule(dayNumber);
  const lines = [`Day ${dayNumber}: ${day?.title || 'Unknown topic'}${day?.type ? ` (${day.type})` : ''}`];
  if (module) lines.push(`Module: ${module.title}`);
  if (day && Array.isArray(day.tools) && day.tools.length) lines.push(`Tools: ${day.tools.join(', ')}`);
  if (day && Array.isArray(day.objectives) && day.objectives.length) lines.push(`Objectives: ${day.objectives.join('; ')}`);
  return lines.join('\n');
};

const buildLiveHistory = (session, currentQuestionId) => {
  const lines = [];
  const own = (session.liveHistory || [])
    .filter((e) => !currentQuestionId || !e.questionId || e.questionId.toString() === currentQuestionId.toString());
  own.forEach((e) => {
    lines.push(`${e.role === 'assistant' ? 'AI follow-up' : 'Candidate'}: ${e.content}`);
  });
  return lines.join('\n');
};

// ── Handler ──────────────────────────────────────────────────────────────────

const handleLiveAnswer = async (socket, payload) => {
  const {
    sessionId,
    questionId,
    questionText,
    answerText,
    expectedKeywords,
  } = payload || {};

  let session = null;
  let interview = null;

  try {
    if (sessionId) {
      session = await Session.findById(sessionId);
      if (session) interview = await Interview.findById(session.interviewId);
    }
  } catch (err) {
    console.error("[Socket.io] Failed to load session context:", err.message);
  }

  const candidateProfile = interview?.candidateId
    ? await getCandidateProfile(interview.candidateId)
    : null;

  const curriculum = loadCurriculum();

  // Resolve current question (DB source of truth when available)
  let currentQuestion = null;
  if (interview && questionId) {
    currentQuestion = interview.questions.id(questionId) || null;
  }

  const effectiveKeywords = (currentQuestion?.expectedKeywords || expectedKeywords || []);
  const effectiveQuestionText = currentQuestion?.questionText || questionText || '';

  // ── Loop guard: bounded live follow-up exchanges ───────────────────────
  const perQuestionCount = (session?.liveHistory || [])
    .filter((e) => e.role === 'assistant' && e.questionId?.toString() === questionId).length;
  const totalCount = (session?.liveHistory || []).filter((e) => e.role === 'assistant').length;

  if (
    (perQuestionCount >= MAX_LIVE_EXCHANGES_PER_QUESTION) ||
    (totalCount >= MAX_LIVE_TOTAL_EXCHANGES)
  ) {
    const notice = "That's enough depth on this topic. Let's move on to the next part of the interview.";
    socket.emit("ai_chunk", notice);
    socket.emit("ai_complete");
    return;
  }

  try {
    let systemPromptText = `Act as an AI interviewer. The candidate just responded to the following question. Provide a brief, conversational, and direct 1-3 sentence follow-up or acknowledgment based ONLY on their answer. Do not return JSON. Just speak as an interviewer naturally.`;
    try {
      const doc = await SystemPrompt.findOne({ category: 'interview' });
      if (doc) systemPromptText = doc.content;
    } catch (e) { /* ignore fallback */ }

    const dayContext = resolveCurriculumDayContext(currentQuestion, curriculum);
    const history = buildLiveHistory(session, questionId);

    const adaptiveSystem = `${systemPromptText}

You are running an adaptive live interview follow-up. You MUST:
- Evaluate the candidate's latest answer quality.
- STRONG answer → give a short acknowledgment and ask a deeper, application-oriented follow-up (edge cases, trade-offs, scaling).
- WEAK or brief answer → simplify to a foundational, conceptual probe of the same topic.
- PARTIAL answer → probe the specific missing concept only.
- NEVER simply repeat the question or the previous follow-up.
- Stay strictly grounded in the candidate profile and the current curriculum day/topic provided below.
- Keep every response to 1-3 conversational sentences. No JSON, no scoring.`;

    const prompt = `${adaptiveSystem}

Job Title: ${interview?.jobTitle || 'N/A'}
Experience Level: ${interview?.experienceLevel || 'N/A'}

Candidate Profile:
${buildProfileBrief(candidateProfile)}

Current Curriculum Day / Topic:
${dayContext || 'Not determined'}

Overall Coverage Plan:
- Total planned questions: ${interview?.questions?.length ?? 'N/A'}
- Planned curriculum days: ${[...new Set((interview?.questions || []).map((q) => q.curriculumDay).filter(Boolean))].join(', ') || 'N/A'}
- Stay within this plan. Do not introduce curriculum topics outside of it.

Previous conversation (this session, latest first):
${history || 'None yet'}

Current Question: ${effectiveQuestionText}
Expected Keywords: ${effectiveKeywords.join(', ') || 'None'}
Candidate Answer: ${answerText || '(silence)'}`;

    const stream = await groq.chat.completions.create({
      model: DEFAULT_GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens: 150,
      stream: true,
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullResponse += content;
        socket.emit("ai_chunk", content);
      }
    }

    // Persist the exchange for cross-turn continuity (best-effort)
    if (session) {
      try {
        session.liveHistory.push({ questionId: questionId || null, role: 'user', content: answerText || '(silence)' });
        session.liveHistory.push({ questionId: questionId || null, role: 'assistant', content: fullResponse });
        await session.save();
      } catch (err) {
        console.error("[Socket.io] Failed to persist live history:", err.message);
      }
    }

    socket.emit("ai_complete");
  } catch (error) {
    console.error("Socket Groq Error:", error);
    socket.emit("ai_error", "Failed to get AI response.");
  }
};

const initSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);

    // Listen for live interview responses
    socket.on("live_answer", async (payload) => {
      await handleLiveAnswer(socket, payload);
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.io] Client disconnected: ${socket.id}`);
    });
  });
};

module.exports = initSocket;
