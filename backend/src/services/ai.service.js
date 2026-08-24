const groq = require('../config/groq');
const { DEFAULT_GROQ_MODEL } = require('../config/aiModel');
const { extractContextViaRAG, buildSemanticChunks, createAndStoreEmbeddings, retrieveContextForTopic } = require('./rag.service');
const { optimizeQuery } = require('./optimizer.service');
const SystemPrompt = require('../models/SystemPrompt.model');

const getActivePrompt = async (category, defaultVal) => {
  try {
    const promptDoc = await SystemPrompt.findOne({ category });
    return promptDoc ? promptDoc.content : defaultVal;
  } catch {
    return defaultVal;
  }
};

const formatPrompt = (template, vars) => {
  return template.replace(/\$\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
};

/**
 * Format a normalized candidate profile into an LLM-readable context block.
 * Returns an empty string when no profile is available.
 */
const buildCandidateProfileContext = (profile) => {
  if (!profile) return '';

  const lines = [
    `- Candidate ID: ${profile.candidateId ?? 'N/A'}`,
    `- Job Role: ${profile.jobRole ?? 'N/A'}`,
    `- Years of Experience: ${profile.yearsExperience ?? 0}`,
  ];
  if (profile.education) lines.push(`- Education: ${profile.education}`);

  const missions = Array.isArray(profile.missions) ? profile.missions : [];
  const completedMissions = missions.filter((m) => m.passed && !m.skipped);
  const skippedMissions   = missions.filter((m) => m.skipped);
  const failedMissions    = missions.filter((m) => !m.passed && !m.skipped);

  if (completedMissions.length) {
    lines.push(`- Completed Missions (${completedMissions.length}):`);
    completedMissions.forEach((m) => lines.push(`  - ${m.title} (attempts: ${m.attempts ?? 0})`));
  }
  if (skippedMissions.length) {
    lines.push(`- Skipped Missions (${skippedMissions.length}):`);
    skippedMissions.forEach((m) => lines.push(`  - ${m.title}`));
  }
  if (failedMissions.length) {
    lines.push(`- Unpassed / Failed Missions (${failedMissions.length}):`);
    failedMissions.forEach((m) => lines.push(`  - ${m.title} (attempts: ${m.attempts ?? 0})`));
  }

  const signals = profile.signals;
  if (signals && typeof signals === 'object' && Object.keys(signals).length) {
    lines.push(`- Learning Signals: ${JSON.stringify(signals)}`);
  }

  return lines.join('\n');
};

/**
 * Format the full curriculum into an LLM-readable context block.
 * Preserves the original curriculum data (modules, days, type, tools, objectives).
 * Returns an empty string when no curriculum is available.
 */
const buildCurriculumContext = (curriculum) => {
  if (!curriculum || !Array.isArray(curriculum.days)) return '';

  const lines = [curriculum.cohort ? `Curriculum: ${curriculum.cohort}` : 'Curriculum: 31-day AI cohort'];

  const moduleOfDay = (dayNumber) => {
    const module = (curriculum.modules || []).find((m) =>
      Array.isArray(m.days) &&
      m.days.length >= 2 &&
      dayNumber >= Number(m.days[0]) &&
      dayNumber <= Number(m.days[1])
    );
    return module ? `Module ${module.n}: ${module.title} (days ${module.days[0]}–${module.days[1]})` : null;
  };

  curriculum.days.forEach((day) => {
    const moduleLabel = moduleOfDay(day.day);
    const tools = Array.isArray(day.tools) && day.tools.length ? `Tools: ${day.tools.join(', ')}` : null;
    const objectives = Array.isArray(day.objectives) && day.objectives.length
      ? `Objectives: ${day.objectives.join('; ')}`
      : null;

    const header = moduleLabel ? `${moduleLabel} ─ Day ${day.day}` : `Day ${day.day}`;
    lines.push(`- ${header}: ${day.title}${day.type ? ` (${day.type})` : ''}`);
    if (tools) lines.push(`    ${tools}`);
    if (objectives) lines.push(`    ${objectives}`);
  });

  return lines.join('\n');
};

// ── Interview planning constraints ─────────────────────────────────────────
const MIN_QUESTIONS = 8;
const MIN_CURRICULUM_DAYS = 4;
const MAX_CURRICULUM_DAY = 31;

/**
 * Map the parsed Groq response into the flat interview question array.
 * @param {Object} parsed - Raw JSON from the model
 * @returns {Array} Flattened questions with category + optional curriculumDay
 */
const toInterviewQuestions = (parsed) => {
  const allQuestions = [];

  (Array.isArray(parsed.technical) ? parsed.technical : []).forEach((q) => {
    allQuestions.push({
      questionText: q.questionText || q.question || '',
      category: 'technical',
      difficulty: q.difficulty || 'medium',
      expectedKeywords: Array.isArray(q.expectedKeywords) ? q.expectedKeywords : [],
      curriculumDay: Number(q.curriculumDay) || null,
    });
  });

  (Array.isArray(parsed.behavioral) ? parsed.behavioral : []).forEach((q) => {
    allQuestions.push({
      questionText: q.questionText || q.question || '',
      category: 'behavioral',
      difficulty: q.difficulty || 'medium',
      expectedKeywords: Array.isArray(q.expectedKeywords) ? q.expectedKeywords : [],
      curriculumDay: Number(q.curriculumDay) || null,
    });
  });

  return allQuestions;
};

/**
 * Count distinct valid curriculum day numbers represented in a question set.
 */
const countDistinctCurriculumDays = (questions) => {
  const days = new Set();
  questions.forEach((q) => {
    const day = Number(q.curriculumDay);
    if (Number.isInteger(day) && day >= 1 && day <= MAX_CURRICULUM_DAY) days.add(day);
  });
  return days.size;
};

/**
 * True when the set has at least MIN_QUESTIONS questions spanning at least
 * MIN_CURRICULUM_DAYS distinct curriculum days.
 */
const meetsPlanningConstraints = (questions) =>
  questions.length >= MIN_QUESTIONS &&
  countDistinctCurriculumDays(questions) >= MIN_CURRICULUM_DAYS;

// ── Curriculum-aware feedback helpers ────────────────────────────────────────

const curriculumTitleForDay = (curriculum, day) => {
  const entry = (curriculum?.days || []).find((x) => Number(x.day) === Number(day));
  return entry?.title || `Day ${day}`;
};

/**
 * Per-curriculum-day performance averaged from scored answers, keyed via the
 * planned question' chosen curriculumDay.
 */
const computeCurriculumDayPerformance = (answers, plannedQuestions, curriculum) => {
  const dayById = new Map();
  (plannedQuestions || []).forEach((q, idx) => {
    const day = Number(q.curriculumDay);
    if (Number.isInteger(day) && day >= 1 && day <= 31) {
      dayById.set(q._id?.toString() || `q${idx}`, day);
    }
  });

  const stats = new Map();
  (answers || []).forEach((a) => {
    const day = a.questionId ? dayById.get(a.questionId.toString()) : null;
    if (!Number.isInteger(day) || a.aiScore == null) return;
    const rec = stats.get(day) || { total: 0, count: 0 };
    rec.total += a.aiScore;
    rec.count += 1;
    stats.set(day, rec);
  });

  return [...stats.entries()].map(([day, rec]) => ({
    day,
    title: curriculumTitleForDay(curriculum, day),
    averageScore: Math.round((rec.total / (rec.count * 10)) * 100),
    questionsAnswered: rec.count,
  }));
};

/**
 * Distinct curriculum days covered by the planned question set.
 */
const buildCurriculumPlan = (questions, curriculum) => {
  const days = [...new Set((questions || []).map((q) => Number(q.curriculumDay)))];
  const valid = days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 31)
    .sort((a, b) => a - b);
  if (!valid.length) return 'None assigned yet';
  return valid.map((day) => `- Day ${day} — ${curriculumTitleForDay(curriculum, day)}`).join('\n');
};

