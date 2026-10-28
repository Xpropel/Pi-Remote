/**
 * 设置 › 扩展（设计册 §6，源码 settings-set-extensions-v3.html）。
 *
 * 五组：技能 / MCP 服务器 / 提示词模板 / 扩展本体 / Pi 包。
 * 落地状态（§6）：
 *   ● MCP 清单、连接状态、工具曝光档：get_mcp_servers 只读直出；
 *   ● 「仅手动调用」标记：读技能 frontmatter 的 disable-model-invocation（sourceInfo），只呈现；
 *   ● 技能斜杠命令总闸：经 settings_set 写 enableSkillCommands；
 *   ◐ 逐条技能开关、MCP 逐台启停、模板开关、扩展开关、添加技能 / MCP / 模板 / 扩展 / 包：
 *     继续只读（写桥白名单只有总闸，没有 resources / mcp.json 的写入）；整组标「需扩展桥」。
 *     本页没有 ◌ 项，也没有 ○ 本机项，因此不调 act.setPref。
 *
 * 拿不到主机回包时给出「连接主机后显示…」的空态，不拿设计稿示例名冒充真实清单。
 */
import { useMemo, type ReactNode } from "react"
import { commandsReady, useRelayCommand } from "@/pi/containers/cShared"
import { useSettings } from "../SettingsContext"
import type { SettingsItemStatus } from "../types"
import {
  SettingsActionRow,
  SettingsNote,
  SettingsPageTitle,
  SettingsRow,
  SettingsStatusBadge,
  SettingsStatusDot,
  SettingsSwitch,
} from "../ui"
import {
  hostCommandsOf,
  mcpServersOf,
  mcpStatusTextOf,
  mcpToneOf,
  promptDisplayNameOf,
  promptsOf,
  skillDisplayNameOf,
  skillsOf,
} from "./extensionsLogic"
import { effectiveSettingsBoolOf, skillCommandsPatch } from "./settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "./settingsWriteHooks.ts"
import { SettingsWriteNote } from "./settingsWriteFeedback.tsx"
import "./extensions.css"

/** 整组同一状态时，徽标挂在分组标题上，组内行不再重复挂（同审批页口径）。 */
function StatusGroup({
  label,
  status,
  first = false,
  children,
}: {
  label: string
  status?: SettingsItemStatus
  first?: boolean
  children: ReactNode
}) {
  return (
    <section className={first ? "settings-group settings-group--first" : "settings-group"}>
      <h2 className="settings-group-label settings-ext-group-label">
        <span>{label}</span>
        <SettingsStatusBadge status={status} />
      </h2>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-ext-note">{children}</span>
    </div>
  )
}

