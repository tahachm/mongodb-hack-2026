import 'dotenv/config'
import { createApp } from './app.js'
import { createClaudeClient } from './claude.js'
import { config } from './config.js'
import { createGeminiClient } from './gemini.js'

const llm =
  config.provider === 'anthropic'
    ? createClaudeClient(config.anthropic.apiKey, config.anthropic.model)
    : createGeminiClient(config.gemini.apiKey, config.gemini.model)

const app = createApp(llm)
const model = config.provider === 'anthropic' ? config.anthropic.model : config.gemini.model

app.listen(config.port, () => {
  console.log(
    `[harness-server] listening on port ${config.port}, provider ${config.provider}, model ${model}`,
  )
})
