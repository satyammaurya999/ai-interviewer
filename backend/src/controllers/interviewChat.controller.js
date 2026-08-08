/**
 * interviewChat.controller.js
 *
 * HTTP adapter endpoint: POST /api/interview (no authentication)
 *
 * Delegates all orchestration (session plan, question turns, final report)
 * to the interviewChat service, which reuses the existing AI interview engine.
 */

const { handleInterviewRequest } = require('../services/interviewChat.service');

// ─── POST /api/interview ───────────────────────────────────────────
//   { sessionId, candidate } → start / welcome
//   { sessionId, message }    → continue / finalize
exports.interviewChat = async (req, res, next) => {
  try {
    const payload = await handleInterviewRequest(req.body);
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
};