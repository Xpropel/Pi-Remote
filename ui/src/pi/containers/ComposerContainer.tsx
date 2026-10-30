import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ModelExplainerCard } from "@/components/kit/menu/ModelExplainerCard"
import {
  PiAttachMenu,
  PiComposerDock,
  PiDeliveryOptions,
  PiMenuCloseContext,
  PiMentionMenu,
  PiModelMenu,
  PiQueueEditFooter,
  PiQueuePanel,
  PiSlashMenu,
  type CHostMessage,
  type CImage,
  type PiAttachPick,
  type PiTrayItem,
  type SlashGroup,
  type SlashRow,
} from "@/components/pi/composer"
import { PiSheet } from "@/components/pi/shared"
import { usePiStatic } from "@/components/pi/shared/layers"
import { C_EXPLAINER_ORANGE } from "@/components/pi/composer/styles"
import { collectTranscriptFiles, mentionLabel, mergeMentionCandidates, viewedMentionFiles } from "@/chat/composer/mention"
import { decodeTextFile, insertFileBlock, TEXT_FILE_MAX_BYTES } from "@/chat/composerTools"
import { matchExactModel, matchResourceCommand, matchThinkingLevel, parseResourceCommands, parseSlashDetailed, resourceCommandText, resourceExecArgs, withoutSlash, type ResourceCommand } from "@/chat/slashParse"
import { frequentSlashNames, loadSlashUsage, noteSlashCommandUsed, SLASH_USAGE_EVENT, SLASH_USAGE_MAX_ENTRIES, SLASH_USAGE_STORAGE_KEY } from "@/chat/slashUsage"
import { useNow } from "@/pi/hooks/useNow"
import { useTranscriptStick } from "@/pi/hooks/useTranscriptStick"
import { changesOfSessionCached, createChangesCache } from "@/components/pi/composer/sessionChanges"
import { queueEditInvalidationOf, sharedSendNowLock } from "@/components/pi/composer/queueGuard"
import { composerTriggerOf, slashMenuGroups } from "@/pi/model/composerInput"
import { composerViewOf, PI_SLOW_ACK_MS } from "@/pi/model/composerView"
import { modelContextWindowOf, modelExplainerOf } from "@/pi/model/models"
import { PROMPT_RECALL_IDLE, promptHistoryKey, promptRecallAfterDraft, promptRecallStep, type PromptRecall, type PromptRecallKey } from "@/pi/model/promptRecall"
import { SLASH_BUILTINS_COPY } from "@/pi/model/slashBuiltins"
import { slashBrowseGroupsOf, slashBuiltinRows, slashResourceOf } from "@/pi/model/slashMenu"
import { queueSectionsOf, trayItemsOf, type PiQueueSection } from "@/pi/model/tray"
import { contextReadout } from "@/relay/contextUsage"
import { errorCode } from "@/relay/devices"
import { clearDraftImages, onDraftPersistFailure, readDraftImages, saveDraftImages } from "@/relay/drafts"
import { pageLinkView } from "@/relay/presence"
import { canMutateRemoteQueueItem } from "@/relay/remoteQueue"
import type { ScheduleCreateInput } from "@/relay/schedule"
import { ApprovalContainer } from "./ApprovalContainer"
import { importImageFiles } from "./cImages"
import {
  C_IDS,
  commandErrorText,
  commandsReady,
  copyToClipboard,
  modelPillOf,
  sessionLoaded,
  useLegacyStyle,
  useModelActions,
  useModelData,
  useRelayCommand,
} from "./cShared"
import { TaskPanelContainer } from "./TaskPanelContainer"
import { openPiDialog, PI_UI_IDS, type PiContainerProps, type PiSessionExtras, type Relay } from "./types"

/**
 * composer（plan §7.3 composer-keyboard / slash-menu / mention-menu / attach-menu / model-menu / queue-panel、P5.5，c 线）。
 * 数据：draft / setDraft、composer（deriveComposer 经 useComposerUi，不改）、pendingImages / pendingFiles、sendText、abort、model / thinkingLevel…
 * - 黑圆钮、只读、菜单开关：PiComposerDock 内部按 composerBlockOf(state, ui.blockedBy) 算；占位与原因：composerReasonOf（经 model/composerView.ts，D14）。
 * - tray：trayItemsOf({ …, outbox: relay.outbox, linkOk, deviceOnline })；排队面板 queueSectionsOf(remoteQueue, localQueue, relay.outbox, linkOk, deviceOnline)。
 * - status.extra = extStatus.statuses（最多 2 段、每段 24 字，状态行截）；status.context 只在 trusted 且 ≥ 70% 时出预警环（状态行判断）。
 * 跨线（R2/p5-lanes.md §2）：approval 槽放 b 的 ApprovalContainer（没卡时它不画，dock 的外框 empty:hidden）；
 * panel 槽在 ui.menu?.id === PI_UI_IDS.tasks 时放 b 的 TaskPanelContainer；"回到底部"用 b 的 useTranscriptStick()；
 * extras（a 给）：statusTrailing → dock 的 statusTrailing，statusCopy → status.copy。
 * 静态态（#/live 截图）：PiMenu / 输入框里的菜单不画，按画廊屏的摆法由这里静态画出来（p4-lanes §1.3）。
 */

/* ======================= 共用的取数（id、useRelayCommand、模型数据在 ./cShared.ts） ======================= */

