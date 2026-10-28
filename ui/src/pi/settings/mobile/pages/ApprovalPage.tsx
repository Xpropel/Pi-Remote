/**
 * 手机端设置 · 审批与执行（移动压缩版）。
 *
 * 口径框（设计册第 5 节）：pi 没有 Codex 式权限档位。
 *   ◌ 何时询问 / 能碰什么 / 高危解锁 / 免审名单：设计预留，只保留不可用形态；
 *   ● 项目信任默认：经 settings_set 写 defaultProjectTrust；当前项目信任状态仍经 get_state 读；
 *   ● 可用工具：真实 `get_active_tools` / `get_all_tools` → `set_active_tools`，
 *     作用域 = 当前会话（与 ToolsDialog 同一桥，不是持久默认）。
 *     读不到工具表时显示空态 /「连接主机后显示」，不拿设计稿的 8 个工具冒充真实清单。
 */
import { useState } from "react"
import { toolRowsOf } from "@/pi/model/dialogsData"
import { useSettings } from "../../SettingsContext.tsx"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import { defaultProjectTrustPatch, effectiveProjectTrustOf } from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import {
  MobileActionRow,
  MobileBanner,
  MobileEmpty,
  MobileGroup,
  MobileNote,
  MobileOptionList,
  MobilePageBody,
  MobileRow,
  MobileSelect,
  MobileSwitch,
} from "../atoms.tsx"

const ASK_OPTIONS = [
  { value: "ask", title: "逐项询问", description: "命令与工具调用先经你确认" },
  { value: "list", title: "名单内自动通过", description: "免审名单里的命令直接执行，其余仍询问" },
  { value: "never", title: "永不询问", description: "全部直接执行，风险高，仅建议在可信环境开启" },
] as const

const TRUST_OPTIONS = [
  { value: "ask", title: "打开新项目时先询问" },
  { value: "always", title: "总是信任" },
  { value: "never", title: "从不信任" },
] as const

const SCOPE_OPTIONS = [
  { value: "read", title: "仅查看", description: "只能读取，不能改动" },
  { value: "workspace", title: "工作区内可改", description: "可改当前工作区内的文件" },
  { value: "full", title: "完全访问", description: "可改设备上任意文件 · 需先在下方解锁" },
] as const

const WEB_SEARCH_OPTIONS = [
  { value: "live", label: "实时" },
  { value: "cached", label: "缓存" },
] as const

const DENY_LIST = ["git status", "cat *", "npm run test"] as const

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
  const { p } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const activeQuery = useHostCommand(relay, "get_active_tools", ready, relay.roomId)
  const allQuery = useHostCommand(relay, "get_all_tools", ready, relay.roomId)
  const stateQuery = useHostCommand(relay, "get_state", ready, relay.roomId)
  const state = stateQuery.data && typeof stateQuery.data === "object" ? (stateQuery.data as Record<string, unknown>) : {}
  const view = toolRowsOf(activeQuery.data, allQuery.phase === "ready" ? allQuery.data : null)
  const [picked, setPicked] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)


  const hostRows = view.rows
  const rows = hostRows.map((row) => row.name)
  const selected = picked ?? view.enabled
  const live = hostRows.length > 0 && ready
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
        relay.notify(next.length ? `当前会话已启用 ${next.length} 个工具` : "当前会话已清空工具")
      },
      (error: unknown) => {
        setSaving(false)
        setPicked(selected)
        relay.notify(`工具保存失败：${error instanceof Error ? error.message : "未知错误"}`, "bad")
      },
    )
  }

  return (
    <MobilePageBody page="approval">
      <MobileBanner>
        本页「何时询问 / 能碰什么 / 高危解锁 / 免审名单」为设计预留；pi 侧真实现状是扩展的
        tool_call 权限门 + 项目信任，落地形态待定。
      </MobileBanner>

      <MobileGroup label="何时询问" badge="reserved">
        <MobileOptionList label="何时询问" value="ask" options={ASK_OPTIONS} status="reserved" />
      </MobileGroup>

      <MobileGroup
        label="项目信任"
        footnote={
          projectTrusted === null
            ? `项目级配置、扩展与 MCP 服务器都要信任后才加载。新项目默认策略：${defaultTrustLabel}。`
            : `项目级配置、扩展与 MCP 服务器都要信任后才加载。当前项目${projectTrusted ? "已信任" : "未信任"}；新项目默认策略：${defaultTrustLabel}。`
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

      <MobileGroup label="能碰什么" badge="reserved">
        <MobileOptionList label="活动范围" value="workspace" options={SCOPE_OPTIONS} status="reserved" />
        <MobileRow title="允许联网" description="沙盒内命令可访问网络" status="reserved">
          <MobileSwitch label="允许联网（设计预留）" checked={false} disabled />
        </MobileRow>
        <MobileSelect
          label="网页搜索"
          value="live"
          options={WEB_SEARCH_OPTIONS}
          status="reserved"
          disabled
        />
      </MobileGroup>

      <MobileGroup label="高危解锁" badge="reserved">
        <MobileRow title="允许「完全访问」与「永不询问」" description="打开后上面两组的高危档位才可选，防误触" status="reserved">
          <MobileSwitch label="高危解锁（设计预留）" checked={false} disabled />
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="免审命令名单" badge="reserved" footnote="名单内命令按上方策略自动通过，仍会记录在会话里。">
        {DENY_LIST.map((command) => (
          <MobileRow key={command} title={command} status="reserved">
            <span className="sm-value">已预留</span>
          </MobileRow>
        ))}
        <MobileActionRow title="添加命令" status="reserved" disabled />
      </MobileGroup>

      <MobileGroup
        label="可用工具"
        footnote={
          live
            ? "作用域 = 当前会话；关掉的工具不会递到模型手里，与上面的「能碰什么」是两回事。"
            : "打开一个已连接的会话后可改；关掉的工具不会递到模型手里，与上面的「能碰什么」是两回事。"
        }
      >
        {rows.length === 0 ? (
          <MobileEmpty title="可用工具" body={toolsEmpty} />
        ) : (
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
        )}
      </MobileGroup>

      <MobileNote>可用工具的开关立即写入当前会话（现有 set_active_tools 桥），不需要「确定 / 取消」。</MobileNote>
      <MobileNote>仍只读：何时询问 / 能碰什么 / 高危解锁 / 免审命令名单没有对应的 pi 设置字段（设计预留）；写桥只开放了「项目信任默认」。</MobileNote>
      {activeQuery.phase === "error" && activeQuery.error ? <MobileNote>工具读取失败：{activeQuery.error}</MobileNote> : null}
    </MobilePageBody>
  )
}
