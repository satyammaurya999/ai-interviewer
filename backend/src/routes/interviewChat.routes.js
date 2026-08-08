/**
 * interviewChat.routes.js
 *
 * Public adapter endpoint (NO authentication) implementing the challenge
 * interview contract over the existing AI interview engine.
 *
 *   POST /api/interview
 *     { sessionId, candidate } → welcome + question plan
 *     { sessionId, message }    → next turn / final report
 */

const express = require('express');
const router = express.Router();

const { interviewChat } = require('../controllers/interviewChat.controller');

router.post('/', interviewChat);

module.exports = router;