/** get_git_branch 的 branch（扩展回包 { branch, repoRoot, detached }，G11 已对照扩展代码）；没有就是 null */
function useGitBranch(relay: Relay): string | null {
  const res = useRelayCommand(relay.runCommand, commandsReady(relay) ? "get_git_branch" : null, undefined, relay.roomId)
  const data = res.data as { branch?: unknown } | undefined
  return res.phase === "ready" && typeof data?.branch === "string" && data.branch ? data.branch : null
}

/** 本机资源命令（get_commands）：进房间取一次，失败就是空清单（/xxx 照普通文本发，不误执行） */
function useSlashResources(relay: Relay): ResourceCommand[] {
  const res = useRelayCommand(relay.runCommand, commandsReady(relay) ? "get_commands" : null, undefined, `${relay.roomId}|${relay.selectionNonce}`)
  return useMemo(() => (res.phase === "ready" ? parseResourceCommands(res.data) : []), [res.phase, res.data])
}

/** 斜杠常用组的顺序（本机 localStorage 的使用计数；别的标签页 / 实例记账后同步） */
function useSlashUsageOrder(): string[] {
  const [usage, setUsage] = useState(() => loadSlashUsage())
  useEffect(() => {
    const refresh = () => setUsage(loadSlashUsage())
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SLASH_USAGE_STORAGE_KEY) refresh()
    }
    window.addEventListener(SLASH_USAGE_EVENT, refresh)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(SLASH_USAGE_EVENT, refresh)
      window.removeEventListener("storage", onStorage)
    }
  }, [])
  return useMemo(() => frequentSlashNames(usage, SLASH_USAGE_MAX_ENTRIES), [usage])
}

/** 模型菜单的内容（dock 和新建会话共用）。静态态：hoverKey = ui 的 arg（截图里悬停的那一行），说明卡照画廊屏摆 */
export function ModelMenuContent({
  relay,
  variant,
  data,
  hoverKey,
  isStatic,
}: {
  relay: Relay
  variant: "desktop" | "phone"
  data: ReturnType<typeof useModelData>
  hoverKey?: string
  isStatic: boolean
}) {
  const actions = useModelActions(relay)
  const explainerFor = (key: string): ReactNode => {
    const row = data.rows.find((m) => m.key === key)
    if (!row) return null
    const ex = modelExplainerOf(row, modelContextWindowOf(data.raw, key))
    // 只有费用说明的模型才出卡（design：全产品唯一的橙色只出在这里与手机行内）；费用一行用 Pi 的警告橙
    if (!ex.cost) return null
    return <ModelExplainerCard data-cw-id="pi-model-explainer" explainer={ex} className={C_EXPLAINER_ORANGE} />
  }
  if (variant === "phone") {
    return (
      <PiModelMenu
        variant="phone"
        models={data.rows}
        thinkingLevels={data.segments}
        thinking={relay.thinkingLevel}
        onSelectModel={(key) => actions.selectModel(key, data.rows)}
        onThinkingChange={actions.setThinking}
      />
    )
  }
  if (isStatic) {
    return (
      <PiModelMenu
        static
        variant="desktop"
        models={data.rows}
        thinkingLevels={data.segments}
        thinking={relay.thinkingLevel}
        hoverKey={hoverKey}
        explainer={hoverKey ? explainerFor(hoverKey) : undefined}
      />
    )
  }
  return (
    <PiModelMenu
      variant="desktop"
      models={data.rows}
      thinkingLevels={data.segments}
      thinking={relay.thinkingLevel}
      onSelectModel={(key) => actions.selectModel(key, data.rows)}
      onThinkingChange={actions.setThinking}
      explainerFor={explainerFor}
    />
  )
}

/** S2 超过 200ms 还没 ack：框下写"发送中…"（design §1.6） */
function useSlowAck(active: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => setSlow(true), PI_SLOW_ACK_MS)
    return () => {
      window.clearTimeout(timer)
      // 下一次发送重新计时
      setSlow(false)
    }
  }, [active])
  return active && slow
}

/**
 * 桌面 ↑ / ↓ 提示词历史（design K04，PLAN §7.3 composer-keyboard；口径照旧界面 style/faces.tsx 的 ComposerBody，纯函数在 model/promptRecall.ts）。
 * 浏览状态放 ref（按键时读写，不触发重画）；换会话、历史变了（发出了新的一条）、草稿被改成别的（用户改字、斜杠命令 / 分叉回填）就退出浏览。
 * 手机不接（容器不传回调）。
 */
function usePromptRecall(relay: Relay): (key: PromptRecallKey) => boolean {
  const recall = useRef<PromptRecall>(PROMPT_RECALL_IDLE)
  const items = relay.transcript.items
  const historyKey = useMemo(() => promptHistoryKey(items), [items])
  const roomId = relay.roomId
  const draft = relay.draft
  useEffect(() => {
    recall.current = PROMPT_RECALL_IDLE
  }, [historyKey, roomId])
  useEffect(() => {
    recall.current = promptRecallAfterDraft(recall.current, draft)
  }, [draft])
  return (key) => {
    const step = promptRecallStep(recall.current, items, key)
    if (!step) return false
    recall.current = step.state
    relay.setDraft(step.text)
    return true
  }
}

/** 连接口径：浏览器自己断网时按"重连中"（pageLinkView，账户区和连接状态行同一个函数；tray 与原因同口径：linkOk = authed && browserOnline） */
function linkOf(relay: Relay, now: number) {
  return pageLinkView(relay, now)
}

function deviceOf(relay: Relay): { name: string; online: boolean } | null {
  return relay.deviceMode && relay.selectedDevice ? { name: relay.selectedDevice.name, online: relay.selectedDevice.online } : null
}

