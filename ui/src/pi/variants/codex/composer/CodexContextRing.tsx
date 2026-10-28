import type { ContextReadout } from "@/relay/contextUsage"

/** 上下文圆环（[X-§3][X-图11③]：轨道 46px；composer 内用小号 18px 指示，Environment 卡用 46px） */
export function CodexContextRing({ readout, size = 18 }: { readout: ContextReadout; size?: number }) {
  const r = (size - 3) / 2
  const c = 2 * Math.PI * r
  const f = readout.percent == null ? 0 : Math.max(0, Math.min(1, readout.percent))
  return (
    <span
      className="cx-ring"
      data-p4-surface="CX-THREAD-05"
      role="img"
      aria-label={readout.state === "none" ? "还没有上下文占用" : `上下文 ${readout.labelParts.percent ?? readout.label}`}
      title={readout.title}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="cx-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2} />
        <circle
          className="cx-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${c * f} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  )
}
