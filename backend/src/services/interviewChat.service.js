/**
 * interviewChat.service.js
 *
 * HTTP adapter for the challenge interview contract:
 *   POST /api/interview   (no authentication)
 *
 * New session request: { sessionId, candidate }
 * Follow-up request:    { sessionId, message }
 *
 * Response shape:
 *   { reply, done }   → interview in progress
 *   { reply, done: true, feedback: { summary, strengths, gaps, next } }
 *
 * It REUSES the existing interview/session engine and its data sources:
 *   - generateInterviewQuestions   (RAG + personalized question plan)
 *   - evaluateAnswer + generateOverallFeedback
 *   - candidateProfile semantics + curriculum resources
 *
 * State is kept in an in-memory Map keyed by sessionId, so the endpoint is
 * self-contained and needs no auth token, DB write, or changes to the
 * existing REST / Socket.io flows.
 */

const AppError = require('../utils/AppError');
const {
  generateInterviewQuestions,
  evaluateAnswer,
  generateOverallFeedback,
} = require('./ai.service');
const { loadCurriculum } = require('./curriculum.service');

const QUESTIONS_PER_INTERVIEW = 8;

// ── In-memory session store (keyed by sessionId) ───────────────────────────
const sessions = new Map();
const MAX_SESSIONS = 1000;

const pruneSessions = () => {
  if (sessions.size < MAX_SESSIONS * 1.2) return;
  const keys = [...sessions.keys()];
  const excess = keys.length - MAX_SESSIONS;
  if (excess <= 0) return;
  keys.slice(0, excess).forEach((k) => sessions.delete(k));
};

// ── Candidate payload normalization ─────────────────────────────────────────
// Accepts either the profile-file shape ({ member: {...}, missions, signals })
// or a flat candidate object. Mirrors candidateProfile.service semantics.
const normalizeCandidate = (candidate = {}) => {
  const member = candidate.member && typeof candidate.member === 'object'
    ? candidate.member
    : candidate;

  return {
    candidateId: member.id ?? member.candidateId ?? candidate.candidateId ?? null,
    name: member.name ?? candidate.name ?? null,
    jobRole: member.jobRole ?? member.jobTitle ?? candidate.jobTitle ?? 'AI Engineer',
    yearsExperience: Number(member.yearsExperience ?? candidate.yearsExperience ?? 0),
    education: member.education ?? candidate.education ?? null,
    status: member.status ?? candidate.status ?? null,
    missions: Array.isArray(candidate.missions)
      ? candidate.missions.map((m) => ({
          day: m.day ?? null,
          title: m.title ?? '',
          passed: m.passed ?? false,
          skipped: m.skipped ?? false,
          attempts: m.attempts ?? 0,
        }))
      : [],
    signals: candidate.signals ?? {},
  };
};

// Derive the job title + a RAG-usable job description from the candidate payload.
const deriveJobDetails = (candidate = {}) => {
  const member = candidate.member && typeof candidate.member === 'object'
    ? candidate.member
    : candidate;

  const jobTitle =
    candidate.jobTitle ??
    member.jobTitle ??
    member.jobRole ??
    candidate.jobRole ??
    'AI Engineer';

  const parts = [];
  if (Array.isArray(candidate.skills)) parts.push(`Skills: ${candidate.skills.join(', ')}`);
  if (typeof candidate.summary === 'string' && candidate.summary.trim()) parts.push(candidate.summary);
  if (Array.isArray(candidate.experience)) {
    candidate.experience.forEach((e) => {
      if (e.role) parts.push(`- ${e.role}${e.company ? ` at ${e.company}` : ''}${e.duration ? ` (${e.duration})` : ''}`);
    });
  }

  const jobDescription = parts.length
    ? parts.join('\n')
    : `Interviewing a candidate for the role of ${jobTitle} based on their track record.`;

  return { jobTitle, jobDescription };
};

const experienceLevelOf = (profile) => {
  const y = Number(profile.yearsExperience) || 0;
  if (y <= 0) return 'entry';
  if (y <= 6) return 'mid';
  return 'senior';
};

// ── Session lifecycle ───────────────────────────────────────────────────────
// state.status:
//   'created' -> welcome sent; next user message triggers the first question
//   'asking'  -> a question is on the table; next message is the candidate's answer
//   'done'    -> complete; subsequent requests replay the final report
//
// state.askedIndex: index of the question most recently asked.

const welcomeReply = () => ({
  reply: "Welcome. Let's begin your interview.",
  done: false,
});

const buildCompletedReply = (session) => ({
  reply: 'Interview completed.',
  done: true,
  feedback:
    session.feedback ||
    mapFeedbackPayload({ summary: 'Interview completed.', strengths: ['Interview completed'] }),
});