/** 排队面板的三段 → PiQueuePanel 的 remote / host / outbox */
function queuePanelData(relay: Relay, sections: PiQueueSection[]) {
  const local = sections.find((s) => s.kind === "local")
  const host: { steering: CHostMessage[]; followUp: CHostMessage[] } = { steering: [], followUp: [] }
  for (const item of local?.kind === "local" ? local.items : []) {
    const message: CHostMessage = { role: "user", content: item.text, timestamp: 0 }
    if (item.segment === "steer") host.steering.push(message)
    else host.followUp.push(message)
  }
  const outboxSection = sections.find((s) => s.kind === "outbox")
  const outbox =
    outboxSection?.kind === "outbox"
      ? {
          title: outboxSection.title,
          items: relay.outbox.map((e) => ({ cid: e.cid, text: e.text, status: e.status, at: e.at, error: e.error, unknown: e.unknown })),
        }
      : null
  return { remote: relay.remoteQueue, host, outbox }
}

type QueueEditing = { id: string; text: string; base: string | undefined; phase: "loading" | "ready" | "saving"; conflict?: boolean; note?: string | null }

/**
 * 排队面板（桌面 tray 上方 / 手机半高 sheet 共用）的数据与动作。编辑照 chat/composer/RemoteQueueCard.tsx 的口径：
 * 被截断的条目先拉全文（拉不到就只读并说明）；保存带 baseHash（乐观并发），扩展回 queue_conflict 时保留编辑稿、
 * 写"这条刚在别处改过"，给「用我的」（拿最新指纹再存，用户明确选的覆盖）/「用新的」（换成最新全文再改）。
 */
function useQueue(relay: Relay) {
  // 排队"立即发送"打断 / 等工具结束：旧键 queueSend（P7 偏好迁移前一直读它，口径见 model/legacyStyle.ts）
  const legacy = useLegacyStyle()
  const [editing, setEditing] = useState<QueueEditing | null>(null)
  const linkOk = relay.authed && relay.browserOnline
  const deviceOnline = deviceOf(relay)?.online ?? true
  const sections = queueSectionsOf(relay.remoteQueue.items, relay.queue, relay.outbox, linkOk, deviceOnline)
  const data = queuePanelData(relay, sections)
  const fail = (error: unknown) => relay.notify(commandErrorText(error, "排队操作失败"), "bad")
  const patch = (id: string, next: Partial<QueueEditing> | null) =>
    setEditing((cur) => (!cur || cur.id !== id ? cur : next === null ? null : { ...cur, ...next }))
  const fetchFull = (id: string) => relay.queueFetchFullText(id)
  // "立即发送"按 id 的在飞锁（UI·perf 中-6）：连点只下发一帧，上一帧有结果（或失败）后才解锁。
  // F4: the in-transcript queued-bubble actions share this same lock instance.
  const sendNowLock = sharedSendNowLock
  // 条目离开 pending（被注入 / 发了 / 失败 / 别处取消）：编辑稿已经无落点，作废并明确告知，
  // 不让它静默消失（UI·perf 中-6：可编辑检查原来只在打开编辑器时查一次）
  const editingId = editing?.id ?? null
  const remoteItems = relay.remoteQueue.items
  const notify = relay.notify
  const editInvalid = editingId == null ? null : queueEditInvalidationOf(remoteItems, editingId)
  useEffect(() => {
    if (editingId == null || editInvalid == null) return
    // 外部帧（remote_queue_state）→ 本地编辑状态：只能靠 effect 同步；提示也不能在渲染里发
    // eslint-disable-next-line react/set-state-in-effect
    setEditing(null)
    notify(editInvalid === "sent" ? "这条已经发出去了，编辑稿没有保存" : "这条已经不在队列里，编辑稿没有保存", "warn")
  }, [editingId, editInvalid, notify])
  const beginEdit = (id: string) => {
    const item = relay.remoteQueue.items.find((i) => i.id === id)
    if (!item || !canMutateRemoteQueueItem(item)) {
      relay.notify("这条已经在发了，改不了", "warn")
      return
    }
    if (!item.truncated) {
      setEditing({ id, text: item.text, base: item.textHash, phase: "ready" })
      return
    }
    setEditing({ id, text: "", base: item.textHash, phase: "loading" })
    fetchFull(id).then(
      ({ text, textHash }) => patch(id, { text, base: textHash ?? item.textHash, phase: "ready" }),
      (error: unknown) => {
        patch(id, null)
        relay.notify(errorCode(error) === "payload_too_large" ? "内容过长，请在电脑上看全文" : "全文拉取失败，可以再点一次编辑重试", "warn")
      },
    )
  }
  const save = (force?: string) => {
    if (!editing || editing.phase !== "ready") return
    const { id, text } = editing
    if (!text.trim()) {
      patch(id, { note: "待发消息不能为空" })
      return
    }
    patch(id, { phase: "saving", note: null, conflict: false })
    relay.queueEdit(id, text.trim(), force ?? editing.base).then(
      () => patch(id, null),
      (error: unknown) =>
        errorCode(error) === "queue_conflict"
          ? patch(id, { phase: "ready", conflict: true, note: "这条刚在别处改过" })
          : patch(id, { phase: "ready", note: commandErrorText(error, "保存失败") }),
    )
  }
  const resolve = (choice: "mine" | "theirs") => {
    if (!editing) return
    const id = editing.id
    patch(id, { phase: "loading", note: null, conflict: false })
    fetchFull(id).then(
      ({ text, textHash }) => {
        if (choice === "theirs") patch(id, { text, base: textHash, phase: "ready" })
        else {
          // 用我的：用户看到冲突后明确选择覆盖；拿最新指纹当基线再存一次
          setEditing((cur) => (cur && cur.id === id ? { ...cur, base: textHash, phase: "ready" } : cur))
          window.setTimeout(() => save(textHash), 0)
        }
      },
      (error: unknown) => patch(id, { phase: "ready", note: commandErrorText(error, "拉取最新内容失败") }),
    )
  }
  return {
    ...data,
    // 定时段（D-§3）：当前房排期清单 + 创建/取消；armed 条数计入面板计数——只剩
    // 定时项时排队面板也要打得开（两处渲染点都以 count > 0 为门）。
    schedules: relay.schedules,
    onScheduleCancel: (id: string) => {
      void relay.cancelSchedule(id).catch(fail)
    },
    onScheduleCreate: (input: ScheduleCreateInput) => relay.createSchedule(input),
    scheduleSegment: (relay.sendMode === "follow_up" ? "follow_up" : "steer") as "steer" | "follow_up",
    count:
      relay.remoteQueue.items.filter((i) => i.status === "pending").length +
      relay.queue.steering.length +
      relay.queue.followUp.length +
      relay.outbox.length +
      relay.schedules.filter((s) => s.state === "armed").length,
    editing: editing ? { id: editing.id, text: editing.text, phase: editing.phase, conflict: editing.conflict, note: editing.note } : null,
    onEditChange: (text: string) => editing && patch(editing.id, { text, note: editing.conflict ? editing.note : null }),
    onEditSave: () => save(),
    onEditCancel: () => setEditing(null),
    onEditResolve: resolve,
    onAction: (id: string, action: "send-now" | "edit" | "cancel") => {
      if (action === "cancel") void relay.queueCancel(id).catch(fail)
      // "立即发送"按设置里的"排队消息立即发送时"（旧键 queueSend：打断当前操作 / 等当前工具结束）。
      // 同一 id 在飞时忽略重复点击：连点两下不再发两帧（UI·perf 中-6）
      else if (action === "send-now") {
        if (!sendNowLock.begin(id)) return
        void relay.queueSendNow(id, legacy.queueSend === "interrupt").then(
          () => sendNowLock.end(id),
          (error: unknown) => {
            sendNowLock.end(id)
            fail(error)
          },
        )
      } else beginEdit(id)
    },
    onOutboxAction: (cid: string, action: "cancel" | "retry") => (action === "cancel" ? relay.outboxCancel(cid) : relay.outboxRetry(cid)),
  }
}

