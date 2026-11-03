/** Models the operator can pick in the chat settings. Shared by the client (dropdown) and the
 *  server (allowlist for the x-llm-model header, so the header cannot select an arbitrary model).
 *  All ids were checked against OpenRouter's /models on 2026-10-10. `reasoning` is what gets
 *  sent to turn thinking down; undefined means the parameter is not sent at all. */
export interface LlmModelOption {
  id: string;
  label: string;
  note: string;
  provider: 'openrouter' | 'nvidia';
  reasoning?: Record<string, unknown>;
}

export const LLM_MODELS: LlmModelOption[] = [
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'default, fast + good', provider: 'openrouter', reasoning: { enabled: false } },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', note: 'fastest, lighter', provider: 'openrouter', reasoning: { enabled: false } },
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'newer, small', provider: 'openrouter', reasoning: { enabled: false } },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', note: 'smarter, slower', provider: 'openrouter', reasoning: { enabled: false } },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'open weights, reasoning low', provider: 'openrouter', reasoning: { effort: 'low' } },
  { id: 'openai/gpt-4.1-nano', label: 'GPT-4.1 Nano', note: 'tiny, no reasoning', provider: 'openrouter' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', note: 'smart, reasoning', provider: 'openrouter', reasoning: { effort: 'minimal' } },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: 'cheap, large', provider: 'openrouter' },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen 3.8 Flash', note: '1M context', provider: 'openrouter' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', note: '', provider: 'openrouter' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', note: 'best writing, pricier', provider: 'openrouter' },
  { id: 'nvidia:nemotron', label: 'NVIDIA Nemotron (NIM)', note: 'free tier, slower', provider: 'nvidia' },
];

export const DEFAULT_LLM_MODEL = 'google/gemini-2.5-flash';
