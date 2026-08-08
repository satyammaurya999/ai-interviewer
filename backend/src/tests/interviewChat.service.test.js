/**
 * interviewChat.service.test.js
 *
 * Verifies the sessionId-keyed interview adapter state machine without
 * hitting the network: the AI service and curriculum are mocked.
 */

const { handleInterviewRequest } = require('../services/interviewChat.service');

jest.mock('../services/ai.service', () => ({
  generateInterviewQuestions: jest.fn(async ({ numberOfQuestions }) =>
    Array.from({ length: numberOfQuestions }, (_, i) => ({
      _id: `q${i + 1}`,
      questionText: `Question ${i + 1}?`,
      category: i % 2 === 0 ? 'technical' : 'behavioral',
      expectedKeywords: ['kw'],
      curriculumDay: (i % 5) + 1,
      order: i + 1,
    }))
  ),
  evaluateAnswer: jest.fn(async () => ({ score: 8, feedback: 'Solid.' })),
  generateOverallFeedback: jest.fn(async () => ({
    overallAssessment: 'Strong overall performance.',
    strengths: ['Deep curriculum coverage'],
    weaknesses: ['Missed a few edge cases'],
    improvementTips: ['Practice vector retrieval'],
  })),
}));

jest.mock('../services/curriculum.service', () => ({
  loadCurriculum: jest.fn(() => ({
    cohort: 'AI Cohort · 31 days · 8 modules',
    modules: [{ n: 1, title: 'Mock Module', days: [1, 31] }],
    days: [{ day: 1, title: 'Day One', type: 'LEARN', tools: [], objectives: [] }],
  })),
}));

describe('POST /api/interview adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const candidate = {
    member: { id: 'CAND-001', name: 'Sarah', jobRole: 'AI Engineer', yearsExperience: 5 },
    missions: [{ title: 'Embeddings', passed: true }],
  };

  test('creates a session with a welcome reply', async () => {
    const res = await handleInterviewRequest({ sessionId: 'abc-123', candidate });
    expect(res).toEqual({ reply: "Welcome. Let's begin your interview.", done: false });
  });

  test('asks the first question after the welcome', async () => {
    await handleInterviewRequest({ sessionId: 'abc-123', candidate });
    const res = await handleInterviewRequest({ sessionId: 'abc-123', message: "I'm ready." });
    expect(res.done).toBe(false);
    expect(res.reply).toBe('Question 1?');
  });

  test('walks through every question then completes with feedback', async () => {
    await handleInterviewRequest({ sessionId: 'abc-123', candidate });
    const total = 8; // QUESTIONS_PER_INTERVIEW
    let res;
    for (let i = 0; i <= total; i += 1) {
      res = await handleInterviewRequest({ sessionId: 'abc-123', message: `Answer ${i + 1}` });
    }
    expect(res.reply).toBe('Interview completed.');
    expect(res.done).toBe(true);
    expect(res.feedback).toEqual(
      expect.objectContaining({
        summary: 'Strong overall performance.',
        strengths: expect.any(Array),
        gaps: expect.any(Array),
        next: expect.any(Array),
      })
    );
    expect(res.feedback.strengths).toEqual(['Deep curriculum coverage']);
  });

  test('replays the completed report on later turns', async () => {
    await handleInterviewRequest({ sessionId: 'abc-123', candidate });
    for (let i = 0; i <= 8; i += 1) {
      await handleInterviewRequest({ sessionId: 'abc-123', message: `A ${i}` });
    }
    const res = await handleInterviewRequest({ sessionId: 'abc-123', message: 'Anything else?' });
    expect(res.done).toBe(true);
    expect(res.reply).toBe('Interview completed.');
  });

  test('rejects an unknown session', async () => {
    await expect(
      handleInterviewRequest({ sessionId: 'nope', message: 'hi' })
    ).rejects.toThrow('not found');
  });

  test('rejects a request with no sessionId', async () => {
    await expect(handleInterviewRequest({ message: 'hi' })).rejects.toThrow('sessionId');
  });
});