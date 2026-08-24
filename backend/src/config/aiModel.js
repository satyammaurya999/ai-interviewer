const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const DEFAULT_GROQ_REASONING_FORMAT = process.env.GROQ_REASONING_FORMAT || 'hidden';

const DEPRECATED_GROQ_MODEL_REPLACEMENTS = {
  'llama-3.3-70b-versatile': DEFAULT_GROQ_MODEL,
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
};

const normalizeGroqModel = (model) => (
  DEPRECATED_GROQ_MODEL_REPLACEMENTS[model] || model || DEFAULT_GROQ_MODEL
);

const isGroqReasoningModel = (model) => /^openai\/gpt-oss-/i.test(model || '');

const withGroqReasoningOptions = (options = {}) => {
  const model = normalizeGroqModel(options.model || DEFAULT_GROQ_MODEL);
  const reasoningOptions = isGroqReasoningModel(model) && !options.reasoning_format
    ? { reasoning_format: DEFAULT_GROQ_REASONING_FORMAT }
    : {};

  return {
    ...options,
    model,
    ...reasoningOptions,
  };
};

module.exports = {
  DEFAULT_GROQ_MODEL,
  normalizeGroqModel,
  withGroqReasoningOptions,
};
