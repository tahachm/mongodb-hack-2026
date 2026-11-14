/** Abstract curved mark -- two overlapping arcs forming a leaf-like silhouette, in the
 * lime accent. Original shape, not MongoDB's actual logo; just the same visual family
 * (organic curves, leaf-adjacent) the rest of the UI borrows from. */
export function Logo() {
  return (
    <svg
      className="logo-mark"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 22 C 4 10, 14 3, 24 4 C 23 14, 15 23, 4 22 Z"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M6 21 C 9 14, 15 8, 23 5"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
        opacity="0.6"
      />
    </svg>
  )
}