/**
 * Generate interview questions using Groq LLM
 * @param {Object} params
 * @param {string} params.jobTitle
 * @param {string} params.jobDescription
 * @param {string} params.experienceLevel
 * @param {string[]} params.questionTypes
 * @param {number} params.numberOfQuestions
 * @param {string|null} params.resumeText
 * @param {Object|null} params.candidateProfile
 * @param {Object|null} params.curriculum
 * @returns {Promise<Array>} Array of question objects
 */
const generateInterviewQuestions = async ({
  jobTitle,
  jobDescription,
  experienceLevel,
  numberOfQuestions = 10,
  resumeText = null,
  candidateProfile = null,
  curriculum = null,
}) => {
  const optimizedContext = await extractContextViaRAG(resumeText, jobDescription);

  // Effective target: at least MIN_QUESTIONS even if numberOfQuestions is lower
  const questionTarget = Math.max(MIN_QUESTIONS, Number(numberOfQuestions) || MIN_QUESTIONS);

  // Distribute questions: ~2/3 technical, ~1/3 behavioral (min 1 each)
  const technicalCount = Math.max(1, Math.round((questionTarget * 2) / 3));
  const behavioralCount = Math.max(1, questionTarget - technicalCount);

const systemPrompt = `You are an expert technical interviewer and HR specialist.
You create precise, challenging, and role-relevant interview questions grounded in the provided context, the official 31-day AI curriculum, and personalized to the candidate's profile.
Personalize the interview based on the candidate's job role, years of experience, mission progress (completed, skipped, and unpassed missions), attempts, and learning signals.
Ground question topics in the actual curriculum days, modules, tools, and objectives provided.
NO HALLUCINATIONS: Do not ask questions about skills, tools, or curriculum content not explicitly present in the provided context, curriculum, or candidate profile.
Always respond with valid JSON only — no extra text, no markdown fences.`;

  const candidateProfileContext = buildCandidateProfileContext(candidateProfile);
  const curriculumContext = buildCurriculumContext(curriculum);

  const userPrompt = `Act as an AI interviewer.

Given the following strictly retrieved chunks of candidate context and role requirements:
---
${optimizedContext}
---
${candidateProfileContext ? `\nCandidate Profile (use this to personalize the interview):\n${candidateProfileContext}` : ''}
${curriculumContext ? `\nOfficial Curriculum (use this to ground question topics in actual curriculum days, tools, and objectives):\n${curriculumContext}` : ''}

Job Title: ${jobTitle}
Experience Level: ${experienceLevel}

Generate:
- ${technicalCount} technical questions
- ${behavioralCount} behavioral questions

Adaptation Rules:
- COVERAGE: The interview MUST contain at least ${MIN_QUESTIONS} questions total and MUST cover at least ${MIN_CURRICULUM_DAYS} DISTINCT curriculum days from the Official Curriculum above.
- CURRICULUM GROUNDING: Anchor technical questions to the curriculum content above (its days, tools, modules, or objectives listed in the Official Curriculum).
- Prefer curriculum days/topics related to the missions the candidate completed.
- For skipped or failed missions, include targeted verification questions on those topics that check whether the candidate learned the underlying concepts.
- AVOID SKIPPED TOPICS: Only fall back to skipped missions if needed to reach the required coverage.
- Do not simply produce unrelated questions — every question must map to a real curriculum day.
- PERSONALIZATION: Personally tailor every question to the candidate's job role, years of experience, completed missions, skipped missions, unpassed/failed missions, attempts count, and learning signals above.
- STRICT GROUNDING: You MUST base every single question ONLY on the provided retrieved chunks, the candidate profile, and the official curriculum above.
- If a technology, topic, or experience is not mentioned in the context, candidate profile, or curriculum, DO NOT generate a question about it.
- Questions must match candidate skill level (${experienceLevel}).
- Avoid generic questions.
- Behavioral questions should use STAR method format.
- Technical questions should test real-world problem solving.
- Include 3-5 expected keywords for each question.

Return structured JSON exactly in this format:
{
  "technical": [
    {
      "questionText": "...",
      "difficulty": "easy|medium|hard",
      "expectedKeywords": ["keyword1", "keyword2"],
      "curriculumDay": <integer 1-31: the curriculum day this question anchors to>
    }
  ],
  "behavioral": [
    {
      "questionText": "...",
      "difficulty": "easy|medium|hard",
      "expectedKeywords": ["keyword1", "keyword2"],
      "curriculumDay": <integer 1-31: the curriculum day this question anchors to>
    }
  ]
}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('No response from AI model.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI returned invalid JSON. Please try again.');
  }

  let allQuestions = toInterviewQuestions(parsed);

  if (!allQuestions.length) {
    throw new Error('AI returned no valid questions. Please try again.');
  }

  // Enforce planning constraints. If the first response falls short, make a
  // single bounded corrective attempt before falling back gracefully.
  if (!meetsPlanningConstraints(allQuestions)) {
    const rejectNote = `Your previous response contained ${allQuestions.length} questions covering ${countDistinctCurriculumDays(allQuestions)} distinct curriculum days, but the interview MUST contain at least ${MIN_QUESTIONS} questions covering at least ${MIN_CURRICULUM_DAYS} distinct curriculum days.\n
Re-generate the FULL final interview set (correcting this) in the exact same JSON format.`;
    const rejectionPrompt = `${rejectNote}\n\n${userPrompt}`;

    try {
      const retry = await groq.chat.completions.create({
        model: DEFAULT_GROQ_MODEL,
        messages: [
          { content: systemPrompt, role: 'system' },
          { content: rejectionPrompt, role: 'user' },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });

      const retryContent = retry.choices[0]?.message?.content;
      if (retryContent) {
        const reparsed = JSON.parse(retryContent);
        const retryQuestions = toInterviewQuestions(reparsed);
        if (retryQuestions.length) allQuestions = retryQuestions;
      }
    } catch (err) {
      console.warn('[ai.service] Planning-constraint retry failed, falling back:', err.message);
    }
  }

  // Slice to the effective target but never below the planning minimum.
  const keep = Math.max(MIN_QUESTIONS, Math.min(questionTarget, allQuestions.length));
  const trimmed = allQuestions
    .filter((q) => q.questionText)
    .slice(0, keep)
    .map((q, i) => ({ ...q, order: i + 1 }));

  return trimmed;
};

/**
 * Evaluate a candidate's answer using Groq
 */
const evaluateAnswer = async ({ questionText, answerText, expectedKeywords, jobTitle }) => {
  const defaultPrompt = `Act as an interviewer evaluating a candidate's response.

Job Title: \${jobTitle}
Question: \${questionText}
Expected Keywords Context: \${expectedKeywordsText}
Candidate's Answer: \${answerText}

Evaluate the candidate's answer strictly based on:
1. Correctness
2. Clarity
3. Depth

Return valid JSON exactly in this format:
{
  "score": <number 1-10>,
  "feedback": "<constructive feedback string explaining the evaluation based on correctness, clarity, and depth>"
}`;

  const rawTemplate = await getActivePrompt('ats_scorer', defaultPrompt);
  const prompt      = formatPrompt(rawTemplate, {
    jobTitle,
    questionText,
    expectedKeywordsText: expectedKeywords.join(', '),
    answerText: answerText || '(No answer provided)',
  });

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 512,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  return JSON.parse(content || '{}');
};

/**
 * Generate the final structured interview feedback report.
 * Based on the complete interview: candidate profile, curriculum plan,
 * per-question scores, answers, and the adaptive follow-up conversation.
 */
const generateOverallFeedback = async ({
  jobTitle,
  experienceLevel,
  answers,
  liveHistory = [],
  plannedQuestions = [],
  candidateProfile = null,
  curriculum = null,
}) => {
  const summary = (answers || [])
    .map((a, i) => {
      const planned = (plannedQuestions || []).find(
        (q) => q._id?.toString() === a.questionId?.toString()
      ) || null;
      const dayNote = planned?.curriculumDay ? ` [Curriculum Day ${planned.curriculumDay}]` : '';
      return `Q${i + 1}: ${a.questionText}${dayNote}\nCategory: ${planned?.category || 'N/A'}\nScore: ${a.aiScore}/10${a.skipped ? ' [SKIPPED]' : ''}\nAnswer: ${a.answerText?.slice(0, 300) || '(No answer)'}`;
    })
    .join('\n\n');

  const profileBrief = buildCandidateProfileContext(candidateProfile);
  const curriculumPlan = buildCurriculumPlan(plannedQuestions, curriculum);
  const dayPerformance = computeCurriculumDayPerformance(answers, plannedQuestions, curriculum)
    .map((p) => `- Day ${p.day} — ${p.title}: avg ${p.averageScore}% over ${p.questionsAnswered} question(s)`)
    .join('\n');

  const followUpSummary = (liveHistory || [])
    .slice(-40)
    .map((e) => `${e.role === 'assistant' ? 'AI follow-up' : 'Candidate'}: ${e.content}`)
    .join('\n');

  const defaultPrompt = `You are a senior interviewer producing the final structured feedback for an AI Cohort interview.
Base the ENTIRE report strictly on the supplied evidence — candidate profile, curriculum, planned questions, per-question scores, answers, and the adaptive follow-up conversation.
Be specific, decisive, and grounded in the provided curriculum topics. Do not invent topics that are not present.

Job Title: \${jobTitle}
Experience Level: \${experienceLevelText}

Candidate Profile:
\${profileBrief}

Curriculum Coverage Planned:
\${curriculumPlan}

Curriculum-Day Performance:
\${dayPerformance}

Interview Summary (planned questions, scores, answers):
\${summary}

Adaptive Follow-Up Conversation (live):
\${followUpSummary}

Return valid JSON exactly in this format:
{
  "overallScore": <number 1-100>,
  "overallAssessment": "<2-4 sentence overall assessment of the candidate across the whole interview>",
  "strengths": ["<specific strength tied to a question/curriculum topic>", "<more>"],
  "weaknesses": ["<specific weakness tied to a question/curriculum topic>", "<more>"],
  "improvementTips": ["<short practical tip>", "<more>"],
  "curriculumDaysAssessed": ["<Day N: topic title that was actually assessed>", "<more>"],
  "demonstratedStrongTopics": ["<topic name plus its curriculum day where the candidate showed strength>", "<more>"],
  "needsImprovementTopics": ["<topic name plus its curriculum day needing work>", "<more>"],
  "technicalReasoning": "<2-3 sentences on the quality of technical reasoning and problem-solving across the conversation>",
  "actionableRecommendations": ["<concrete, curriculum-ANCHORED next action with expected outcome>", "<more>"]
}`;

  const rawTemplate = await getActivePrompt('feedback_report', defaultPrompt);
  const prompt = formatPrompt(rawTemplate, {
    jobTitle,
    profileBrief,
    experienceLevelText: experienceLevel || 'N/A',
    curriculumPlan,
    dayPerformance,
    summary: summary || 'No answered questions recorded.',
    followUpSummary: followUpSummary || 'No live follow-up exchanges recorded.',
  });

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  return JSON.parse(content || '{}');
};

/**
 * Parse Resume & Job Description into structured JSON
 * @param {string} resumeText - Raw extracted resume text
 * @param {string} jdText     - Job description text
 * @returns {Promise<Object>} Structured { resume, jobDescription } object
 */
const parseResumeAndJD = async (resumeText, jdText) => {
  const defaultPrompt = `You are an expert resume and job description parser.

Extract structured data in strict JSON format.

From Resume:
- name
- skills (array)
- experience (array of objects: role, company, duration, tech)
- projects (array: title, tech stack, description)
- education

From Job Description:
- role
- required_skills (array)
- preferred_skills (array)
- responsibilities (array)

Rules:
- Do not hallucinate
- If missing, return empty array or null
- Keep output strictly JSON`;

  const systemPrompt = await getActivePrompt('resume_parser', defaultPrompt);

  const userPrompt = `Input:
RESUME:
${resumeText || 'Not provided'}

JOB_DESCRIPTION:
${jdText || 'Not provided'}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('No response from AI parser.');

  try {
    return JSON.parse(content);
  } catch {
    throw new Error('AI parser returned invalid JSON.');
  }
};

