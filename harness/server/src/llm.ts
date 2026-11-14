export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Narrow seam between app.ts's routes and whichever model provider is configured. Lets
 * tests inject a fake instead of making real API calls, and lets index.ts pick a provider
 * (Gemini, Claude, ...) without app.ts or sessions.ts knowing it exists. */
export interface LlmClient {
  send(messages: ChatTurn[]): Promise<string>
}
