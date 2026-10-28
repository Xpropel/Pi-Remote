import { ChevronDown } from "../icons/CodexIcons"

/** Codex 标题栏中间的会话标签页（[X-图7①]：12px、8 圆角、当前页 S2 白底 + 下边） */
export function CodexTabStrip({
  title,
  device,
  onNewSession,
  tabs,
}: {
  title: string
  device: string | null
  onNewSession: () => void
  tabs?: {
    enabled: boolean
    title: string
    onAdd: () => void
    list?: readonly { id: string; title: string; active: boolean }[]
    onSelect?: (id: string) => void
    onClose?: (id: string) => void
  }
}) {
  return (
    <div className="cx-titlebar-tabs" role="tablist" aria-label="会话标签页" data-p4-surface="CX-SHELL-05" data-p4-ready="">
      {tabs?.list && tabs.list.length > 0 ? (
        tabs.list.map((tab) => (
          <div className="cx-tab cx-tab-multi" role="tab" aria-selected={tab.active} data-active={tab.active ? "" : undefined} key={tab.id}>
            <button type="button" className="cx-tab-select" data-p4-action="select-tab" onClick={() => tabs.onSelect?.(tab.id)} title={tab.title}>
              <span className="cx-tab-title">{tab.title}</span>
            </button>
            {tabs.onClose ? (
              <button type="button" className="cx-tab-close" data-p4-action="close-tab" aria-label={`关闭 ${tab.title}`} onClick={() => tabs.onClose?.(tab.id)}>
                ×
              </button>
            ) : null}
          </div>
        ))
      ) : (
        <div className="cx-tab" role="tab" aria-selected="true" data-active="">
          <span className="cx-tab-title">{title}</span>
          {device ? <span className="cx-tab-device">{device}</span> : null}
          <ChevronDown aria-hidden size={12} strokeWidth={1.5} className="cx-tab-caret" />
        </div>
      )}
      <button
        type="button"
        className="cx-tab-add"
        onClick={tabs ? tabs.onAdd : onNewSession}
        aria-label={tabs?.title ?? "新建会话标签"}
        title={tabs?.title}
        data-p4-action="new-tab"
        data-pi-capability-disabled={tabs && !tabs.enabled ? "" : undefined}
      >
        +
      </button>
    </div>
  )
}
