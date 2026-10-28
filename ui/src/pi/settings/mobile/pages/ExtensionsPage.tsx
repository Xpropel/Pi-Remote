/**
 * 手机端设置 · 扩展（移动压缩版）。
 *
 *   ● 技能总闸：经 settings_set 写 enableSkillCommands；
 *   ◐ 逐条技能 / MCP 启停 / 模板开关 / 扩展本体与内置扩展 / 添加类动作：
 *     继续只读 +「需扩展桥」（写桥白名单只有总闸，没有资源名单 / mcp.json 的写入）；
 *   ● 技能清单（get_commands 的 source）、「仅手动调用」标记、MCP 清单与连接状态（get_mcp_servers）：
 *     只读呈现，不改写；
 *   ◌ 本页无预留项（刷新模型目录在模型页）。
 *
 * 主机回包优先；读不到时显示「连接主机后显示…」/「正在读取…」/「尚未发现…」空态，
 * 不拿设计稿示例技能 / MCP / 模板冒充真实清单（与桌面同口径）。
 */
import { useSettings } from "../../SettingsContext.tsx"
import { commandsOf, hostSettingsOf, mcpServersOf, nameListAt } from "../model.ts"
import { hostCommandsReady, useHostCommand } from "../data.ts"
import { effectiveSettingsBoolOf, skillCommandsPatch } from "../../pages/settingsWrite.ts"
import { readOnlyHintOf, useSettingsDocument, useSettingsWriter } from "../../pages/settingsWriteHooks.ts"
import { MobileSettingsWriteNote } from "../../pages/settingsWriteFeedback.tsx"
import {
  MobileActionRow,
  MobileEmpty,
  MobileGroup,
  MobileNote,
  MobilePageBody,
  MobileRow,
  MobileStatusLine,
  MobileSwitch,
  MobileSwitchRow,
  MobileTag,
} from "../atoms.tsx"

const BUILTIN_EXTENSIONS = ["MCP 支持", "代码模式 codemode", "工具搜索", "本地模型 llama.cpp"] as const

/** 主机 get_commands 给的是命令 id；设计稿展示的是中文技能名（认得的才映射，认不得原样）。 */
const SKILL_LABEL: Record<string, string> = {
  "code-review": "代码审查",
  literature: "文献检索",
  "web-fetch": "网页抓取",
}

