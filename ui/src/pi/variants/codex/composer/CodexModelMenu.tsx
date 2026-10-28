import { hiddenUnconfiguredText, type PiModelRow } from "@/pi/model/models"

import { CodexSpinner } from "../primitives/primitives"

/** 模型菜单（[X-图9①]：一列，当前项右侧打勾，12 圆角浮层）；数据走 @/pi/model/models + relay.runCommand */
export function CodexModelMenu({
  rows,
  phase,
  onPick,
  hiddenCount,
}: {
  rows: readonly PiModelRow[]
  phase: string
  onPick: (row: PiModelRow) => void
  hiddenCount: number
}) {
  const visible = rows
  return (
    <div className="cx-composer-pop cx-composer-pop-model" role="menu" aria-label="模型" data-p4-surface="CX-COMP-03" data-p4-ready="">
      <div className="cx-pop-head">模型 · Pi 可用列表</div>
      {phase === "loading" ? (
        <div className="cx-pop-loading">
          <CodexSpinner size={12} /> 正在读取模型…
        </div>
      ) : visible.length === 0 ? (
        <div className="cx-pop-loading">没有可用的模型（pi 未配置或设备离线）</div>
      ) : (
        visible.map((row) => (
          <button key={row.key} type="button" role="menuitemradio" aria-checked={row.current} disabled={row.unconfigured} className="cx-pop-row" data-p4-action="pick-model" onClick={() => onPick(row)}>
            <span className="cx-pop-row-main">{row.name || row.key}</span>
            {row.current ? (
              <span className="cx-pop-check" aria-hidden>
                ✓
              </span>
            ) : null}
            {row.spec ? <span className="cx-pop-row-desc">{row.spec}</span> : null}
          </button>
        ))
      )}
      {hiddenCount > 0 ? <p className="cx-pop-note">{hiddenUnconfiguredText(hiddenCount)}</p> : null}
    </div>
  )
}
