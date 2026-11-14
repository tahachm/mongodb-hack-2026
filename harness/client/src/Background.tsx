/**
 * Fixed, full-viewport decorative backdrop: a faint dot grid plus a handful of flowing
 * bezier "contour" lines and blurred glow blobs, lime-on-near-black -- the futuristic/techy
 * feel the design asks for, evoking (not copying) MongoDB's leaf-and-gradient brand language.
 * Purely decorative: aria-hidden, no pointer events, sits behind all real content.
 */
export function Background() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop-glow backdrop-glow-a" />
      <div className="backdrop-glow backdrop-glow-b" />
      <svg
        className="backdrop-curves"
        viewBox="0 0 1440 900"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="curveFade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#00ed64" stopOpacity="0" />
            <stop offset="45%" stopColor="#00ed64" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#00ed64" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="curveFadeDim" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#3dd6c4" stopOpacity="0" />
            <stop offset="50%" stopColor="#3dd6c4" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#3dd6c4" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M-100,120 C 400,40 1000,170 1540,70"
          stroke="url(#curveFadeDim)"
          strokeWidth="1.5"
          fill="none"
        />
        <path
          d="M-100,300 C 480,170 960,430 1540,260"
          stroke="url(#curveFade)"
          strokeWidth="2"
          fill="none"
        />
        <path
          d="M-100,560 C 360,460 760,700 1540,540"
          stroke="url(#curveFadeDim)"
          strokeWidth="1.5"
          fill="none"
        />
        <path
          d="M-100,760 C 500,880 940,650 1540,820"
          stroke="url(#curveFade)"
          strokeWidth="2"
          fill="none"
        />
      </svg>
    </div>
  )
}
