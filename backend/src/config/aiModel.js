const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const DEPRECATED_GROQ_MODEL_REPLACEMENTS = {
  'llama-3.3-70b-versatile': DEFAULT_GROQ_MODEL,
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
};

const normalizeGroqModel = (model) => (
  DEPRECATED_GROQ_MODEL_REPLACEMENTS[model] || model || DEFAULT_GROQ_MODEL
);

module.exports = {
  DEFAULT_GROQ_MODEL,
  normalizeGroqModel,
};
