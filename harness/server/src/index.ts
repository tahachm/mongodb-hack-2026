import 'dotenv/config'
import { createApp } from './app.js'
import { createClaudeClient } from './claude.js'
import { config } from './config.js'

const claude = createClaudeClient(config.anthropicApiKey, config.anthropicModel)
const app = createApp(claude)

app.listen(config.port, () => {
  console.log(`[harness-server] listening on port ${config.port}, model ${config.anthropicModel}`)
})
