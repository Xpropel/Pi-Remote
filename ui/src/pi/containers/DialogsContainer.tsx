import { useMemo, useState } from "react"
import {
  PiCloneDialog,
  PiCompactDialog,
  PiExportDialog,
  PiForkDialog,
  PiHostSettingsDialog,
  PiInspectDialog,
  PiRegenerateDialog,
  PiSessionStateDialog,
  PiSystemPromptDialog,
  PiToolsDialog,
  PiTreeDialog,
  PiUsageDialog,
} from "@/components/pi/composer"
import { FORK_APPEND_HINT, FORK_BACKFILL_COPY, mergeForkDraft } from "@/chat/slashParse"
import { noteSlashCommandUsed } from "@/chat/slashUsage"
import { DEFAULT_TREE_JUMP_MODE, filterTree, flattenTree, treeJumpArgs, type TreeFilterMode, type TreeJumpMode } from "@/chat/treeFlatten"
import {
  bytesLabel,
  exportViewOf,
  fileBaseName,
  forkMessagesOf,
  INSPECT_PAGES,
  jsonTextOf,
  sameToolSet,
  sessionStateRowsOf,
  settingsOf,
  systemPromptChars,
  systemPromptViewOf,
  toolNamesOf,
  toolRowsOf,
  TREE_FILTER_OPTIONS,
  treeDataOf,
  treeJumpNotice,
  usageStatsOf,
} from "@/pi/model/dialogsData"
import { compactionNumbersOf, compactionResultText } from "@/relay/compactionResult"
import { commandErrorText, copyToClipboard, currentSessionTitle, useRelayCommand } from "./cShared"
import { DisplayOptionsOverlay } from "./DisplayOptionsContainer"
import { HostDiagContainer } from "./HostDiagContainer"
import { closePiDialog, PI_UI_IDS, piDialogOf, piLayoutOf, type PiContainerProps, type Relay } from "./types"

/**
 * 弹窗家族（plan §7.3 dialog-usage、P5.5，c 线）：usage / lastCompaction / runCommand / renameSessionFile / exportSessionFile / forkSessionFile；
 * 主机诊断（get_host_diag，按设备读）在 ./HostDiagContainer.tsx（P5 第 2 轮）；
 * compactionResult.ts、treeFlatten.ts、usageLine.ts；各弹窗的取数逻辑照 chat/dialogs.tsx（HEAD 版），解析放在 pi/model/dialogsData.ts。
 * 失败时弹窗内红字、弹窗不关（"压缩失败：pi 正忙"放在按钮行上方，M-04）；导出单次 ≤ 512KB。
 * 打开：piDialogOf(p)?.id 是 PI_UI_IDS 里的弹窗家族 id（arg = 会话 id）。桌面在外壳 overlay 槽，手机在 sheet 槽（PiDialog 390 = 全高 sheet）。
 */

/* ======================= 用量与费用（PI_UI_IDS.usage） ======================= */

function UsageDialogContainer(props: PiContainerProps) {
  const { relay } = props
  const stats = useRelayCommand(relay.runCommand, "get_session_stats", undefined, relay.roomId)
  const view = usageStatsOf(stats.data)
  return (
    <PiUsageDialog
      viewport={piLayoutOf(props.variant)}
      usage={relay.usage ?? {}}
      stats={view}
      subtitle={currentSessionTitle(relay)}
      error={stats.phase === "error" ? `读取失败 · ${stats.error}` : null}
      onRefresh={stats.reload}
      onOpenChange={(next) => {
        if (!next) closePiDialog(props)
      }}
    />
  )
}

/* ======================= 弹窗家族（G03–G18） ======================= */

/** 会话命令能跑：连着、房间在线、已载入 */
function sessionReady(relay: Relay): boolean {
  return relay.authed && relay.browserOnline && relay.online && !!relay.roomId && !(relay.lazySession && relay.lazySession.id === relay.roomId)
}

/** 不能跑时写给用户的原因（按钮置灰旁边一行灰字） */
function sessionBlockedReason(relay: Relay): string | null {
  if (sessionReady(relay)) return null
  if (relay.lazySession && relay.lazySession.id === relay.roomId) return "会话还没载入：先发一条消息载入，再回来操作"
  if (!relay.authed || !relay.browserOnline) return "未连接服务器，连上后再试"
  return "本机未连接，稍后再试"
}