/**
 * Generate specialized technical questions using RAG context
 * @param {Object} params
 * @param {string} params.retrievedChunks - Raw context from RAG
 * @param {Object} params.parsedResumeData - Structured resume JSON
 * @param {Object} params.parsedJdData - Structured job description JSON
 * @returns {Promise<string>} Numbered list of questions
 */
const generateSeniorTechnicalQuestions = async ({
  retrievedChunks,
  parsedResumeData,
  parsedJdData,
}) => {
  const systemPrompt = `You are a senior technical interviewer.

Generate interview questions using ONLY the provided context.

Rules:
- Do NOT use outside knowledge
- Questions must map directly to skills/projects in context
- Avoid generic questions
- Cover:
  - Core skills
  - Project-based questions
  - Problem-solving
- Difficulty: mixed (easy → hard)
- Max 5 questions`;

  const userPrompt = `Context:
${retrievedChunks}

Candidate Profile:
${JSON.stringify(parsedResumeData, null, 2)}

Job Requirements:
${JSON.stringify(parsedJdData, null, 2)}

Output:
Numbered list of questions.`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.6,
    max_tokens: 1024,
  });

  return response.choices[0]?.message?.content?.trim() || 'Failed to generate questions.';
};

/**
 * Strict technical evaluation of a candidate's answer using RAG context
 * @param {Object} params
 * @param {string} params.retrievedChunks - Raw context from RAG
 * @param {string} params.question - The question being answered
 * @param {string} params.answer - The candidate's answer
 * @returns {Promise<Object>} Evaluation JSON
 */
