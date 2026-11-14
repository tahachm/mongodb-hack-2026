import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // config.ts requires the active provider's API key at module load time; app.ts now
    // imports config.ts (to build the default ACP tool executor), so every test process
    // needs *something* here even though no test ever makes a real Gemini call.
    env: {
      GEMINI_API_KEY: 'test-key',
    },
  },
})
