import { useMemo } from "react"
import { Database, FileText, Puzzle } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { changesViewOf } from "@/pi/model/changesView"
import { useCodexCapability } from "../logic/capability"
import { piBaseName } from "../logic/view"

/**
 * `@` 文件提及 + 插件提及菜单（CX-COMP-08 / [X-§4]）：
 * - @ 文件：候选来自本会话已出现的文件路径（Pi 没有文件索引 API；真实索引能力在 file-preview/editor 扩展，
 *   这里先给真实会话内路径，标注 PARTIAL）；
 * - 扩展/技能提及：`plugins` 能力门控（生产禁用+解释，mock 显示 provider 条目并作为文本 chip 插入）。
 */
export function CodexMentionMenu({
  p,
  query,
  onPickPath,
  onPickPlugin,
}: {
  p: VariantAppProps
  query: string
  onPickPath: (path: string) => void
  onPickPlugin: (name: string) => void
}) {
  const plugins = useCodexCapability("plugins")
  const files = useMemo(() => {
    const view = changesViewOf(p.relay.transcript.items)
    const paths = (view?.files ?? []).map((file) => file.path)
    return [...new Set(paths)].slice(0, 8)
  }, [p.relay.transcript.items])
  const q = query.toLowerCase()
  const fileRows = files.filter((path) => !q || path.toLowerCase().includes(q))
  const pluginRows = (plugins.data?.plugins ?? []).filter((plugin) => !q || plugin.name.toLowerCase().includes(q))
  return (
    <div className="cx-composer-pop cx-composer-pop-mention" role="menu" aria-label="提及" data-p4-surface="CX-COMP-08" data-p4-ready="">
      <div className="cx-slash-group-title">
        <FileText aria-hidden size={11} strokeWidth={1.5} /> 文件（本会话出现过的路径）
      </div>
      {fileRows.length > 0 ? (
        fileRows.map((path) => (
          <button key={path} type="button" role="menuitem" className="cx-pop-row" data-p4-action="mention-file" onClick={() => onPickPath(path)}>
            <span className="cx-pop-row-main">{piBaseName(path)}</span>
            <span className="cx-pop-row-desc">{path}</span>
          </button>
        ))
      ) : (
        <p className="cx-pop-empty">本会话还没有可引用的文件路径</p>
      )}
      <div className="cx-slash-group-title">
        <Puzzle aria-hidden size={11} strokeWidth={1.5} /> 扩展 / 技能
        {!plugins.interactive ? <span className="cx-pop-empty">（需扩展接入）</span> : null}
      </div>
      {plugins.interactive && pluginRows.length > 0 ? (
        pluginRows.map((plugin) => (
          <button key={plugin.id} type="button" role="menuitem" className="cx-pop-row" data-p4-action="mention-plugin" onClick={() => onPickPlugin(plugin.name)}>
            <span className="cx-pop-row-main">{plugin.name}</span>
            <span className="cx-pop-row-desc">{plugin.installed ? "已安装" : "未安装"}</span>
          </button>
        ))
      ) : (
        <button
          type="button"
          className="cx-pop-row"
          data-p4-action="mention-plugin"
          data-pi-capability-disabled=""
          data-capability-state={plugins.status}
          onClick={() => p.relay.notify(`扩展提及：${plugins.view?.reason ?? "扩展未接入"}${plugins.view ? `（见 ${plugins.view.docsPath}）` : ""}`, "warn")}
        >
          <Database aria-hidden size={12} strokeWidth={1.5} />
          <span className="cx-pop-row-main">扩展提及未接入</span>
          <span className="cx-pop-row-desc">接入扩展后可用</span>
        </button>
      )}
    </div>
  )
}