const evaluateStrictAnswer = async ({ retrievedChunks, question, answer }) => {
  const systemPrompt = `You are a strict technical interviewer.

Evaluate the candidate's answer using ONLY the given context.

Rules:
- Be strict, not generous
- Tie feedback directly to expected concepts in context
- No generic statements
- Penalize vague answers
- Always return valid JSON`;

  const userPrompt = `Context:
${retrievedChunks}

Question:
${question}

Candidate Answer:
${answer}

Return JSON exactly as:
{
  "score": (0-10),
  "correctness": "low | medium | high",
  "strengths": [],
  "weaknesses": [],
  "missed_concepts": [],
  "improvement_suggestions": []
}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  try {
    return JSON.parse(content || '{}');
  } catch {
    throw new Error('AI evaluation returned invalid JSON.');
  }
};

/**
 * Generate a follow-up question based on the previous interaction
 * @param {Object} params
 * @param {string} params.retrievedChunks - Raw context from RAG
 * @param {string} params.question - The question previously asked
 * @param {string} params.answer - The candidate's answer
 * @returns {Promise<string>} Single follow-up question
 */
const generateFollowUpQuestion = async ({ retrievedChunks, question, answer }) => {
  const systemPrompt = `You are a technical interviewer.

Generate a follow-up question based on the previous interaction.

Rules:
- Focus on weak areas or gaps
- Increase depth of evaluation
- Do NOT repeat the same concept
- Keep it precise`;

  const userPrompt = `Context:
${retrievedChunks}

Previous Question:
${question}

Candidate Answer:
${answer}

Output:
Single follow-up question.`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens: 512,
  });

  return response.choices[0]?.message?.content?.trim() || 'No follow-up generated.';
};

/**
 * Generate a comprehensive final evaluation report
 * @param {Array} allEvaluations - Array of individual answer evaluations
 * @returns {Promise<Object>} Structured report JSON
 */
const generateFinalEvaluationReport = async (allEvaluations) => {
  const systemPrompt = `You are a senior interviewer.

Generate a final evaluation report based on the provided session data.

Rules:
- Be decisive
- No vague feedback
- Base everything on evaluation data
- Always return valid JSON`;

  const userPrompt = `Evaluation Data:
${JSON.stringify(allEvaluations, null, 2)}

Return JSON exactly as:
{
  "overall_score": (0-10),
  "skill_breakdown": [
    { "skill": "", "score": 0-10 }
  ],
  "key_strengths": [],
  "key_weaknesses": [],
  "hire_decision": "yes | no | borderline",
  "improvement_plan": [
    "step 1",
    "step 2"
  ]
}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  try {
    return JSON.parse(content || '{}');
  } catch {
    throw new Error('AI report generator returned invalid JSON.');
  }
};

