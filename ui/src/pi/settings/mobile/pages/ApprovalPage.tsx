/**
 * 手机端设置 · 审批与执行（移动压缩版）。
 *
 *   ● 何时询问 / 能碰什么（活动范围）/ 高危解锁 / 免审名单：实时同步到当前会话（set_approval_policy）；
 *   ● 项目信任默认：经 settings_set 写 defaultProjectTrust；当前项目信任状态经 get_state 读；
 *   ● 可用工具：真实 `get_active_tools` / `get_all_tools` → `set_active_tools`，
 *     作用域 = 当前会话（与 ToolsDialog 同一桥）；无会话时可写设备默认 defaultTools。
 *     读不到工具表时显示空态 /「连接主机后显示」。
 */
import { useMemo, useState } from "react"
import { X } from "lucide-react"
import { commandsReady, usePrefsWriter, useSettingsPrefs } from "@/pi/containers/cShared"
import { toolRowsOf } from "@/pi/model/dialogsData"
import { switchDisplayStateOf } from "@/pi/model/switchSync"
import { useSettings } from "../../SettingsContext.tsx"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import {
  APPROVAL_TOOLS_NOTE,
  APPROVAL_TRUST_NOTE,
  approvalAskModeOf,
  approvalDefaultToolRowsOf,
  toggledToolSet,
  validateAllowlistCommand,
} from "../../pages/approvalData.ts"
import {
  defaultProjectTrustPatch,
  defaultToolsPatch,
  effectiveProjectTrustOf,
  effectiveSettingsArrayOf,
} from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import {
  MobileActionRow,
  MobileEmpty,
  MobileGroup,
  MobileNote,
  MobileOptionList,
  MobilePageBody,
  MobileRow,
  MobileSwitch,
} from "../atoms.tsx"

const ASK_OPTIONS = [
  { value: "ask", title: "逐项询问", description: "命令与工具调用先经你确认" },
  { value: "allowlist", title: "名单内自动通过", description: "免审名单里的命令直接执行，其余仍询问" },
  { value: "never", title: "永不询问", description: "全部直接执行，风险高，仅建议在可信环境开启" },
] as const

const TRUST_OPTIONS = [
  { value: "ask", title: "打开新项目时先询问" },
  { value: "always", title: "总是信任" },
  { value: "never", title: "从不信任" },
] as const

const SCOPE_OPTIONS = [
  { value: "read-only", title: "仅查看", description: "只能读取，不能改动" },
  { value: "workspace", title: "工作区内可改", description: "可改当前工作区内的文件" },
  { value: "full", title: "完全访问", description: "可改设备上任意文件 · 需先在下方解锁" },
] as const

/** pi 常见内建工具 → 设计稿中文名；未知工具原样显示。 */
const TOOL_LABEL: Record<string, string> = {
  read: "读取文件",
  bash: "运行命令",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索文件",
  ls: "文件列表",
  find: "查找文件",
  codemode: "脚本工具 codemode",
  tool_search: "工具搜索",
}

