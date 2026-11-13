import type { ReactNode } from "react"
import { ArchiveIcon, FolderClosedIcon, FolderOpenIcon, InboxIcon, PinIcon, PlusIcon } from "./icons"
import { PI_SIDEBAR_COPY, type PiSessionTone, type PiSidebarActions, type PiSidebarData, type PiSidebarGroup, type PiSidebarSession } from "../types"
import { SidebarSessionRow } from "./SidebarSessionRow"

const TONE_RANK: Record<PiSessionTone, number> = { idle: 0, running: 1, waiting: 2, error: 3 }
const GROUP_TONE_LABEL: Record<Exclude<PiSessionTone, "idle">, string> = {
  running: "有会话在运行",
  waiting: "有会话在等你",
  error: "有会话出错",
}

/** 折叠的组把组内最需要注意的状态挂在组行右端（出错 > 等你 > 运行），全空闲不挂 */
function groupToneOf(group: PiSidebarGroup): PiSessionTone {
  let tone: PiSessionTone = "idle"
  for (const session of group.sessions) if (TONE_RANK[session.status.tone] > TONE_RANK[tone]) tone = session.status.tone
  return tone
}

/** P11-SIDE-05/06/07/13：导航行（待答 / 归档）、分区标题、工作区行（文件夹两态）、置顶组与会话行。 */
export function SidebarSections({
  data,
  actions,
  onHover,
  archiveView = false,
  inboxActive = false,
  rowMenu,
  menuTargetId,
}: {
  data: PiSidebarData
  actions: PiSidebarActions
  onHover?: (sessionKey: string | null) => void
  /** 归档视图：列表只剩本机归档的会话 */
  archiveView?: boolean
  /** 主区正在显示待答页 */
  inboxActive?: boolean
  rowMenu?: (session: PiSidebarSession) => ReactNode
  menuTargetId?: string
}) {
  const showInbox = typeof data.inboxCount === "number" && !!actions.openInbox
  const inboxCount = data.inboxCount ?? 0
  const renderRow = (session: PiSidebarSession) => (
    <SidebarSessionRow
      key={session.key}
      session={session}
      style={data.style}
      theme={data.theme}
      archiveView={archiveView}
      menu={rowMenu ? () => rowMenu(session) : undefined}
      menuTarget={menuTargetId === session.id}
      onOpen={() => actions.selectSession(session.key)}
      onPin={() => actions.togglePin(session.key)}
      onArchive={() => actions.toggleArchive(session.key)}
      onHover={onHover}
    />
  )
  return (
    <div className="sb-sections">
      <div className="sb-plainrows" data-p11-surface="P11-SIDE-05">
        {showInbox ? (
          <button
            type="button"
            className="sb-plainrow"
            data-active={inboxActive ? "" : undefined}
            aria-current={inboxActive ? "page" : undefined}
            aria-label={inboxCount > 0 ? `待答，${inboxCount} 项待处理` : undefined}
            onClick={() => actions.openInbox?.()}
          >
            <InboxIcon />
            <span className="sb-plainrow-label">待答</span>
            {inboxCount > 0 ? <span className="sb-plainrow-badge" aria-hidden>{inboxCount > 99 ? "99+" : inboxCount}</span> : null}
          </button>
        ) : null}
        {actions.openArchiveView ? (
          <button
            type="button"
            className="sb-plainrow"
            data-active={archiveView ? "" : undefined}
            aria-pressed={archiveView}
            title={PI_SIDEBAR_COPY.archiveTitle}
            onClick={() => actions.openArchiveView?.()}
          >
            <ArchiveIcon />
            <span className="sb-plainrow-label">归档</span>
          </button>
        ) : null}
      </div>
      {data.localPages && data.localPages.length > 0 ? (
        <div className="sb-localpages" data-p11-surface="P11-SIDE-05">
          {data.localPages.map((page) => (
            <button key={page.id} type="button" className="sb-plainrow sb-localpage" data-active={page.active ? "" : undefined} aria-current={page.active ? "page" : undefined} onClick={() => actions.selectLocalPage?.(page.id)}>
              {page.icon ? <span className="sb-localpage-icon" aria-hidden>{page.icon}</span> : null}
              <span className="sb-plainrow-label">{page.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {archiveView || data.devices.length > 0 ? (
        <div className="sb-grouphead" data-p11-surface="P11-SIDE-06">
          <span className="sb-grouphead-label">{archiveView ? "已归档" : "工作区"}</span>
          {archiveView ? (
            <button type="button" className="sb-grouphead-text" onClick={() => actions.openArchiveView?.()}>
              返回
            </button>
          ) : (
            <button type="button" className="sb-grouphead-btn" aria-label={data.newSessionLabel ?? "新会话"} title={data.newSessionLabel ?? "新会话"} onClick={actions.newSession}>
              <PlusIcon size={14} />
            </button>
          )}
        </div>
      ) : null}
      {archiveView && data.groups.length === 0 ? (
        <div className="sb-empty">
          <p className="sb-empty-title">{PI_SIDEBAR_COPY.archiveEmpty}</p>
          <p className="sb-empty-hint">{PI_SIDEBAR_COPY.archiveHint}</p>
        </div>
      ) : null}
      {data.groups.map((group) => {
        if (group.kind === "pinned") {
          return (
            <div key={group.id} className="sb-groupsection" data-kind={group.kind}>
              <div className="sb-wsrow sb-wsrow-static" data-p11-surface="P11-SIDE-13">
                <PinIcon />
                <span className="sb-wsname">{group.label}</span>
              </div>
              <div className="sb-groupsessions">{group.sessions.map(renderRow)}</div>
            </div>
          )
        }
        const tone = group.collapsed ? groupToneOf(group) : "idle"
        const holdsCurrent = group.collapsed && group.sessions.some((session) => session.selected)
        return (
          <div key={group.id} className="sb-groupsection" data-kind={group.kind}>
            <button
              type="button"
              className="sb-wsrow"
              data-p11-surface="P11-SIDE-07"
              data-current={holdsCurrent ? "" : undefined}
              aria-expanded={!group.collapsed}
              title={group.cwd || undefined}
              onClick={() => actions.toggleGroup(group.id)}
            >
              {group.collapsed ? <FolderClosedIcon /> : <FolderOpenIcon />}
              <span className="sb-wsname">{group.label}</span>
              {tone !== "idle" ? <span className="sb-wstone" data-tone={tone} role="img" aria-label={GROUP_TONE_LABEL[tone]} /> : null}
            </button>
            {group.sessions.length > 0 && !group.collapsed ? (
              <div className="sb-groupsessions">
                {group.sessions.map(renderRow)}
                {/* D-3: rows past the per-group cap need a visible way in; without
                    this row the sections silently hid every session past row 5. */}
                {actions.toggleExpanded && group.more != null && group.more > 0 ? (
                  <button type="button" className="sb-groupmore" onClick={() => actions.toggleExpanded?.(group.id)}>
                    更多 {group.more}
                  </button>
                ) : null}
                {actions.toggleExpanded && group.expanded ? (
                  <button type="button" className="sb-groupmore" onClick={() => actions.toggleExpanded?.(group.id)}>
                    收起
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