/**
 * Validate whether a model response is grounded in the provided context
 * @param {Object} params
 * @param {string} params.retrievedChunks - Context used for grounding
 * @param {string} params.modelOutput - Output to be validated
 * @returns {Promise<Object>} Grounding validation result
 */
const validateGrounding = async ({ retrievedChunks, modelOutput }) => {
  const systemPrompt = `You are a validation system.

Check whether the response is fully supported by the context.

Return JSON exactly as:
{
  "grounded": true|false,
  "unsupported_claims": [],
  "reason": ""
}`;

  const userPrompt = `Context:
${retrievedChunks}

Response:
${modelOutput}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  try {
    return JSON.parse(content || '{}');
  } catch {
    throw new Error('AI validator returned invalid JSON.');
  }
};

/**
 * ── 6-STEP ORCHESTRATOR ──
 * Topic-based Dynamic Question Generator
 *
 * 1. Query Rewrite  (topic name -> technical goal string)
 * 2. Embed & Retrieve (Pinecone-like search on internal vectorStore)
 * 3. Retrieve top 5
 * 4. Format context
 * 5. Pass into Senior Technical Question Generator
 * 6. Generate questions
 */
const generateTopicQuestions = async ({ resumeText, jobDescription, topic, parsedResumeData, parsedJdData }) => {
  // Step 1: Prepare Vector Store
  const chunks      = buildSemanticChunks(resumeText, jobDescription);
  const vectorStore = await createAndStoreEmbeddings(chunks);

  // Step 2, 3 & 4: Retrieval & Format Context
  const context = await retrieveContextForTopic(vectorStore, topic);

  // Step 5 & 6: Generation (using our existing grounded generator logic)
  return generateSeniorTechnicalQuestions({
    retrievedChunks: context,
    parsedResumeData,
    parsedJdData,
  });
};

const generateQuestionsDirect = async (jobTitle, jobDescription) => {
  if (!jobTitle || !jobDescription) {
    throw new Error('Job title and job description are required.');
  }

  const systemPrompt = `You are a professional AI Technical Recruiter.
Generate 5 targeted, highly role-relevant interview questions (3 technical, 2 behavioral) based specifically on the provided Job Title and Job Description.
Always respond with a valid JSON object containing a "questions" key pointing to an array of question strings. Format:
{
  "questions": [
    "Question 1...",
    "Question 2...",
    "Question 3...",
    "Question 4...",
    "Question 5..."
  ]
}`;

  const userPrompt = `Job Title: ${jobTitle}
Job Description:
${jobDescription}`;

  const response = await groq.chat.completions.create({
    model: DEFAULT_GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Failed to generate questions.');

  try {
    const parsed = JSON.parse(content);
    return parsed.questions || [];
  } catch (err) {
    logger.error('Failed to parse direct questions JSON from Groq:', err);
    throw new Error('Failed to parse questions response.');
  }
};

module.exports = {
  generateInterviewQuestions,
  evaluateAnswer,
  generateOverallFeedback,
  parseResumeAndJD,
  optimizeQuery,
  generateSeniorTechnicalQuestions,
  evaluateStrictAnswer,
  generateFollowUpQuestion,
  generateFinalEvaluationReport,
  validateGrounding,
  generateTopicQuestions,
  generateQuestionsDirect,
};