// New session: plan the interview using the existing question generator.
const createSession = async (sessionId, candidatePayload) => {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    return existing.status === 'done' ? buildCompletedReply(existing) : welcomeReply();
  }

  const { jobTitle, jobDescription } = deriveJobDetails(candidatePayload);
  const profile = normalizeCandidate(candidatePayload);
  const curriculum = loadCurriculum();

  const questions = await generateInterviewQuestions({
    jobTitle,
    jobDescription,
    experienceLevel: experienceLevelOf(profile),
    numberOfQuestions: QUESTIONS_PER_INTERVIEW,
    resumeText: null,
    candidateProfile: profile,
    curriculum,
  });

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AppError('Could not generate interview questions.', 500);
  }

  sessions.set(sessionId, {
    sessionId,
    profile,
    curriculum,
    questions,
    askedIndex: -1,
    answers: [],
    liveHistory: [],
    status: 'created',
    feedback: null,
    createdAt: Date.now(),
  });
  pruneSessions();

  return welcomeReply();
};

// Continue an existing conversation with a user message.
const continueSession = async (sessionId, messageText) => {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new AppError('Interview session not found. Start a new session with a candidate payload first.', 404);
  }
  if (session.status === 'done') return buildCompletedReply(session);

  const text = String(messageText || '').trim();
  if (!text) throw new AppError('Message cannot be empty.', 400);

  const total = session.questions.length;
  if (total === 0) {
    session.status = 'done';
    return buildCompletedReply(session);
  }

  // First message after the welcome → open with Q1.
  if (session.status === 'created') {
    session.status = 'asking';
    session.askedIndex = 0;
    const first = session.questions[0];
    session.liveHistory.push({ questionId: first._id ?? null, role: 'assistant', content: first.questionText });
    return { reply: first.questionText, done: false };
  }

  // During 'asking', the incoming message is the answer to the question on the
  // table. Save it, then either move to the next question or complete.
  const current = session.questions[session.askedIndex];
  if (current) {
    session.liveHistory.push({ questionId: current._id ?? null, role: 'user', content: text });
    session.answers.push({
      questionId: current._id ?? null,
      questionText: current.questionText,
      answerText: text,
      timeTaken: 0,
      skipped: false,
    });
  }

  const nextIndex = session.askedIndex + 1;
  if (nextIndex >= total) {
    session.status = 'done';
    await finalizeFeedback(session);
    return buildCompletedReply(session);
  }

  session.askedIndex = nextIndex;
  const next = session.questions[nextIndex];
  session.liveHistory.push({ questionId: next._id ?? null, role: 'assistant', content: next.questionText });
  return { reply: next.questionText, done: false };
};

// Score every saved answer via the existing evaluator, then generate the
// structured final feedback through the existing feedback generator.
const finalizeFeedback = async (session) => {
  const pending = (session.answers || []).filter((a) => a.answerText && a.aiScore === undefined);
  await Promise.all(
    pending.map(async (answer) => {
      try {
        const result = await evaluateAnswer({
          questionText: answer.questionText,
          answerText: answer.answerText,
          expectedKeywords: [],
          jobTitle: session.profile.jobRole ?? 'Candidate',
        });
        answer.aiScore = result.score ?? null;
        answer.aiFeedback = result.feedback ?? null;
      } catch (err) {
        console.warn('[interviewChat] answer evaluation skipped:', err.message);
        answer.aiScore = null;
        answer.aiFeedback = null;
      }
    })
  );

  let overall = {};
  try {
    overall = await generateOverallFeedback({
      jobTitle: session.profile.jobRole ?? 'Candidate',
      experienceLevel: experienceLevelOf(session.profile),
      answers: session.answers,
      liveHistory: session.liveHistory,
      plannedQuestions: session.questions,
      candidateProfile: session.profile,
      curriculum: session.curriculum,
    });
  } catch (err) {
    console.warn('[interviewChat] overall feedback skipped:', err.message);
  }

  session.feedback = mapFeedbackPayload(overall);
  return session;
};

const mapFeedbackPayload = (overall) => ({
  summary:
    overall.overallAssessment ||
    'Interview completed. Review the strengths and next steps for a full breakdown.',
  strengths: pickNonEmpty(
    overall.demonstratedStrongTopics,
    overall.strengths,
    ['Interview completed']
  ),
  gaps: pickNonEmpty(
    overall.needsImprovementTopics,
    overall.weaknesses,
    []
  ),
  next: pickNonEmpty(
    overall.actionableRecommendations,
    overall.improvementTips,
    []
  ),
});

const pickNonEmpty = (...candidates) => {
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
};

// ── Top-level dispatcher used by the controller ─────────────────────────────
// New session  → { sessionId, candidate }
// Follow-up    → { sessionId, message }
const handleInterviewRequest = async (body = {}) => {
  const { sessionId, candidate, message } = body;
  if (!sessionId) throw new AppError('sessionId is required.', 400);

  if (candidate && typeof candidate === 'object' && message === undefined) {
    return createSession(sessionId, candidate);
  }

  if (typeof message === 'string') {
    return continueSession(sessionId, message);
  }

  throw new AppError(
    'Invalid request. Provide { sessionId, candidate } to start or { sessionId, message } to continue.',
    400
  );
};

module.exports = { handleInterviewRequest };