/** 弹窗的 arg 指向的会话：当前会话，或者（会话菜单打开的）别的、还没载入的会话（带文件路径，冷操作用） */
function targetSessionOf(relay: Relay, arg: string | undefined): { current: boolean; path: string | null; title: string | null } {
  if (!arg || arg === relay.roomId) return { current: true, path: null, title: currentSessionTitle(relay) }
  for (const list of Object.values(relay.sessionsByDevice)) {
    const hit = list.find((s) => s.id === arg)
    if (hit) return { current: false, path: hit.path || null, title: hit.name || hit.firstMessage || null }
  }
  return { current: false, path: null, title: null }
}

function useDialogShell(props: PiContainerProps) {
  const open = piDialogOf(props)
  return {
    viewport: piLayoutOf(props.variant),
    target: targetSessionOf(props.relay, open?.arg),
    close: () => closePiDialog(props),
    onOpenChange: (next: boolean) => {
      if (!next) closePiDialog(props)
    },
  }
}

/** 确认类（重新回答 G03 / 克隆 G09）：确认 → 命令 → 回执通知、关弹窗；失败红字、弹窗不关 */
function ConfirmContainer(props: PiContainerProps & { kind: "regenerate" | "clone" }) {
  const { relay, kind } = props
  const shell = useDialogShell(props)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offline = shell.target.current ? sessionBlockedReason(relay) : "只能对当前打开的会话操作：先打开它"
  const confirm = () => {
    if (working) return
    setWorking(true)
    setError(null)
    relay.runCommand(kind).then(
      () => {
        noteSlashCommandUsed(`/${kind}`)
        relay.notify(kind === "regenerate" ? "正在重新回答" : "已复制当前分支，列表里会出现新会话")
        shell.close()
      },
      (err: unknown) => {
        setWorking(false)
        setError(`${kind === "regenerate" ? "重新回答" : "克隆"}失败：${commandErrorText(err)}`)
      },
    )
  }
  const Dialog = kind === "regenerate" ? PiRegenerateDialog : PiCloneDialog
  return (
    <Dialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      busy={relay.busy}
      offline={offline}
      working={working}
      error={error}
      onConfirm={confirm}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 压缩（G04）：可选总结要求 → compact（回包要等压缩落定）→ 写前后 token */
function CompactContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const [instructions, setInstructions] = useState("")
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle")
  const [result, setResult] = useState("")
  const [error, setError] = useState<string | null>(null)
  const offline = shell.target.current ? sessionBlockedReason(relay) : "只能压缩当前打开的会话：先打开它"
  const start = () => {
    if (phase !== "idle") return
    setPhase("working")
    setError(null)
    const custom = instructions.trim()
    relay.runCommand("compact", custom ? { customInstructions: custom } : {}).then(
      (data) => {
        noteSlashCommandUsed("/compact")
        setResult(compactionResultText(compactionNumbersOf(data)))
        setPhase("done")
      },
      (err: unknown) => {
        setPhase("idle")
        setError(`压缩失败：${commandErrorText(err)}`)
      },
    )
  }
  return (
    <PiCompactDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      instructions={instructions}
      onInstructionsChange={setInstructions}
      phase={phase}
      result={result}
      busy={relay.busy && phase === "idle"}
      offline={phase === "idle" ? offline : null}
      error={error}
      onStart={start}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 分叉（G08）：当前会话从用户消息分叉（原文回填输入框）；会话菜单对未载入会话开它时是冷分叉 */
function ForkContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const cold = !shell.target.current && !!shell.target.path
  const list = useRelayCommand(relay.runCommand, !cold && sessionReady(relay) ? "get_fork_messages" : null, undefined, relay.roomId)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pick = (entryId: string) => {
    if (pending) return
    const originRoom = relay.roomId
    const beforeDraft = relay.draft
    setPending(entryId)
    setError(null)
    relay.runCommand("fork", { entryId }).then(
      (data) => {
        noteSlashCommandUsed("/fork")
        const text = data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string" ? String((data as { text: string }).text) : ""
        if (text.trim()) {
          const merged = mergeForkDraft(beforeDraft, text)
          // 命令回包和新房订阅谁先到不一定：交给 relay 在真正进了新房间后回填（和旧界面同一个入口）
          relay.restoreDraftAfterSwitch(originRoom, merged.text, merged.appended ? `${FORK_BACKFILL_COPY}（${FORK_APPEND_HINT}）` : FORK_BACKFILL_COPY)
        } else relay.notify("已从这条消息分叉，列表里会出现新会话")
        shell.close()
      },
      (err: unknown) => {
        setPending(null)
        setError(`分叉失败：${commandErrorText(err)}`)
      },
    )
  }
  const coldFork = () => {
    const path = shell.target.path
    if (!path || pending) return
    setPending("cold")
    setError(null)
    relay.forkSessionFile(path).then(
      (data) => {
        noteSlashCommandUsed("/fork")
        const created = data && typeof data === "object" && typeof (data as { sessionPath?: unknown }).sessionPath === "string" ? String((data as { sessionPath: string }).sessionPath) : ""
        relay.notify(created ? `已分叉成新会话：${fileBaseName(created)}` : "已分叉成新会话")
        shell.close()
      },
      (err: unknown) => {
        setPending(null)
        setError(`分叉失败：${commandErrorText(err)}`)
      },
    )
  }
  const blocked = cold ? null : shell.target.current ? sessionBlockedReason(relay) : "只能在打开的会话里从消息分叉"
  return (
    <PiForkDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      mode={cold ? "cold" : "pick"}
      messages={forkMessagesOf(list.data)}
      phase={blocked ? "error" : list.phase === "idle" ? "loading" : list.phase}
      loadError={blocked ?? list.error}
      onRetry={blocked ? undefined : list.reload}
      pendingId={pending}
      file={shell.target.path ? fileBaseName(shell.target.path) : undefined}
      error={error}
      onPick={pick}
      onColdFork={coldFork}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 会话树（G10）：get_tree → flattenTree → 筛选 / 搜索 → navigate_tree */
function TreeContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const ready = shell.target.current && sessionReady(relay)
  const tree = useRelayCommand(relay.runCommand, ready ? "get_tree" : null, undefined, relay.roomId)
  const [filter, setFilter] = useState<TreeFilterMode>("default")
  const [query, setQuery] = useState("")
  const [jumpMode, setJumpMode] = useState<TreeJumpMode>(DEFAULT_TREE_JUMP_MODE)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nodes = useMemo(() => {
    const { tree: raw, leafId } = treeDataOf(tree.data)
    return tree.phase === "ready" ? flattenTree(raw, leafId) : []
  }, [tree.phase, tree.data])
  const shown = filterTree(nodes, filter, query)
  const jump = (targetId: string) => {
    if (pending) return
    setPending(targetId)
    setError(null)
    relay.runCommand("navigate_tree", treeJumpArgs(jumpMode, targetId)).then(
      (data) => {
        noteSlashCommandUsed("/tree")
        relay.notify(treeJumpNotice(data, jumpMode === "summarize"))
        shell.close()
      },
      (err: unknown) => {
        setPending(null)
        setError(`跳转失败：${commandErrorText(err)}`)
      },
    )
  }
  const blocked = shell.target.current ? sessionBlockedReason(relay) : "只能看当前打开的会话的树：先打开它"
  return (
    <PiTreeDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      nodes={shown}
      treeEmpty={tree.phase === "ready" && nodes.length === 0}
      phase={blocked ? "error" : tree.phase === "idle" ? "loading" : tree.phase}
      loadError={blocked ?? tree.error}
      onRetry={blocked ? undefined : tree.reload}
      jumpMode={jumpMode}
      onJumpModeChange={setJumpMode}
      filter={filter}
      filterOptions={TREE_FILTER_OPTIONS}
      onFilterChange={(value) => setFilter(value as TreeFilterMode)}
      query={query}
      onQueryChange={setQuery}
      pendingId={pending}
      error={error}
      onJump={jump}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 浏览器下载一段文本（延迟回收对象 URL，部分浏览器同步回收会下载失败） */
function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 导出（G12）：当前会话 export_session；未载入会话直接读文件 export_session_file（文本 / JSONL，单次 ≤ 512KB） */
function ExportContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const path = shell.target.path
  const cold = !shell.target.current && !!path
  const [format, setFormat] = useState<"text" | "jsonl">("text")
  const active = useRelayCommand(relay.runCommand, !cold && shell.target.current && sessionReady(relay) ? "export_session" : null, undefined, relay.roomId)
  const exportFile = relay.exportSessionFile
  const coldRun = useMemo(() => (cold && path ? (command: string) => exportFile(path, command === "export_jsonl" ? "jsonl" : "text") : null), [cold, path, exportFile])
  const file = useRelayCommand(coldRun ?? relay.runCommand, coldRun ? (format === "jsonl" ? "export_jsonl" : "export_text") : null, undefined, `${path}|${format}`)
  const res = cold ? file : active
  const view = exportViewOf(res.data)
  const blocked = cold ? null : shell.target.current ? sessionBlockedReason(relay) : "这个会话没有文件路径，导不出来"
  const ext = cold && format === "jsonl" ? "jsonl" : "txt"
  const base = path ? fileBaseName(path).replace(/\.jsonl$/i, "") : "session"
  return (
    <PiExportDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      cold={cold}
      format={format}
      onFormatChange={setFormat}
      text={view.text}
      truncated={view.truncated}
      chars={view.chars}
      sizeNote={cold && view.text ? `${format === "jsonl" ? "完整 JSONL" : "按这个文件的活动分支转换"}，共 ${bytesLabel(view.bytes ?? 0)} / ${view.text.length.toLocaleString("zh-CN")} 字符` : null}
      ext={ext}
      phase={blocked ? "error" : res.phase === "idle" ? "loading" : res.phase}
      loadError={blocked ?? res.error}
      onRetry={blocked ? undefined : res.reload}
      onCopy={() => void copyToClipboard(view.text).then((ok) => relay.notify(ok ? "已复制" : "复制失败，请手动选择文本", ok ? "warn" : "bad"))}
      onDownload={() => downloadText(view.text, `${base}.${ext}`, ext === "jsonl" ? "application/x-ndjson" : "text/plain")}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 只读 JSON 类（本机设置 G14）与键值类（当前状态 G17）、系统提示词（G15）：读一条命令、画出来 */
function HostSettingsContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const blocked = sessionBlockedReason(relay)
  const res = useRelayCommand(relay.runCommand, blocked ? null : "get_settings", undefined, relay.roomId)
  const shown = jsonTextOf(settingsOf(res.data))
  return (
    <PiHostSettingsDialog
      viewport={shell.viewport}
      subtitle={relay.selectedDevice?.name ?? null}
      json={res.phase === "ready" ? shown.text : ""}
      clipped={shown.clipped}
      phase={blocked ? "error" : res.phase === "idle" ? "loading" : res.phase}
      loadError={blocked ?? res.error}
      onRetry={blocked ? undefined : res.reload}
      onOpenChange={shell.onOpenChange}
    />
  )
}

function SystemPromptContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const blocked = sessionBlockedReason(relay)
  const res = useRelayCommand(relay.runCommand, blocked ? null : "get_system_prompt", undefined, relay.roomId)
  const view = systemPromptViewOf(res.data)
  return (
    <PiSystemPromptDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      view={res.phase === "ready" ? view : undefined}
      chars={systemPromptChars(view)}
      phase={blocked ? "error" : res.phase === "idle" ? "loading" : res.phase}
      loadError={blocked ?? res.error}
      onRetry={blocked ? undefined : res.reload}
      onOpenChange={shell.onOpenChange}
    />
  )
}

function SessionStateContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const blocked = sessionBlockedReason(relay)
  const res = useRelayCommand(relay.runCommand, blocked ? null : "get_state", undefined, relay.roomId)
  return (
    <PiSessionStateDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      rows={sessionStateRowsOf(res.data)}
      phase={blocked ? "error" : res.phase === "idle" ? "loading" : res.phase}
      loadError={blocked ?? res.error}
      onRetry={blocked ? undefined : res.reload}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 工具（G16）：get_active_tools + get_all_tools（全表拿不到就只列已启用的）→ 勾选 → set_active_tools */
function ToolsContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const blocked = sessionBlockedReason(relay)
  const active = useRelayCommand(relay.runCommand, blocked ? null : "get_active_tools", undefined, relay.roomId)
  const all = useRelayCommand(relay.runCommand, blocked ? null : "get_all_tools", undefined, relay.roomId)
  const loaded = active.phase === "ready" && all.phase !== "loading"
  const view = useMemo(() => toolRowsOf(active.data, all.phase === "ready" ? all.data : null), [active.data, all.phase, all.data])
  const [picked, setPicked] = useState<string[] | null>(null)
  const selected = picked ?? view.enabled
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (working) return
    setWorking(true)
    setError(null)
    relay.runCommand("set_active_tools", { tools: selected }).then(
      (data) => {
        noteSlashCommandUsed("/tools")
        const tools = toolNamesOf(data)
        const shown = tools.length || (data && typeof data === "object" && Array.isArray((data as { tools?: unknown }).tools)) ? tools : selected
        relay.notify(shown.length ? `已启用：${shown.join("、")}` : "已清空启用的工具")
        shell.close()
      },
      (err: unknown) => {
        setWorking(false)
        setError(`保存失败：${commandErrorText(err)}`)
      },
    )
  }
  return (
    <PiToolsDialog
      viewport={shell.viewport}
      subtitle={shell.target.title}
      rows={view.rows}
      selected={selected}
      fallback={view.fallback}
      phase={blocked ? "error" : !loaded ? (active.phase === "error" ? "error" : "loading") : "ready"}
      loadError={blocked ?? active.error}
      onRetry={blocked ? undefined : () => (active.reload(), all.reload())}
      dirty={!sameToolSet(selected, view.enabled)}
      working={working}
      error={error}
      onToggle={(name) => setPicked(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name])}
      onSave={save}
      onOpenChange={shell.onOpenChange}
    />
  )
}

/** 检视本机信息（G18）：分类页签，每页一条只读命令的 JSON */
function InspectContainer(props: PiContainerProps) {
  const { relay } = props
  const shell = useDialogShell(props)
  const [active, setActive] = useState(INSPECT_PAGES[0]!.id)
  const page = INSPECT_PAGES.find((p) => p.id === active) ?? INSPECT_PAGES[0]!
  const blocked = sessionBlockedReason(relay)
  const res = useRelayCommand(relay.runCommand, blocked ? null : page.command, page.args, `${relay.roomId}|${page.id}`)
  const shown = jsonTextOf(res.data)
  return (
    <PiInspectDialog
      viewport={shell.viewport}
      subtitle={relay.selectedDevice?.name ?? null}
      pages={INSPECT_PAGES}
      active={active}
      onActiveChange={setActive}
      note={page.id === "flags" ? "扩展 flag 只能按名字读取；没点名时这里是空的，未注册的名字是 null。" : null}
      json={res.phase === "ready" ? shown.text : ""}
      clipped={shown.clipped}
      phase={blocked ? "error" : res.phase === "idle" ? "loading" : res.phase}
      loadError={blocked ?? res.error}
      onRetry={blocked ? undefined : res.reload}
      onRefresh={res.reload}
      onOpenChange={shell.onOpenChange}
    />
  )
}

function DialogBody(props: PiContainerProps) {
  const open = piDialogOf(props)
  if (!open) return null
  // key：换了弹窗或作用对象就重置弹窗自己的状态（输入、选中、进行中）
  const key = `${open.id}|${open.arg ?? ""}`
  switch (open.id) {
    case PI_UI_IDS.usage:
      return <UsageDialogContainer key={key} {...props} />
    case PI_UI_IDS.regenerate:
      return <ConfirmContainer key={key} {...props} kind="regenerate" />
    case PI_UI_IDS.clone:
      return <ConfirmContainer key={key} {...props} kind="clone" />
    case PI_UI_IDS.compact:
      return <CompactContainer key={key} {...props} />
    case PI_UI_IDS.fork:
      return <ForkContainer key={key} {...props} />
    case PI_UI_IDS.tree:
      return <TreeContainer key={key} {...props} />
    case PI_UI_IDS.export:
      return <ExportContainer key={key} {...props} />
    case PI_UI_IDS.hostSettings:
      return <HostSettingsContainer key={key} {...props} />
    case PI_UI_IDS.systemPrompt:
      return <SystemPromptContainer key={key} {...props} />
    case PI_UI_IDS.tools:
      return <ToolsContainer key={key} {...props} />
    case PI_UI_IDS.sessionState:
      return <SessionStateContainer key={key} {...props} />
    case PI_UI_IDS.inspect:
      return <InspectContainer key={key} {...props} />
    default:
      return null
  }
}

export function DialogsContainer(props: PiContainerProps) {
  return (
    <>
      <DialogBody {...props} />
      {/* 主机诊断（PI_UI_IDS.hostDiag，arg = 设备 id）：设置页的设备行开它（手机设置页是整页，由 SettingsContainer 自己的 sheet 槽放） */}
      <HostDiagContainer {...props} />
      {/* 静态态桌面的显示选项菜单（只在 #/live 截图时画；可交互时由 a 的 PiSidebar optionsMenu 弹出） */}
      <DisplayOptionsOverlay {...props} />
    </>
  )
}