/** 草稿里没有 @ 时的候选池：同一个空数组，避免每次渲染造新引用（UI·perf 中-2） */
const EMPTY_MENTION_POOL: string[] = []

/* ======================= 斜杠命令的执行 ======================= */

const BUILTIN_ROWS = slashBuiltinRows(SLASH_BUILTINS_COPY)
const BUILTIN_NAMES = new Set(BUILTIN_ROWS.map((r) => r.key))
/** 选中后要打开的弹窗（G03–G18） */
const SLASH_DIALOG: Record<string, string> = {
  regenerate: PI_UI_IDS.regenerate,
  session: PI_UI_IDS.sessionState,
  settings: PI_UI_IDS.hostSettings,
  system: PI_UI_IDS.systemPrompt,
  fork: PI_UI_IDS.fork,
  clone: PI_UI_IDS.clone,
  tree: PI_UI_IDS.tree,
  stats: PI_UI_IDS.usage,
  usage: PI_UI_IDS.usage,
  tools: PI_UI_IDS.tools,
  compact: PI_UI_IDS.compact,
}

function useSlashCommands(p: PiContainerProps, resources: ResourceCommand[]) {
  const { relay, act, variant } = p
  const clear = () => relay.setDraft(withoutSlash(relay.draft))
  const openModelMenu = () => {
    if (variant === "phone") act.openSheet({ id: C_IDS.model })
    else act.openMenu({ id: C_IDS.model })
  }
  const execResource = async (command: ResourceCommand, arg: string | null) => {
    if (!command.executable) {
      relay.notify(`/${command.name} 不能从网页执行${command.description ? " · " + command.description : ""}`, "bad")
      return
    }
    const text = resourceCommandText(command.name, arg)
    if (!text) return
    try {
      await relay.runCommand("prompt", resourceExecArgs(text, { busy: relay.busy, followUp: relay.sendMode === "follow_up" }))
      noteSlashCommandUsed(command.name)
      relay.setDraft("")
      relay.notify(`已执行 /${command.name}`)
    } catch (error) {
      relay.notify(commandErrorText(error, "命令执行失败"), "bad")
    }
  }
  const runRow = (row: SlashRow) => {
    const resource = slashResourceOf(resources, row.key)
    if (resource) {
      void execResource(resource, null)
      return
    }
    const key = row.key
    if (key === "name" || key === "follow") {
      relay.setDraft(`${row.name} `)
      return
    }
    noteSlashCommandUsed(row.name)
    if (key === "model" || key === "thinking") {
      clear()
      openModelMenu()
      return
    }
    if (key === "new") {
      clear()
      act.newSession()
      return
    }
    if (key === "resume" || key === "commands") {
      clear()
      act.setPaletteOpen(true)
      return
    }
    if (key === "copy") {
      clear()
      void relay.runCommand("get_last_assistant_text").then(
        async (data) => {
          const text = data && typeof data === "object" ? String((data as { text?: unknown }).text || "") : ""
          const copied = text ? await copyToClipboard(text) : false
          relay.notify(copied ? "已复制上一条回答" : text ? "复制失败：浏览器不允许剪贴板（需要 HTTPS 或本机打开）" : "还没有回答可以复制", copied ? "warn" : "bad")
        },
        (error: unknown) => relay.notify(commandErrorText(error), "bad"),
      )
      return
    }
    const dialog = SLASH_DIALOG[key]
    if (dialog) {
      clear()
      openPiDialog(p, { id: dialog, arg: relay.roomId })
    }
  }
  /** 发送前看一眼：带参数的 /name、/follow 和资源命令在这里执行，其余照普通消息发（未知 /xxx 也是普通文本，不误执行） */
  const trySend = (): boolean => {
    const parsed = parseSlashDetailed(relay.draft.trim())
    if (!parsed) return false
    const arg = (parsed.arg ?? "").trim()
    if (parsed.name === "name" && arg) {
      void relay.runCommand("set_session_name", { name: arg }).then(
        () => {
          noteSlashCommandUsed("/name")
          relay.setDraft("")
          relay.notify("已修改会话名")
        },
        (error: unknown) => relay.notify(commandErrorText(error), "bad"),
      )
      return true
    }
    // design G02「/thinking 带参数直切保留」（旧界面 chat/slash.tsx 的 applyWrittenThinking / applyWrittenModel）：
    // 写了档位 / 模型就直接切，不当成聊天消息发给模型（lane-real F-R5）
    if (parsed.name === "thinking" && arg) {
      void relay.runCommand("get_available_thinking_levels").then(
        async (data) => {
          const levels = data && typeof data === "object" && Array.isArray((data as { levels?: unknown }).levels) ? (data as { levels: unknown[] }).levels : []
          const level = matchThinkingLevel(levels, arg)
          if (!level) {
            const names = levels.filter((x): x is string => typeof x === "string" && x.length > 0)
            relay.notify(names.length ? `没有这个思考级别。可选：${names.join("、")}` : "当前模型没有可选的思考级别", "bad")
            return
          }
          await relay.runCommand("set_thinking_level", { level })
          noteSlashCommandUsed("/thinking")
          relay.setDraft("")
        },
      ).catch((error: unknown) => relay.notify(commandErrorText(error, "切换思考级别失败"), "bad"))
      return true
    }
    if (parsed.name === "model" && arg) {
      void relay.runCommand("get_available_models").then(
        async (data) => {
          const rec = data && typeof data === "object" ? (data as { available?: unknown; models?: unknown }) : {}
          const available = Array.isArray(rec.available) ? rec.available : []
          const matched = matchExactModel(available.length ? available : Array.isArray(rec.models) ? rec.models : [], arg)
          relay.setDraft("")
          if (!matched) {
            openModelMenu()
            return
          }
          await relay.runCommand("set_model", { provider: matched.provider, modelId: matched.modelId })
          noteSlashCommandUsed("/model")
        },
      ).catch((error: unknown) => relay.notify(commandErrorText(error, "切换模型失败"), "bad"))
      return true
    }
    if (parsed.name === "follow" && arg) {
      void relay.runCommand("follow_up", { message: arg }).then(
        () => {
          noteSlashCommandUsed("/follow")
          relay.setDraft("")
          relay.notify("已排到这轮结束之后")
        },
        (error: unknown) => relay.notify(commandErrorText(error), "bad"),
      )
      return true
    }
    if (!BUILTIN_NAMES.has(parsed.name)) {
      const resource = matchResourceCommand(resources, parsed.raw)
      if (resource) {
        void execResource(resource, parsed.arg)
        return true
      }
    }
    return false
  }
  return { runRow, trySend }
}

