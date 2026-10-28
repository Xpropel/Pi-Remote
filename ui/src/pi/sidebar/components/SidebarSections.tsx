import { FolderClosedIcon, FolderOpenIcon } from "./icons"
import type { PiSidebarData, PiSidebarActions } from "../types"
import { SidebarSessionRow } from "./SidebarSessionRow"

/** P11-SIDE-05/06/07/13：朴素行、分区标题、工作区行（文件夹两态）、置顶/工作区/归档组与会话行。 */
export function SidebarSections({
  data,
  actions,
  onHover,
}: {
  data: PiSidebarData
  actions: PiSidebarActions
  onHover?: (sessionKey: string | null) => void
}) {
  const plainRows = [
    { key: "workspace" as const, label: "工作区", icon: <FolderClosedIcon size={15} /> },
  ]
  return (
    <div className="sb-sections">
      <div className="sb-plainrows" data-p11-surface="P11-SIDE-05">
        {plainRows.map((row) => (
          <button key={row.key} type="button" className="sb-plainrow" onClick={() => actions.togglePlainRow?.(row.key)}>
            {row.icon}
            <span>{row.label}</span>
          </button>
        ))}
        <button type="button" className="sb-plainrow" onClick={() => actions.openArchiveView?.()}>
          <span className="sb-archive-glyph" aria-hidden>▣</span>
          <span>归档</span>
        </button>
      </div>
      {data.localPages && data.localPages.length > 0 ? (
        <div className="sb-localpages" data-p11-surface="P11-SIDE-05">
          {data.localPages.map((page) => (
            <button key={page.id} type="button" className="sb-plainrow sb-localpage" data-active={page.active ? "" : undefined} aria-current={page.active ? "page" : undefined} onClick={() => actions.selectLocalPage?.(page.id)}>
              {page.icon ? <span className="sb-localpage-icon" aria-hidden>{page.icon}</span> : null}
              <span>{page.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="sb-grouphead" data-p11-surface="P11-SIDE-06">
        <span>工作区</span>
        <span className="sb-grouphead-tools">
          <span className="sb-grouphead-static" aria-hidden>⌁</span>
          <span className="sb-grouphead-static" aria-hidden>＋</span>
        </span>
      </div>
      {data.groups.map((group) => (
        <div key={group.id} className="sb-groupsection" data-kind={group.kind}>
          <button type="button" className="sb-wsrow" data-p11-surface="P11-SIDE-07" aria-expanded={!group.collapsed} onClick={() => actions.toggleGroup(group.id)}>
            {group.collapsed ? <FolderClosedIcon size={15} /> : <FolderOpenIcon size={15} />}
            <span className="sb-wsname">{group.label}</span>
          </button>
          {group.sessions.length > 0 && !group.collapsed ? (
            <div className="sb-groupsessions">
              {group.sessions.map((session) => (
                <SidebarSessionRow
                  key={session.key}
                  session={session}
                  style={data.style}
                  onOpen={() => actions.selectSession(session.key)}
                  onPin={() => actions.togglePin(session.key)}
                  onArchive={() => actions.toggleArchive(session.key)}
                  onHover={onHover}
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
