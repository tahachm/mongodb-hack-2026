import Markdown from 'react-markdown'

/** Model replies routinely use basic markdown (bold item names, numbered/bulleted price
 * lists) -- render it instead of showing literal `**asterisks**`. No raw HTML, no GFM
 * plugin: the handful of block/inline elements chat replies actually use. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown
      components={{
        // Keep every block a plain <p>/<li>/etc with our own classes -- no default margins
        // fighting the chat bubble's own spacing.
        p: ({ children }) => <p className="md-p">{children}</p>,
        ul: ({ children }) => <ul className="md-list">{children}</ul>,
        ol: ({ children }) => <ol className="md-list">{children}</ol>,
        li: ({ children }) => <li className="md-li">{children}</li>,
        strong: ({ children }) => <strong className="md-strong">{children}</strong>,
        a: ({ children, href }) => (
          <a className="md-link" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </Markdown>
  )
}