/* ======================= + 菜单（图片 / 文本文件 / 命令 / 用量） ======================= */

function useAttach(p: PiContainerProps) {
  const { relay } = p
  const imageInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLInputElement>(null)
  const pick = (key: PiAttachPick) => {
    if (key === "image") imageInput.current?.click()
    else if (key === "text") textInput.current?.click()
    else if (key === "commands") {
      // "命令…" = 在输入框里打 /（斜杠菜单由输入内容打开）
      relay.setDraft("/")
      window.setTimeout(() => document.querySelector<HTMLElement>('[data-cw-id="pi-composer-input"]')?.focus({ preventScroll: true }), 30)
    } else openPiDialog(p, { id: PI_UI_IDS.usage, arg: relay.roomId })
  }
  const inputs = (
    <>
      <input
        ref={imageInput}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          if (!files.length) return
          // 压缩 / 额度 / 被拒的提示照旧界面的同一套口径（./cImages.ts；不 import chat/toolbar.tsx：它带旧界面的全局样式表）
          void importImageFiles(relay, files)
        }}
      />
      <input
        ref={textInput}
        type="file"
        hidden
        accept="text/*,.md,.txt,.json,.ts,.tsx,.js,.mjs,.cjs,.py,.sh,.go,.rs,.yaml,.yml,.toml,.css,.html"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (!file) return
          if (file.size > TEXT_FILE_MAX_BYTES) {
            relay.notify(`${file.name} 超过 64 KB，未插入`, "warn")
            return
          }
          void file.arrayBuffer().then((buffer) => {
            const decoded = decodeTextFile(new Uint8Array(buffer))
            if (!decoded.ok) {
              relay.notify(decoded.reason, "warn")
              return
            }
            const inserted = insertFileBlock(relay.draft, file.name, decoded.text)
            if (!inserted.ok) {
              relay.notify(inserted.reason, "warn")
              return
            }
            relay.setDraft(inserted.text)
            if (inserted.truncated) relay.notify(`${file.name} 太长，截掉了 ${inserted.omittedChars} 字`, "warn")
          })
        }}
      />
    </>
  )
  return { pick, inputs }
}