export function ApprovalPage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const roomReady = commandsReady(relay) && relay.browserOnline
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const conversation = useSettingsPrefs(p)
  const writeConversation = usePrefsWriter(p)
  const switchesPending = relay.switchSyncView.mode === "pending" && Boolean(relay.roomId)
  const identityRequired = switchDisplayStateOf(relay.switchSyncView, relay.viewerIdentity) === "identity-required"
  const activeQuery = useHostCommand(relay, "get_active_tools", roomReady, relay.roomId)
  const allQuery = useHostCommand(relay, "get_all_tools", roomReady, relay.roomId)
  const stateQuery = useHostCommand(relay, "get_state", roomReady, relay.roomId)
  const state = stateQuery.data && typeof stateQuery.data === "object" ? (stateQuery.data as Record<string, unknown>) : {}
  const view = toolRowsOf(activeQuery.data, allQuery.phase === "ready" ? allQuery.data : null)
  const [picked, setPicked] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [addingCommand, setAddingCommand] = useState(false)
  const [newCommand, setNewCommand] = useState("")
  const [commandError, setCommandError] = useState<string | null>(null)

  const defaultTools = useMemo(
    () => effectiveSettingsArrayOf(settingsDoc.data, writer.applied, "defaultTools"),
    [settingsDoc.data, writer.applied],
  )
  const defaultToolView = useMemo(() => approvalDefaultToolRowsOf(defaultTools), [defaultTools])

  const hostRows = view.rows
  const rows = hostRows.map((row) => row.name)
  const selected = picked ?? view.enabled
  const live = hostRows.length > 0 && roomReady
  const defaultWritable = !live && writer.canWrite && settingsDoc.phase === "ready" && writer.saving === null
  const projectTrusted = typeof state.projectTrusted === "boolean" ? state.projectTrusted : null
  const defaultTrust = effectiveProjectTrustOf(settingsDoc.data, writer.applied)
  const defaultTrustLabel = TRUST_OPTIONS.find((option) => option.value === defaultTrust)?.title ?? "未知"
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const trustWriteDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null
  const toolsEmpty = !ready
    ? "连接主机后显示可用工具"
    : activeQuery.phase === "loading" || allQuery.phase === "loading"
      ? "正在读取可用工具…"
      : activeQuery.phase === "error" || allQuery.phase === "error"
        ? "可用工具读取失败，可稍后重新打开设置"
        : "当前没有可用工具"

  const askMode = approvalAskModeOf(conversation.approvalGate, prefs.approvalUseAllowlist)
  const askSwitchDisabled = switchesPending || identityRequired
  const askOptions = useMemo(
    () =>
      ASK_OPTIONS.map((option) => ({
        ...option,
        disabled: option.value === "never" && !prefs.approvalUnlockHighRisk,
      })),
    [prefs.approvalUnlockHighRisk],
  )
  const effectiveScope = prefs.approvalScope === "full" && !prefs.approvalUnlockHighRisk ? "workspace" : prefs.approvalScope
  const scopeOptions = useMemo(
    () =>
      SCOPE_OPTIONS.map((option) => ({
        ...option,
        disabled: option.value === "full" && !prefs.approvalUnlockHighRisk,
      })),
    [prefs.approvalUnlockHighRisk],
  )

  const handleAskChange = (value: "ask" | "allowlist" | "never") => {
    if (askSwitchDisabled) return
    if (value === "ask") {
      act.setPref("approvalUseAllowlist", false)
      if (!conversation.approvalGate) writeConversation({ approvalGate: true })
    } else if (value === "allowlist") {
      act.setPref("approvalUseAllowlist", true)
      if (!conversation.approvalGate) writeConversation({ approvalGate: true })
    } else if (value === "never") {
      if (!prefs.approvalUnlockHighRisk) return
      act.setPref("approvalUseAllowlist", false)
      if (conversation.approvalGate) writeConversation({ approvalGate: false })
    }
  }

  const handleUnlockChange = (checked: boolean) => {
    act.setPref("approvalUnlockHighRisk", checked)
    if (!checked) {
      if (prefs.approvalScope === "full") act.setPref("approvalScope", "workspace")
      if (!conversation.approvalGate && !askSwitchDisabled) writeConversation({ approvalGate: true })
    }
  }

  const submitAddCommand = () => {
    const checked = validateAllowlistCommand(newCommand)
    if (!checked.ok) {
      setCommandError(checked.error)
      return
    }
    if (!prefs.approvalAllowlist.includes(checked.value)) {
      act.setPref("approvalAllowlist", [...prefs.approvalAllowlist, checked.value])
    }
    setNewCommand("")
    setCommandError(null)
    setAddingCommand(false)
  }

  const toggle = (name: string) => {
    if (!live || saving) return
    const next = selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name]
    setPicked(next)
    setSaving(true)
    relay.runCommand("set_active_tools", { tools: next }).then(
      (data) => {
        setSaving(false)
        const confirmed = (data as { tools?: unknown } | null)?.tools
        if (Array.isArray(confirmed)) setPicked(confirmed.filter((item): item is string => typeof item === "string"))
        act.notify(next.length ? `当前会话已启用 ${next.length} 个工具` : "当前会话已清空工具")
      },
      (error: unknown) => {
        setSaving(false)
        setPicked(selected)
        act.notify(`工具保存失败：${error instanceof Error ? error.message : "未知错误"}`, "bad")
      },
    )
  }

  return (
    <MobilePageBody page="approval">
      <MobileGroup
        label="何时询问"
        tooltip="实时控制当前会话工具调用的拦截策略；切换至「永不询问」需先开启下方高危解锁。"
        footnote={
          identityRequired
            ? "需先在「设备」启用浏览器身份，才能远程切换审批门开关。"
            : switchesPending
              ? "正在与设备同步当前会话审批门状态…"
              : undefined
        }
      >
        <MobileOptionList
          label="何时询问"
          value={askMode}
          options={askOptions}
          disabled={askSwitchDisabled}
          onChange={handleAskChange}
        />
      </MobileGroup>

      <MobileGroup
        label="项目信任"
        tooltip={APPROVAL_TRUST_NOTE}
        footnote={
          projectTrusted === null
            ? `新项目默认策略：${defaultTrustLabel}`
            : `当前项目：${projectTrusted ? "已信任" : "未信任"} · 默认：${defaultTrustLabel}`
        }
      >
        <MobileOptionList
          label="项目信任"
          value={defaultTrust}
          options={TRUST_OPTIONS}
          disabled={trustWriteDisabled}
          onChange={(value) => {
            void writer.save("defaultProjectTrust", defaultProjectTrustPatch(value))
          }}
        />
      </MobileGroup>
      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />

      <MobileGroup
        label="能碰什么"
        tooltip="限制当前会话允许读写的文件范围；切换至「完全访问」需先开启下方高危解锁。"
      >
        <MobileOptionList
          label="活动范围"
          value={effectiveScope}
          options={scopeOptions}
          onChange={(value) => {
            if (value === "read-only" || value === "workspace" || (value === "full" && prefs.approvalUnlockHighRisk)) {
              act.setPref("approvalScope", value)
            }
          }}
        />
      </MobileGroup>

      <MobileGroup label="高危解锁">
        <MobileRow
          title="允许「完全访问」与「永不询问」"
          tooltip="防误触安全锁：开启后才允许在上方选择「完全访问」或「永不询问」高危档位。"
        >
          <MobileSwitch label="高危解锁" checked={prefs.approvalUnlockHighRisk} onChange={handleUnlockChange} />
        </MobileRow>
      </MobileGroup>

      <MobileGroup
        label="免审命令名单"
        tooltip="上方选择「名单内自动通过」时匹配的命令直接放行；仅支持单条命令或通配前缀，禁止管道与串接符。"
      >
        {prefs.approvalAllowlist.length === 0 ? (
          <MobileRow title="尚未添加免审命令" description="仅在上方选「名单内自动通过」时生效" />
        ) : (
          prefs.approvalAllowlist.map((command) => (
            <MobileRow key={command} title={command}>
              <button
                type="button"
                className="sm-inline-btn"
                aria-label={`移除 ${command}`}
                onClick={() =>
                  act.setPref(
                    "approvalAllowlist",
                    prefs.approvalAllowlist.filter((item) => item !== command),
                  )
                }
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </MobileRow>
          ))
        )}
        {addingCommand ? (
          <MobileRow
            title="新增命令"
            description={commandError ?? "输入命令前缀或通配格式，如 git status 或 npm run *"}
          >
            <span className="sm-inline-controls">
              <input
                type="text"
                className="settings-modal-input"
                style={{ width: 150 }}
                value={newCommand}
                onChange={(event) => {
                  setNewCommand(event.target.value)
                  setCommandError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    submitAddCommand()
                  }
                }}
                placeholder="git status"
                aria-label="新增免审命令"
              />
              <button type="button" className="sm-inline-btn" onClick={submitAddCommand}>
                添加
              </button>
              <button
                type="button"
                className="sm-inline-btn"
                onClick={() => {
                  setAddingCommand(false)
                  setNewCommand("")
                  setCommandError(null)
                }}
              >
                关闭
              </button>
            </span>
          </MobileRow>
        ) : (
          <MobileActionRow
            title="添加命令"
            onClick={() => {
              setAddingCommand(true)
              setCommandError(null)
            }}
          />
        )}
      </MobileGroup>

      <MobileGroup
        label="可用工具"
        tooltip={
          live
            ? APPROVAL_TOOLS_NOTE
            : defaultWritable
              ? "当前未打开会话，开关将写入新会话默认可用工具（defaultTools）。"
              : APPROVAL_TOOLS_NOTE
        }
      >
        {live ? (
          rows.map((name) => (
            <MobileRow key={name} title={TOOL_LABEL[name] ?? name} status="existing">
              <MobileSwitch
                label={`${TOOL_LABEL[name] ?? name}（当前会话）`}
                checked={selected.includes(name)}
                disabled={!live || saving}
                onChange={() => toggle(name)}
              />
            </MobileRow>
          ))
        ) : defaultWritable ? (
          defaultToolView.rows.map((row) => (
            <MobileRow key={row.id} title={row.label} status="existing">
              <MobileSwitch
                label={`${row.label}（新会话默认）`}
                checked={row.enabled}
                disabled={!defaultWritable}
                onChange={() => {
                  if (!row.toolName) return
                  const next = toggledToolSet(defaultToolView.enabled, row.toolName, !row.enabled)
                  void writer.save("defaultTools", defaultToolsPatch(next))
                }}
              />
            </MobileRow>
          ))
        ) : (
          <MobileEmpty title="可用工具" body={toolsEmpty} />
        )}
      </MobileGroup>

      {activeQuery.phase === "error" && activeQuery.error ? <MobileNote>工具读取失败：{activeQuery.error}</MobileNote> : null}
    </MobilePageBody>
  )
}
