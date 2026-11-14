export type LlmProvider = 'gemini' | 'anthropic'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} env var is required`)
  }
  return value
}

const provider: LlmProvider = process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'gemini'

export const config = {
  port: Number(process.env.PORT) || 4000,
  provider,
  // Only the active provider's key is required -- picking Gemini shouldn't force you to also
  // set up an Anthropic Console account, and vice versa.
  gemini: {
    apiKey:
      provider === 'gemini' ? requireEnv('GEMINI_API_KEY') : (process.env.GEMINI_API_KEY ?? ''),
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
  },
  anthropic: {
    apiKey:
      provider === 'anthropic'
        ? requireEnv('ANTHROPIC_API_KEY')
        : (process.env.ANTHROPIC_API_KEY ?? ''),
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
  },
}