/* ======================= dock ======================= */

export function ComposerContainer(props: PiContainerProps & { extras?: PiSessionExtras }) {
  const { extras, ...p } = props
  const { relay, ui, act, variant, keyboardOpen } = p
  const phone = variant === "phone"
  const isStatic = usePiStatic()
  const now = useNow(1000)
  const stick = useTranscriptStick()
  const branch = useGitBranch(relay)
  const resources = useSlashResources(relay)
  const usageOrder = useSlashUsageOrder()
  const slash = useSlashCommands(p, resources)
  const attach = useAttach(p)
  const queue = useQueue(relay)
  const recallPrompt = usePromptRecall(relay)
  const state = relay.composer.state
  const slowAck = useSlowAck(state === "S2")
  const loaded = sessionLoaded(relay)
  const device = deviceOf(relay)
  const linkOk = relay.authed && relay.browserOnline
  const turnError = !!relay.turnEnd && relay.turnEnd.roomId === relay.roomId && relay.turnEnd.error
  const view = composerViewOf({
    state,
    blockReason: relay.composer.blockReason,
    overLimit: relay.composer.overLimit,
    blockedBy: ui.blockedBy,
    link: linkOf(relay, now),
    device,
    loaded,
    slowAck,
    busy: relay.busy,
    sendMode: relay.sendMode,
    branch,
    context: contextReadout(relay.usage?.contextUsage),
    extra: relay.extStatus ? Object.values(relay.extStatus.statuses) : null,
    copy: extras?.statusCopy,
    turnError,
  })

  /* ---------- tray ---------- */
  const items = relay.transcript.items
  // 改动数（tray 的「改动 +N −M」）：按工具调用缓存每块的 diff，流式时只有还在长的那条会重算（UI·perf 中-2）
  const [changesCache] = useState(createChangesCache)
  const changes = useMemo(() => changesOfSessionCached(items, changesCache), [items, changesCache])
  const menuId = ui.menu?.id
  const sheetId = ui.sheet?.id
  const tray: PiTrayItem[] = trayItemsOf({
    taskList: relay.taskList,
    remoteQueue: relay.remoteQueue.items,
    localQueue: relay.queue,
    outbox: relay.outbox,
    terminals: relay.terminalItems,
    changes,
    linkOk,
    deviceOnline: device?.online ?? true,
  }).map((item) => {
    const active =
      item.kind === "tasks"
        ? phone
          ? sheetId === PI_UI_IDS.tasks
          : menuId === PI_UI_IDS.tasks
        : item.kind === "queue"
          ? phone
            ? sheetId === C_IDS.queue
            : menuId === C_IDS.queue
          : !phone && ui.pane === item.kind
    // 改动 pill：数字由 PiTray 的 DiffStat 按 added / removed 画（同画廊屏 TRAY_CHANGES），label 只留"改动"，
    // 否则读成"改动 +32 −9 +32 −9"（lane-requests p5-a #7、p5-b #4）；读屏名仍是"改动 +32 −9"
    const shown = item.kind === "changes" ? { ...item, label: "改动" } : item
    return active ? { ...shown, active: true } : shown
  })
  const onTrayItem = (kind: PiTrayItem["kind"]) => {
    if (kind === "tasks" || kind === "queue") {
      const id = kind === "tasks" ? PI_UI_IDS.tasks : C_IDS.queue
      if (phone) act.openSheet({ id })
      else if (menuId === id) act.closeMenu()
      else act.openMenu({ id })
      return
    }
    // 终端 / 改动：桌面开关右 pane；手机进推入页（PhoneApp 按 ui.pane 换整页）
    if (phone) act.setPane(kind)
    else act.setPane(ui.pane === kind ? null : kind)
  }
  const panel =
    phone || !menuId ? undefined : menuId === PI_UI_IDS.tasks ? (
      <TaskPanelContainer {...p} />
    ) : menuId === C_IDS.queue && queue.count > 0 ? (
      <PiQueuePanel
        variant="desktop"
        remote={queue.remote}
        host={queue.host}
        outbox={queue.outbox}
        now={now}
        onAction={queue.onAction}
        onOutboxAction={queue.onOutboxAction}
        editing={queue.editing}
        onEditChange={queue.onEditChange}
        onEditSave={queue.onEditSave}
        onEditCancel={queue.onEditCancel}
        onEditResolve={queue.onEditResolve}
        schedules={queue.schedules}
        onScheduleCancel={queue.onScheduleCancel}
        onScheduleCreate={queue.onScheduleCreate}
        scheduleSegment={queue.scheduleSegment}
      />
    ) : undefined

  /* ---------- 草稿、引用、图片 ---------- */
  const draft = relay.draft
  const mentions = relay.pendingFiles.map((f) => f.path)
  const images: CImage[] = relay.pendingImages.map((img) => ({
    mimeType: img.mimeType,
    bytes: Math.round((img.data.length * 3) / 4),
    src: img.data ? `data:${img.mimeType};base64,${img.data}` : undefined,
  }))
  const onMentionsChange = (paths: string[]) => {
    for (const path of mentions) if (!paths.includes(path)) relay.removePendingFile(path)
    const added = paths.filter((path) => !mentions.includes(path))
    if (added.length) relay.addPendingFiles(added.map((path) => ({ path, label: mentionLabel(path) })))
  }
  const roomId = relay.roomId

  // UI 低危 16：草稿落盘失败（配额满 / 存储被禁）不再彻底静默；数据层同一房间的连续失败只报一次。
  const notify = relay.notify
  useEffect(
    () =>
      onDraftPersistFailure((failure) => {
        if (failure.roomKey !== roomId) return
        notify("草稿存不进浏览器（存储已满或被禁用），刷新后这段输入会丢", "warn")
      }),
    [roomId, notify],
  )

  // UI 低危 17：草稿只存文本，待发图片刷新就丢。挂载/换房时先恢复本标签页刷新前的那一组；
  // 恢复不了或只恢复一部分就明确说，避免用户以为图还在、裸发正文。
  const restoredImagesFor = useRef<string | null>(null)
  useEffect(() => {
    if (!roomId || isStatic || restoredImagesFor.current === roomId) return
    restoredImagesFor.current = roomId
    const saved = readDraftImages(roomId)
    if (!saved.length || relay.pendingImages.length > 0) return
    const accepted = relay.addPendingImages(saved)
    if (accepted < saved.length) {
      notify(`刷新前的 ${saved.length} 张待发图片只恢复了 ${accepted} 张，请重新添加其余的`, "warn")
    }
  }, [roomId, isStatic, relay, notify])

  // 图片一变就写一份会话级副本（同一标签页刷新/崩溃可恢复）；没有图就清掉，已发出的不会复活。
  // 写失败（存储被禁）也明说，不再静默。
  const imagePersistWarned = useRef(false)
  const pendingImages = relay.pendingImages
  useEffect(() => {
    if (!roomId || isStatic) return
    if (!pendingImages.length) {
      clearDraftImages()
      return
    }
    if (saveDraftImages(roomId, pendingImages)) {
      imagePersistWarned.current = false
      return
    }
    if (imagePersistWarned.current) return
    imagePersistWarned.current = true
    notify("待发图片存不进浏览器（存储已满或被禁用），刷新后会丢", "warn")
  }, [roomId, isStatic, pendingImages, notify])

  // 候选池 = 本会话工具入参里的路径 + 文件视图读过的文件（mention.ts，按会话分槽），合并后上限 20
  // UI·perf 中-2：@ 候选只在草稿里真有 @ 时才扫历史（@ 菜单也只在这时可能弹出）。
  // 否则流式期间每 50ms 都要把上万条历史从头扫一遍；草稿里没有 @ 时返回空池，菜单本来就打不开，行为不变。
  const poolWanted = isStatic || draft.includes("@")
  const mentionPool = useMemo(
    () => (poolWanted ? mergeMentionCandidates(collectTranscriptFiles(items), viewedMentionFiles(roomId)).map((f) => f.path) : EMPTY_MENTION_POOL),
    [poolWanted, items, roomId],
  )
  const slashGroups: SlashGroup[] = useMemo(() => slashBrowseGroupsOf(BUILTIN_ROWS, resources, usageOrder), [resources, usageOrder])

  /* ---------- 菜单（桌面锚定菜单 / 手机 sheet；手机键盘开着时 + / 模型是输入框上方的浮层） ---------- */
  // P6.3（design §4.2 第 7 条）：手机键盘开着时 + / 模型不开 sheet（会被键盘挡住、或一打开就收掉键盘），
  // 记在 ui.menu 里、由 PiFollowUpComposer 画成浮层；键盘收起时浮层由 composer 关掉，再点就是 sheet
  const sheetMenus = phone && !keyboardOpen
  const isOpen = (id: string) => (phone ? sheetId === id || menuId === id : menuId === id)
  const plusOpen = isOpen(C_IDS.plus)
  const modelOpen = isOpen(C_IDS.model)
  const modelData = useModelData(relay, modelOpen && !sheetMenus)
  const toggle = (id: string) => (open: boolean) => {
    if (open) {
      if (sheetMenus) act.openSheet({ id })
      else act.openMenu({ id })
      return
    }
    if (menuId === id) act.closeMenu()
    if (phone && sheetId === id) act.closeSheet()
  }
  let staticMenu: ReactNode
  if (isStatic) {
    // 静态态：输入框里的 / @ 菜单按草稿画；+ / 模型按 ui.menu 画（手机的在 ComposerSheets）
    const trigger = composerTriggerOf(draft, draft.length, { slash: true, mention: true, mentionCount: mentions.length })
    if (trigger?.kind === "slash") {
      staticMenu = <PiSlashMenu variant={variant} groups={slashMenuGroups(slashGroups, trigger.query)} maxHeight={phone ? 288 : 360} />
    } else if (trigger?.kind === "mention") {
      staticMenu = <PiMentionMenu variant={variant} pool={mentionPool} query={trigger.query} selected={mentions} maxHeight={phone ? 220 : 300} />
    } else if (!phone && plusOpen) {
      staticMenu = <PiAttachMenu variant="desktop" className="w-[280px]" commandsDisabled={!loaded} />
    } else if (!phone && modelOpen) {
      // 菜单右缘对齐模型选择器右缘（composer 右内距 10 + 圆钮 26 + 间距 10 = 46，同画廊屏）
      staticMenu = (
        <div className="flex justify-end pr-[46px]">
          <ModelMenuContent relay={relay} variant="desktop" data={modelData} hoverKey={ui.menu?.arg} isStatic />
        </div>
      )
    }
  }

  return (
    <>
      <PiComposerDock
        variant={variant}
        state={state}
        approval={<ApprovalContainer {...p} />}
        blockedBy={ui.blockedBy}
        draft={draft}
        caret={isStatic && draft.length > 0}
        onDraftChange={relay.setDraft}
        mentions={mentions}
        onMentionsChange={onMentionsChange}
        images={images}
        onRemoveImage={(index) => relay.removePendingImage(index)}
        model={modelPillOf(relay)}
        placeholder={view.placeholder}
        tray={tray}
        onTrayItem={onTrayItem}
        scrollDown={stick.scrollDown}
        newCount={stick.newCount}
        onScrollDown={stick.onScrollDown}
        panel={panel}
        onPanelClose={act.closeMenu}
        status={view.status}
        statusTrailing={phone ? undefined : extras?.statusTrailing}
        keyboardOpen={keyboardOpen}
        onDeliveryChange={(value) => relay.setSendMode(value)}
        deliveryOpen={phone ? sheetId === C_IDS.delivery : undefined}
        onDeliveryOpenChange={phone ? toggle(C_IDS.delivery) : undefined}
        menu={staticMenu}
        plusOpen={plusOpen}
        onPlusOpenChange={toggle(C_IDS.plus)}
        plusMenu={
          sheetMenus ? undefined : phone ? (
            <PiAttachMenu
              variant="phone"
              bare
              commandsDisabled={!loaded}
              onPick={(k) => {
                act.closeMenu()
                attach.pick(k)
              }}
            />
          ) : (
            <PiAttachMenu variant="desktop" className="w-[280px]" commandsDisabled={!loaded} onPick={attach.pick} />
          )
        }
        modelOpen={modelOpen}
        onModelOpenChange={toggle(C_IDS.model)}
        modelMenu={sheetMenus ? undefined : <ModelMenuContent relay={relay} variant={variant} data={modelData} isStatic={false} />}
        slashGroups={slashGroups}
        onSlashCommand={slash.runRow}
        mentionPool={mentionPool}
        onHistoryKey={phone ? undefined : recallPrompt}
        onSend={() => {
          if (slash.trySend()) return
          void relay.sendText()
        }}
        onStop={() => void relay.abort()}
      />
      {attach.inputs}
    </>
  )
}

