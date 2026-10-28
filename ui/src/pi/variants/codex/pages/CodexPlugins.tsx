import { useMemo, useState } from "react"
import { Puzzle, Search } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { CodexBadge, CodexCapabilityBadge, CodexExtensionNotice } from "../primitives/CodexCapability"
import { useCodexCapability } from "../logic/capability"
import { CodexButton } from "../primitives/primitives"

type PluginRow = { id: string; name: string; publisher: string; desc: string; tag: string; installed: boolean; compatible: boolean }

const PLUGIN_ROWS: PluginRow[] = [
  { id: "pi-ext", name: "pi 扩展桥", publisher: "pi-remote", desc: "把本机 pi 的 tool / 命令桥接成可调用能力（文件、终端、任务）。", tag: "核心", installed: true, compatible: true },
  { id: "browser", name: "Browser 工具", publisher: "reference", desc: "预览产物、打开本地服务页面；Pi 默认未提供浏览器能力。", tag: "预览", installed: false, compatible: false },
  { id: "pr", name: "PR 集成", publisher: "reference", desc: "读取仓库 PR / checks，并在会话里合并或关闭。", tag: "Git", installed: false, compatible: false },
  { id: "automations", name: "自动化调度器", publisher: "reference", desc: "按计划触发会话（每日汇总、PR 审查等）；需要常驻调度端。", tag: "任务", installed: false, compatible: false },
  { id: "plugins", name: "插件市场", publisher: "reference", desc: "发现 / 安装 / 卸载插件；需要远端目录能力。", tag: "扩展", installed: false, compatible: false },
]

// TODO(P4 契约 task-18 / mock task-19)：本页数据为临时本地列表，契约合并后改由 @/pi/extensions 的 provider 注入（生产默认禁用）。
/** 插件页（Wave1 全量 surface：Plugins 的完整 UI；Pi 无插件能力 → 默认禁用 + 「可接入」） */
export function CodexPlugins({ p }: { p: VariantAppProps }) {
  const cap = useCodexCapability("plugins")
  const [installed, setInstalled] = useState<Record<string, boolean>>(() => Object.fromEntries(PLUGIN_ROWS.map((row) => [row.id, row.installed])))
  const providerRows: PluginRow[] = (cap.data?.plugins ?? []).map((row) => ({ id: row.id, name: row.name, publisher: `v${row.version}`, desc: row.description ?? "", tag: "扩展", installed: row.installed, compatible: true }))
  const rowsSource = cap.interactive && providerRows.length > 0 ? providerRows : PLUGIN_ROWS
  const [query, setQuery] = useState("")
  const [tab, setTab] = useState<"all" | "installed" | "available">("all")
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rowsSource.filter((row) => (tab === "installed" ? installed[row.id] : tab === "available" ? !installed[row.id] : true)).filter(
      (row) => !q || row.name.toLowerCase().includes(q) || row.desc.toLowerCase().includes(q),
    )
  }, [query, tab, installed, rowsSource])
  const explain = (what: string) => p.relay.notify(`本机 pi 未提供插件能力（${what}）；接入扩展后可用${cap.view ? `（见 ${cap.view.docsPath}）` : ""}`, "warn")
  return (
    <div className="cx-local-page" data-page="plugins" data-pi-ui-part="page" data-p4-surface="CX-PAGE-08" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-local-head">
        <div className="cx-local-title">
          <Puzzle aria-hidden size={16} strokeWidth={1.75} />
          <h1>扩展</h1>
          <CodexCapabilityBadge view={cap.view} />
          {cap.simulated ? <CodexBadge tone="warn">模拟演示</CodexBadge> : null}
        </div>
        <p className="cx-local-sub">发现、安装、管理扩展能力。本机 pi 默认没有扩展目录与安装通道。</p>
        <div className="cx-local-toolbar">
          <label className="cx-panel-filter cx-local-search">
            <Search aria-hidden size={13} strokeWidth={1.5} />
            <input type="search" value={query} placeholder="搜索插件…" aria-label="搜索插件" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="cx-scope-chips" role="tablist" aria-label="插件筛选">
            {(
              [
                ["all", "全部"],
                ["installed", "已安装"],
                ["available", "可安装"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className="cx-scope-chip" data-active={tab === key ? "" : undefined} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
          <CodexButton kind="primary" disabled={!cap.interactive} title={!cap.interactive ? "本机 pi 未提供插件安装能力；接入扩展后可用" : "dev mock：安装到本地演示数据"} data-p4-action="plugin-install" data-capability-state={cap.status} data-pi-capability-disabled={!cap.interactive ? "" : undefined} onClick={() => explain("安装")}>
            安装插件
          </CodexButton>
        </div>
      </header>
      <div className="cx-local-scroll">
        <div className="cx-ext-notice-wrap">
          <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        </div>
        <ul className="cx-plugin-list">
          {rows.map((row) => (
            <li className="cx-plugin" key={row.id} data-installed={installed[row.id] ? "" : undefined}>
              <div className="cx-plugin-head">
                <span className="cx-plugin-name">{row.name}</span>
                <span className="cx-plugin-publisher">{row.publisher}</span>
                <CodexBadge tone={row.installed ? "ok" : "neutral"}>{row.tag}</CodexBadge>
                {!row.compatible ? <CodexCapabilityBadge view={cap.view} /> : null}
                <span className="cx-plugin-state">{installed[row.id] ? "已安装" : "未安装"}</span>
              </div>
              <p className="cx-plugin-desc">{row.desc}</p>
              <div className="cx-plugin-actions">
                <CodexButton
                  kind="outline"
                  disabled={!cap.interactive}
                  title={!cap.interactive ? "本机 pi 未提供插件能力；接入扩展后可用" : "dev mock：安装/停用本地演示数据"}
                  data-p4-action={installed[row.id] ? "plugin-disable" : "plugin-install"}
                  data-capability-state={cap.status}
                  data-pi-capability-disabled={!cap.interactive ? "" : undefined}
                  onClick={() => {
                    if (!cap.interactive) {
                      explain(installed[row.id] ? "停用" : "安装")
                      return
                    }
                    if (cap.actions?.setPluginEnabled && installed[row.id]) cap.actions.setPluginEnabled(row.id, false)
                    else if (cap.actions?.installPlugin) cap.actions.installPlugin(row.id)
                    setInstalled((cur) => ({ ...cur, [row.id]: !cur[row.id] }))
                    p.relay.notify(`${installed[row.id] ? "已停用" : "已安装"}（模拟演示）：${row.name}`)
                  }}
                >
                  {installed[row.id] ? "停用" : "安装"}
                </CodexButton>
              </div>
            </li>
          ))}
          {rows.length === 0 ? <p className="cx-panel-empty-note">没有匹配的插件</p> : null}
        </ul>
      </div>
    </div>
  )
}
