import { useChatStore } from './store'

/** Inspection view for the current conversation. Will hold the reasoning graph; empty for now. */
export function InspectView() {
  const session = useChatStore((s) => s.session)

  return (
    <section className="inspect-view">
      {session ? (
        <p className="status-line">Inspecting session {session.id}</p>
      ) : (
        <p className="status-line">No active session.</p>
      )}
    </section>
  )
}