/* ======================= 手机 sheet ======================= */

/** 把 PiMenuCloseContext 交给 sheet 里的菜单内容：listbox 行（模型、目录）选中后关 sheet */
export function SheetHost({ close, children }: { close: () => void; children: ReactNode }) {
  return <PiMenuCloseContext.Provider value={close}>{children}</PiMenuCloseContext.Provider>
}

const byCwId = (id: string) => () => document.querySelector<HTMLElement>(`[data-cw-id="${id}"]`)

/**
 * composer 在手机上的 sheet（PhoneApp 的 sheet 槽）：+ 菜单、模型与思考级别、投递、排队。没开时什么都不画。
 * 任务 sheet 归 b（TaskPanelContainer，PI_UI_IDS.tasks）。
 */
export function ComposerSheets(p: PiContainerProps) {
  const { relay, ui, act } = p
  const sheetId = ui.sheet?.id
  const attach = useAttach(p)
  const queue = useQueue(relay)
  const now = useNow(1000)
  const isStatic = usePiStatic()
  const modelData = useModelData(relay, sheetId === C_IDS.model)
  const close = act.closeSheet
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  let sheet: ReactNode = null
  if (sheetId === C_IDS.plus) {
    sheet = (
      <PiSheet title="添加" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-composer-plus")}>
        <PiAttachMenu
          variant="phone"
          bare
          commandsDisabled={!sessionLoaded(relay)}
          onPick={(k) => {
            close()
            attach.pick(k)
          }}
        />
      </PiSheet>
    )
  } else if (sheetId === C_IDS.model) {
    sheet = (
      <PiSheet title="模型与思考" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-composer-model")}>
        <SheetHost close={close}>
          <ModelMenuContent relay={relay} variant="phone" data={modelData} isStatic={isStatic} />
        </SheetHost>
      </PiSheet>
    )
  } else if (sheetId === C_IDS.delivery) {
    sheet = (
      <PiSheet title="pi 忙的时候发消息" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-delivery")}>
        <PiDeliveryOptions
          variant="phone"
          bare
          value={relay.sendMode === "follow_up" ? "follow_up" : "steer"}
          onValueChange={(value) => {
            relay.setSendMode(value)
            close()
          }}
        />
      </PiSheet>
    )
  } else if (sheetId === C_IDS.queue && queue.count > 0) {
    // P6.3（design §4.3）：编辑一条待发消息时"保存 / 取消"放进 sheet 的 footer，键盘开着时钉在键盘上沿
    const editing = queue.editing
    sheet = (
      <PiSheet
        title="排队"
        subtitle={`${queue.count} 条在等`}
        size="half"
        bodyClassName="px-4"
        onOpenChange={onOpenChange}
        returnFocus={byCwId("pi-tray-queue")}
        footer={editing ? <PiQueueEditFooter phase={editing.phase} onSave={queue.onEditSave} onCancel={queue.onEditCancel} /> : undefined}
      >
        <PiQueuePanel
          variant="phone"
          bare
          editFooter
          remote={queue.remote}
          host={queue.host}
          outbox={queue.outbox}
          now={now}
          onAction={queue.onAction}
          onOutboxAction={queue.onOutboxAction}
          editing={queue.editing}
          onEditChange={queue.onEditChange}
          onEditSave={queue.onEditSave}
          onEditCancel={queue.onEditCancel}
          onEditResolve={queue.onEditResolve}
          schedules={queue.schedules}
          onScheduleCancel={queue.onScheduleCancel}
          onScheduleCreate={queue.onScheduleCreate}
          scheduleSegment={queue.scheduleSegment}
        />
      </PiSheet>
    )
  }
  return (
    <>
      {sheet}
      {attach.inputs}
    </>
  )
}