export function ExtensionsPage() {
  const { p } = useSettings()
  const { relay } = p
  const ready = commandsReady(relay)
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const commands = useRelayCommand(relay.runCommand, ready ? "get_commands" : null, undefined, relay.roomId ?? "")
  const mcp = useRelayCommand(relay.runCommand, ready ? "get_mcp_servers" : null, undefined, relay.roomId ?? "")

  const commandList = useMemo(() => hostCommandsOf(commands.data), [commands.data])
  const skills = useMemo(() => skillsOf(commandList), [commandList])
  const prompts = useMemo(() => promptsOf(commandList), [commandList])
  const mcpServers = useMemo(() => mcpServersOf(mcp.data), [mcp.data])
  const skillCommandsEnabled = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableSkillCommands")
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null

  const skillsEmpty = !ready
    ? "连接主机后显示技能清单"
    : commands.phase === "loading"
      ? "正在读取技能清单…"
      : commands.phase === "error"
        ? "技能清单读取失败，可稍后重新打开设置"
        : "尚未发现技能"
  const promptsEmpty = !ready
    ? "连接主机后显示提示词模板"
    : commands.phase === "loading"
      ? "正在读取提示词模板…"
      : commands.phase === "error"
        ? "提示词模板读取失败，可稍后重新打开设置"
        : "尚未发现提示词模板"
  const mcpEmpty = !ready
    ? "连接主机后显示 MCP 服务器"
    : mcp.phase === "loading"
      ? "正在读取 MCP 服务器…"
      : mcp.phase === "error"
        ? "MCP 清单读取失败，可稍后重新打开设置"
        : "尚未配置 MCP 服务器"

  return (
    <div className="settings-page settings-extensions" data-settings-page="extensions">
      <SettingsPageTitle title="扩展" />

      <StatusGroup label="技能" first>
        <SettingsRow
          title="技能斜杠命令"
          description="把技能注册成 /skill:名字 命令；关了仍可手动输入调用"
        >
          <SettingsSwitch
            label="技能斜杠命令"
            checked={skillCommandsEnabled === true}
            disabled={writeDisabled || skillCommandsEnabled === null}
            onChange={(checked) => {
              void writer.save("enableSkillCommands", skillCommandsPatch(checked))
            }}
          />
        </SettingsRow>
        {skills.length === 0 ? (
          <EmptyRow>{skillsEmpty}</EmptyRow>
        ) : (
          skills.map((skill) => (
            <SettingsRow
              key={`skill:${skill.name}`}
              title={
                <>
                  {skillDisplayNameOf(skill.name)}
                  {skill.manualOnly ? <span className="settings-ext-tag">仅手动调用</span> : null}
                </>
              }
              description={skill.description || undefined}
              status="bridge"
            >
              <SettingsSwitch label={`${skillDisplayNameOf(skill.name)}（需扩展桥）`} checked disabled />
            </SettingsRow>
          ))
        )}
        <SettingsActionRow
          title="添加技能"
          description="从本地文件夹或链接导入（资源清单写入未开放）"
          status="bridge"
          disabled
        />
      </StatusGroup>
      <SettingsWriteNote feedback={writer.feedback} fallback={writeHint} />
      <SettingsNote>仍只读：逐条技能 / MCP / 模板 / 扩展与 Pi 包清单的写入未开放（写桥白名单只有技能总闸）。</SettingsNote>

      <StatusGroup label="MCP 服务器" status="bridge">
        {mcpServers.length === 0 ? (
          <EmptyRow>{mcpEmpty}</EmptyRow>
        ) : (
          mcpServers.map((server) => (
            <SettingsRow
              key={`mcp:${server.name}`}
              title={<span className="settings-ext-mono">{server.name}</span>}
              description={
                <span className="settings-ext-inline">
                  <SettingsStatusDot tone={mcpToneOf(server)} />
                  <span>{mcpStatusTextOf(server)}</span>
                </span>
              }
            >
              <SettingsSwitch label={`${server.name} 启停（需扩展桥）`} checked={server.enabled} disabled />
            </SettingsRow>
          ))
        )}
        <SettingsActionRow title="添加 MCP 服务器" description="填入启动命令或服务器地址" disabled />
      </StatusGroup>

      <StatusGroup label="提示词模板" status="bridge">
        {prompts.length === 0 ? (
          <EmptyRow>{promptsEmpty}</EmptyRow>
        ) : (
          prompts.map((prompt) => (
            <SettingsRow
              key={`prompt:${prompt.name}`}
              title={<span className="settings-ext-mono">{promptDisplayNameOf(prompt.name)}</span>}
              description={prompt.description || undefined}
            >
              <SettingsSwitch label={`${promptDisplayNameOf(prompt.name)} 启用（需扩展桥）`} checked disabled />
            </SettingsRow>
          ))
        )}
        <SettingsActionRow title="添加模板" description="模板文件名就是命令名" disabled />
      </StatusGroup>

      <StatusGroup label="扩展本体" status="bridge">
        <SettingsRow title="pi-remote 远程" description="把本机 pi 会话镜像到浏览器">
          <SettingsSwitch label="pi-remote 远程（需扩展桥）" checked disabled />
        </SettingsRow>
        <EmptyRow>扩展拥有完整系统权限，只装可信来源</EmptyRow>
        <div className="settings-row">
          <span className="settings-ext-subhead">内置</span>
        </div>
        <SettingsRow
          title={
            <>
              MCP 支持<span className="settings-ext-tag">内置</span>
            </>
          }
        >
          <SettingsSwitch label="MCP 支持（需扩展桥）" checked disabled />
        </SettingsRow>
        <SettingsRow
          title={
            <>
              代码模式 codemode<span className="settings-ext-tag">内置</span>
            </>
          }
        >
          <SettingsSwitch label="代码模式 codemode（需扩展桥）" checked disabled />
        </SettingsRow>
        <SettingsRow
          title={
            <>
              工具搜索<span className="settings-ext-tag">内置</span>
            </>
          }
        >
          <SettingsSwitch label="工具搜索（需扩展桥）" checked disabled />
        </SettingsRow>
        <SettingsRow
          title={
            <>
              本地模型 llama.cpp<span className="settings-ext-tag">内置</span>
            </>
          }
        >
          <SettingsSwitch label="本地模型 llama.cpp（需扩展桥）" checked={false} disabled />
        </SettingsRow>
        <SettingsActionRow title="添加扩展" description="从本地文件或文件夹添加" disabled />
      </StatusGroup>

      <StatusGroup label="Pi 包" status="bridge">
        <EmptyRow>尚未安装任何包</EmptyRow>
        <SettingsActionRow title="添加包" description="从 npm、git 或本地文件夹整包安装扩展、技能与模板" disabled />
      </StatusGroup>

      <SettingsNote>停用的技能与服务器不会出现在会话里。</SettingsNote>
    </div>
  )
}
