function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} env var is required`)
  }
  return value
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
}
