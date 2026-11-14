import type { ContentPart, LlmClient, ToolDefinition, Turn } from './llm.js'

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>

const MAX_TOOL_ITERATIONS = 20

function isToolCall(part: ContentPart): part is Extract<ContentPart, { type: 'tool_call' }> {
  return part.type === 'tool_call'
}

/**
 * Drives one user turn to completion: sends the conversation to the model, executes any
 * requested tool calls, feeds the results back, and repeats until the model answers with
 * text instead of a tool call -- or MAX_TOOL_ITERATIONS is hit, so a model that won't stop
 * calling tools can't loop forever against the mock ACP services or burn the free-tier quota.
 *
 * Calls `onTurn` as each turn is produced (assistant turns, including tool calls, and the
 * synthesized tool-result turns) so the caller can persist every step as it happens -- if the
 * model call fails partway through a multi-step run, whatever already completed is still on
 * the record, not lost along with the rest of the turn.
 */
export async function runAgentTurn(
  llm: LlmClient,
  system: string,
  tools: ToolDefinition[],
  history: Turn[],
  executeTool: ToolExecutor,
  onTurn: (turn: Turn) => void,
): Promise<void> {
  let messages = history

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const assistantTurn = await llm.send({ system, messages, tools })
    onTurn(assistantTurn)
    messages = [...messages, assistantTurn]

    const toolCalls = assistantTurn.content.filter(isToolCall)
    if (toolCalls.length === 0) return

    const resultParts: ContentPart[] = await Promise.all(
      toolCalls.map(async (call): Promise<ContentPart> => {
        try {
          const output = await executeTool(call.name, call.input)
          return { type: 'tool_result', id: call.id, name: call.name, output }
        } catch (err) {
          return {
            type: 'tool_result',
            id: call.id,
            name: call.name,
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          }
        }
      }),
    )
    const resultTurn: Turn = { role: 'user', content: resultParts }
    onTurn(resultTurn)
    messages = [...messages, resultTurn]
  }

  onTurn({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "I'm stopping here after too many tool calls in a row without a final answer.",
      },
    ],
  })
}