export function ExtensionsPage() {
  const { p } = useSettings()
  const { relay } = p
  const ready = hostCommandsReady(relay)
  const settingsDoc = useSettingsDocument(relay)
  const writer = useSettingsWriter(relay)
  const mcpQuery = useHostCommand(relay, "get_mcp_servers", ready, relay.roomId)
  const commandsQuery = useHostCommand(relay, "get_commands", ready, relay.roomId)
  const settings = hostSettingsOf(settingsDoc.data)
  const skillCommands = commandsOf(commandsQuery.data, "skill")
  const promptCommands = commandsOf(commandsQuery.data, "prompt")
  const mcpServers = mcpServersOf(mcpQuery.data)
  const packages = nameListAt(settings, ["packages", "piPackages"])
  const extensions = nameListAt(settings, ["extensions"])
  const skillGate = effectiveSettingsBoolOf(settingsDoc.data, writer.applied, "enableSkillCommands")
  const writeHint = readOnlyHintOf(settingsDoc, writer)
  const writeDisabled = !writer.canWrite || settingsDoc.phase !== "ready" || writer.saving !== null

  const skills = skillCommands.map((command) => ({
    name: SKILL_LABEL[command.name] ?? command.name,
    description: command.description,
    manualOnly: command.manualOnly,
    on: true,
  }))
  const prompts = promptCommands.map((command) => ({
    name: command.name.startsWith("/") ? command.name : `/${command.name}`,
    description: command.description,
  }))
  const servers = mcpServers.map((server) => ({
    name: server.name,
    connected: server.connected,
    on: server.enabled,
    detail: server.connected
      ? `已连接 · ${server.exposure === "direct" ? "工具直接可用" : "工具按需查找"}`
      : "未连接 · 工具按需查找",
  }))
  const skillsEmpty = !ready
    ? "连接主机后显示技能清单"
    : commandsQuery.phase === "loading"
      ? "正在读取技能清单…"
      : commandsQuery.phase === "error"
        ? "技能清单读取失败，可稍后重新打开设置"
        : "尚未发现技能"
  const promptsEmpty = !ready
    ? "连接主机后显示提示词模板"
    : commandsQuery.phase === "loading"
      ? "正在读取提示词模板…"
      : commandsQuery.phase === "error"
        ? "提示词模板读取失败，可稍后重新打开设置"
        : "尚未发现提示词模板"
  const mcpEmpty = !ready
    ? "连接主机后显示 MCP 服务器"
    : mcpQuery.phase === "loading"
      ? "正在读取 MCP 服务器…"
      : mcpQuery.phase === "error"
        ? "MCP 清单读取失败，可稍后重新打开设置"
        : "尚未配置 MCP 服务器"

  return (
    <MobilePageBody page="extensions">
      <MobileGroup label="技能">
        <MobileSwitchRow
          title="技能斜杠命令"
          description="把技能注册成 /skill:名字 命令；关了仍可手动输入调用"
          checked={skillGate === true}
          disabled={writeDisabled || skillGate === null}
          onChange={(checked) => {
            void writer.save("enableSkillCommands", skillCommandsPatch(checked))
          }}
        />
        {skills.length === 0 ? (
          <MobileEmpty title="技能清单" body={skillsEmpty} />
        ) : (
          skills.map((skill) => (
            <MobileRow
              key={skill.name}
              title={
                <>
                  {skill.name}
                  {skill.manualOnly ? <MobileTag>仅手动调用</MobileTag> : null}
                </>
              }
              description={skill.description}
              status="bridge"
            >
              <MobileSwitch label={`${skill.name}（只读）`} checked={skill.on} disabled />
            </MobileRow>
          ))
        )}
        <MobileActionRow title="添加技能" description="从本地文件夹或链接导入" status="bridge" disabled />
      </MobileGroup>

      <MobileGroup label="MCP 服务器">
        {servers.length === 0 ? (
          <MobileEmpty title="MCP 服务器" body={mcpEmpty} />
        ) : (
          servers.map((server) => (
            <MobileRow key={server.name} title={server.name} description={<MobileStatusLine tone={server.connected ? "online" : "offline"}>{server.detail}</MobileStatusLine>} status="bridge">
              <MobileSwitch label={`${server.name}（只读）`} checked={server.on} disabled />
            </MobileRow>
          ))
        )}
        <MobileActionRow title="添加 MCP 服务器" description="填入启动命令或服务器地址" status="bridge" disabled />
      </MobileGroup>

      <MobileGroup label="提示词模板">
        {prompts.length === 0 ? (
          <MobileEmpty title="提示词模板" body={promptsEmpty} />
        ) : (
          prompts.map((prompt) => (
            <MobileRow key={prompt.name} title={prompt.name} description={prompt.description} status="bridge">
              <MobileSwitch label={`${prompt.name}（只读）`} checked disabled />
            </MobileRow>
          ))
        )}
        <MobileActionRow title="添加模板" description="模板文件名就是命令名" status="bridge" disabled />
      </MobileGroup>

      <MobileGroup label="扩展本体" footnote="扩展拥有完整系统权限，只装可信来源。">
        <MobileRow title="pi-remote 远程" description="把本机 pi 会话镜像到浏览器" status="existing">
          <span className="sm-value">内置</span>
        </MobileRow>
        {extensions
          .filter((name) => name !== "pi-remote")
          .map((name) => (
            <MobileRow key={name} title={name} status="bridge">
              <MobileSwitch label={`${name}（只读）`} checked disabled />
            </MobileRow>
          ))}
        {BUILTIN_EXTENSIONS.map((name) => (
          <MobileRow
            key={name}
            title={
              <>
                {name}
                <MobileTag>内置</MobileTag>
              </>
            }
            status="bridge"
          >
            <MobileSwitch label={`${name}（只读）`} checked disabled />
          </MobileRow>
        ))}
        <MobileActionRow title="添加扩展" description="从本地文件或文件夹添加" status="bridge" disabled />
      </MobileGroup>

      <MobileGroup label="Pi 包">
        {packages.length === 0 ? (
          <MobileRow title="尚未安装任何包" description="从 npm、git 或本地文件夹整包安装扩展、技能与模板" status="bridge">
            <MobileSwitch label="Pi 包（只读）" checked={false} disabled />
          </MobileRow>
        ) : (
          packages.map((name) => (
            <MobileRow key={name} title={name} status="bridge">
              <MobileSwitch label={`${name}（只读）`} checked disabled />
            </MobileRow>
          ))
        )}
        <MobileActionRow title="添加包" description="从 npm、git 或本地文件夹整包安装扩展、技能与模板" status="bridge" disabled />
      </MobileGroup>

      <MobileSettingsWriteNote feedback={writer.feedback} fallback={writeHint} />
      <MobileNote>停用的技能与服务器不会出现在会话里。逐条技能 / MCP / 模板 / 扩展的名单写入仍无桥（写桥白名单只有技能总闸），保持只读。</MobileNote>
    </MobilePageBody>
  )
}
