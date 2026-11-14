import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useState } from 'react'
import { getInspectData, type InspectData } from './api'
import { buildRuns, COLUMNS, type GraphNode, type InspectRun } from './inspectGraph'
import { useChatStore } from './store'

const COLUMN_WIDTH = 270
const NODE_WIDTH = 230
const ROW_HEIGHT = 104
const HEADER_Y = -70

type ReasonNode = Node<{ node: GraphNode }, 'reason'>
type HeaderNode = Node<{ label: string }, 'header'>

function ReasonNodeView({ data, selected }: NodeProps<ReasonNode>) {
  const { node } = data
  return (
    <div className={`rg-node rg-${node.kind}${selected ? ' rg-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {node.image && <img className="rg-image" src={node.image} alt="" loading="lazy" />}
      <div className="rg-text">
        {node.badge && <span className="rg-badge">{node.badge}</span>}
        <div className="rg-title">{node.title}</div>
        {node.subtitle && <div className="rg-subtitle">{node.subtitle}</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

function HeaderNodeView({ data }: NodeProps<HeaderNode>) {
  return <div className="rg-header">{data.label}</div>
}

const nodeTypes = { reason: ReasonNodeView, header: HeaderNodeView }

/** Columns left to right, each stacked and centred against the tallest one; empty columns
 * are dropped so the graph stays compact. */
function layout(run: InspectRun): { nodes: Node[]; edges: Edge[] } {
  const used = [...new Set(run.nodes.map((n) => n.column))].sort((a, b) => a - b)
  const byColumn = used.map((c) => run.nodes.filter((n) => n.column === c))
  const tallest = Math.max(...byColumn.map((col) => col.length))

  const nodes: Node[] = []
  byColumn.forEach((column, x) => {
    const offset = ((tallest - column.length) * ROW_HEIGHT) / 2
    nodes.push({
      id: `header:${used[x]}`,
      type: 'header',
      position: { x: x * COLUMN_WIDTH, y: HEADER_Y },
      data: { label: COLUMNS[used[x]] },
      draggable: false,
      selectable: false,
    })
    column.forEach((node, y) => {
      nodes.push({
        id: node.id,
        type: 'reason',
        position: { x: x * COLUMN_WIDTH, y: offset + y * ROW_HEIGHT },
        data: { node },
        style: { width: NODE_WIDTH },
      })
    })
  })

  const edges: Edge[] = run.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    className: e.faint ? 'rg-edge-faint' : 'rg-edge',
  }))
  return { nodes, edges }
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return '–'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

function formatTokens(n: number | undefined): string {
  return n == null ? '–' : n.toLocaleString()
}

function RunGraph({ run }: { run: InspectRun }) {
  const { nodes, edges } = useMemo(() => layout(run), [run])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = run.nodes.find((n) => n.id === selectedId) ?? null

  return (
    <>
      <div className="inspect-graph-area">
        <div className="inspect-graph">
          <ReactFlow
            key={run.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) => node.type === 'reason' && setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="inspect-panel">
          {selected ? (
            <>
              <div className="inspect-panel-kind">{selected.kind}</div>
              <h3>{selected.title}</h3>
              {selected.image && <img className="inspect-panel-image" src={selected.image} alt="" />}
              <dl>
                {selected.details.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="inspect-hint">Click a node to see the full reasoning behind it.</p>
          )}
        </aside>
      </div>

      <section className="inspect-steps">
        <h3>
          Steps <span>{formatMs(run.totals.durationMs)} in model calls ·{' '}
          {formatTokens(run.totals.inputTokens)} in / {formatTokens(run.totals.outputTokens)} out tokens</span>
        </h3>
        {run.steps.length === 0 ? (
          <p className="inspect-hint">No step timings for this request (they're kept in server memory only).</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Time</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((step, i) => (
                <tr key={i} className={`step-${step.kind}${step.error ? ' step-error' : ''}`}>
                  <td>{step.kind === 'tool' ? `↳ ${step.label}` : step.label}{step.error ? ' (failed)' : ''}</td>
                  <td>{formatMs(step.durationMs)}</td>
                  <td>{formatTokens(step.inputTokens)}</td>
                  <td>{formatTokens(step.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

/** Inspection view: the agent's reasoning for each request in the current conversation, as a
 * graph built from its audit trail (audit_events) and the saved records it cited. */
export function InspectView() {
  const session = useChatStore((s) => s.session)
  const [data, setData] = useState<InspectData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosenRun, setChosenRun] = useState<string | null>(null)

  const sessionId = session?.id
  const messageCount = session?.messages.length ?? 0

  // Refetch whenever the conversation grows, so the graph follows the chat.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    getInspectData(sessionId)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, messageCount])

  const runs = useMemo(
    () => (session && data ? buildRuns(session.messages, data, session.createdAt) : []),
    [session, data],
  )
  const run = runs.find((r) => r.id === chosenRun) ?? runs.at(-1)

  if (!session) return <section className="inspect-view"><p className="status-line">No active session.</p></section>

  return (
    <section className="inspect-view">
      {error && <p className="status-line status-error">Couldn't load the audit trail: {error}</p>}
      {data && !data.available && (
        <p className="status-line">MONGODB_URI isn't set on harness-server, so there's no audit trail to show.</p>
      )}
      {!data && !error && <p className="status-line">Loading the audit trail…</p>}
      {data?.available && runs.length === 0 && (
        <p className="status-line">No reasoning recorded yet. Ask for something in the chat and come back.</p>
      )}

      {runs.length > 0 && run && (
        <>
          <nav className="inspect-runs">
            {runs.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className={r.id === run.id ? 'active' : ''}
                onClick={() => setChosenRun(r.id)}
              >
                <span>{i + 1}</span> {r.label}
              </button>
            ))}
          </nav>
          <RunGraph key={run.id} run={run} />
        </>
      )}
    </section>
  )
}
