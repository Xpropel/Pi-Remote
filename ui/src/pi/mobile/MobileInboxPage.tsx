import { IconClose } from "./icons"
import { MobileTopBar } from "./MobileTopBar"
import type { PiSidebarStyle, PiSidebarTheme } from "../sidebar/types.ts"

export type MobileInboxKind = "waiting" | "error" | "done"

export interface MobileInboxRow {
  key: string
  title: string
  /** 状态行（前面带工作区名，共享模型 inboxViewOf 拼好） */
  detail: string
  timeLabel: string
  onOpen: () => void
  /** 可原地答的确认（只有 confirm 类、账本标了可答的才给） */
  confirm?: { busy: boolean; allowLabel: string; denyLabel: string; onAllow: () => void; onDeny: () => void }
  /** 出错 / 已完成未读可清除；等你回答的不给（账本也会拒） */
  onDismiss?: () => void
}

export interface MobileInboxGroup {
  kind: MobileInboxKind
  label: string
  rows: MobileInboxRow[]
}

/**
 * 待答推入页（手机版式）：54 顶栏「‹ 待答」+ 按类分组的两行行（同搜索结果行），
 * 行尾清除钮 / 确认行下面一排「拒绝 / 允许」都是 44 触控；宽屏手机布局时随内容列限宽居中。
 */
export function MobileInboxPage({
  style,
  theme,
  groups,
  onBack,
}: {
  style: PiSidebarStyle
  theme: PiSidebarTheme
  groups: MobileInboxGroup[]
  onBack: () => void
}) {
  const total = groups.reduce((count, group) => count + group.rows.length, 0)
  return (
    <div
      className="pi-mobile pm-mobile-shell"
      data-pi-sidebar=""
      data-pi-mobile=""
      data-pi-sidebar-style={style}
      data-pi-theme={theme}
    >
      <div className="pm-list-page pm-inbox-page" data-pi-inbox="">
        <MobileTopBar variant="page" title="待答" subtitle={total > 0 ? `${total} 项` : undefined} onBack={onBack} />
        <div className="pm-inbox-scroll">
          {total === 0 ? (
            <div className="pm-empty">
              <p className="pm-empty-title">没有等你处理的事</p>
              <p className="pm-empty-hint">会话里有提问、出错或完成未读时，会汇总到这里。</p>
            </div>
          ) : (
            groups.map((group) =>
              group.rows.length > 0 ? (
                <section key={group.kind} className="pm-inbox-group" aria-labelledby={`pm-inbox-${group.kind}`}>
                  <h2 id={`pm-inbox-${group.kind}`} className="pm-inbox-head">
                    <span className="pm-inbox-dot" data-kind={group.kind} aria-hidden />
                    {group.label}
                    <span className="pm-inbox-count">{group.rows.length}</span>
                  </h2>
                  {group.rows.map((row) => (
                    <div key={row.key} className="pm-inbox-row">
                      <div className="pm-inbox-line" data-dismissible={row.onDismiss ? "" : undefined}>
                        <button type="button" className="pm-inbox-open" onClick={row.onOpen}>
                          <span className="pm-search-row-main">
                            <span className="pm-search-row-title">{row.title}</span>
                            <span className="pm-search-row-summary">{row.detail}</span>
                          </span>
                          <span className="pm-search-row-time">{row.timeLabel}</span>
                        </button>
                        {row.onDismiss ? (
                          <button type="button" className="pm-icon-btn pm-inbox-dismiss" aria-label={`清除：${row.title}`} title="清除" onClick={row.onDismiss}>
                            <IconClose size={16} />
                          </button>
                        ) : null}
                      </div>
                      {row.confirm ? (
                        <div className="pm-inbox-actions">
                          <button type="button" className="pm-inbox-btn" disabled={row.confirm.busy} onClick={row.confirm.onDeny}>
                            {row.confirm.denyLabel}
                          </button>
                          <button type="button" className="pm-inbox-btn" data-primary="" disabled={row.confirm.busy} onClick={row.confirm.onAllow}>
                            {row.confirm.allowLabel}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null,
            )
          )}
        </div>
      </div>
    </div>
  )
}
