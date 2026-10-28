import { useEffect, useRef, useState } from "react"
import { Check, ChevronRight, Monitor, Moon, Sun } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { PI_UI_VARIANT_LIST } from "@/pi/variants/types"
import { CodexSettingsGroup, CodexSettingsRow, CodexSegmented, CodexSwitch } from "./CodexSettingsGroup"
import { usePiUiCapabilities } from "@/pi/extensions"
import { UsageActivityPage } from "@/pi/usage"
import { MobileNavSetting } from "@/pi/mobile"
import { useCodexCapability } from "../logic/capability"
import { CodexBadge, CodexCapabilityBadge } from "../primitives/CodexCapability"
import { DEFAULT_CUSTOM_THEME, type CodexCustomTheme } from "../logic/customTheme"

const NAV: { group: string; items: string[] }[] = [
  { group: "个人", items: ["外观", "主题自定义", "对话", "通知与声音", "移动端", "使用活动"] },
  { group: "设备与扩展", items: ["设备", "扩展", "技能", "连接"] },
  { group: "运行与权限", items: ["审批策略", "运行位置"] },
  { group: "归档", items: ["归档会话"] },
  { group: "支持", items: ["连接与帮助", "关于"] },
]
const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const
const DENSITY_OPTIONS = [
  { value: "compact", label: "精简" },
  { value: "balanced", label: "平衡" },
  { value: "detailed", label: "详细" },
] as const
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const

/**
 * Codex 设置页（[X-图15] / X-06）：左导航三组 + Appearance 主题三张预览卡（选中 2px 蓝描边）+
 * 「界面」三卡片（data-testid=pi-ui-variant-<id>，点击 act.setPref("ui") 立即换展示树）+
 * 密度/分组/投递等行；呈现 100% 自写，偏好只经 act（不直接读写 localStorage）。
 */
export function CodexSettingsPage({
  p,
  phone = false,
  onOpenLocalPage,
  onOpenPairing,
}: {
  p: VariantAppProps
  phone?: boolean
  onOpenLocalPage?: (page: "plugins" | "prs" | "automations" | "skills" | "connectors") => void
  onOpenPairing?: () => void
}) {
  const { relay, ui, act } = p
  const caps = usePiUiCapabilities()
  const themeCustom = useCodexCapability("theme-custom")
  const permissions = useCodexCapability("permission-tiers")
  const workMode = useCodexCapability("work-mode")
  const extensionRows = caps.list().filter((row) => row.meta.source === "extension")
  // 用户可见文案统一中文口径（能力元数据 label 由契约层提供；设置页展示层做中文映射，避免英文残留）
  const capabilityLabelZh: Record<string, string> = {
    "device-platform-tabs": "设备平台标签", "workspace-modes": "工作模式", "pane-workspace": "窗格工作台", "pane-dock-drag": "窗格拖拽",
    artifacts: "产出物", "browser-pane": "设备端浏览器", "plan-pane": "计划步骤", "side-chat": "侧聊", "subagents-panel": "子 agent 面板",
    "subagent-orchestration": "多代理编排", automations: "计划任务", "pr-review": "代码审查", "git-commit": "提交链路", "git-stage": "暂存操作",
    plugins: "扩展", connectors: "连接", skills: "技能", "permission-tiers": "审批策略", "density-modes": "显示密度", suggestions: "建议词",
    "code-review-comments": "审查评论", "background-tasks": "后台任务", "mcp-tools": "MCP 工具", "context-usage": "上下文用量",
    "model-menu": "模型菜单", "file-editor": "文件编辑", "file-preview": "文件查看", worktree: "隔离副本", "multi-tab": "多标签页",
    "theme-custom": "主题自定义", "session-pin": "会话置顶", "terminal-interactive": "交互式终端", dictation: "听写",
    "work-mode": "运行位置", "workspace-connectors": "连接器卡", "device-code-login": "配对登录", "thread-fork-feedback": "反馈与分叉",
    "session-rail-extra": "侧栏扩展", notifications: "通知规则", "terminal-panes": "多终端",
  }
  const labelOf = (id: string, fallback: string) => capabilityLabelZh[id] ?? fallback
  const [permissionChoice, setPermissionChoice] = useState("default")
  const [workModeChoice, setWorkModeChoice] = useState(workMode.data?.activeModeId ?? "coding")
  const [customTheme, setCustomTheme] = useState<CodexCustomTheme>({ ...DEFAULT_CUSTOM_THEME })
  const prefs = ui.prefs
  const [active, setActive] = useState("外观")
  const sections = useRef(new Map<string, HTMLElement | null>())
  const registerRef = (id: string, el: HTMLElement | null) => sections.current.set(id, el)
  const goTo = (label: string) => setActive(label)
  // 方案 A（P10 §7.2）：使用活动是独立页（导航切换），其余分区沿用滚动定位
  useEffect(() => {
    if (active === "使用活动") return
    const el = sections.current.get(active)
    if (!el) return
    const frame = requestAnimationFrame(() => el.scrollIntoView?.({ block: "start" }))
    return () => cancelAnimationFrame(frame)
  }, [active])
  const [armed, setArmed] = useState(false)
  return (
    <div className="cx-settings" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="page" data-p4-surface="CX-PAGE-01" data-p4-ready="" data-pi-usage-host="codex">
      {phone ? null : (
        <aside className="cx-settings-nav" aria-label="设置导航">
          <div className="cx-settings-nav-head">设置</div>
          {NAV.map((group) => (
            <div className="cx-settings-nav-group" key={group.group}>
              <div className="cx-settings-nav-group-label">{group.group}</div>
              {group.items.map((label) => (
                <button
                  key={label}
                  type="button"
                  className="cx-settings-nav-row"
                  data-active={active === label ? "" : undefined}
                  data-pi-usage-surface={label === "使用活动" ? "P10-USAGE-12-CX" : undefined}
                  onClick={() => goTo(label)}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </aside>
      )}
      <div className="cx-settings-scroll">
        {active === "使用活动" ? (
          <div className="cx-settings-content cx-settings-usage">
            {phone ? (
              <button type="button" className="cx-usage-back" onClick={() => setActive("外观")}>
                <ChevronRight aria-hidden size={13} strokeWidth={1.75} className="cx-usage-back-caret" />
                返回设置
              </button>
            ) : null}
            <section
              data-settings-section="使用活动"
              data-pi-usage-host="codex"
              data-pi-usage-surface="P10-USAGE-12-CX"
              aria-label="使用活动"
            >
              <UsageActivityPage deviceId={relay.selectedDevice?.id} relay={relay} theme={p.theme} />
            </section>
          </div>
        ) : (
          <div className="cx-settings-content">
            {phone ? (
              <button
                type="button"
                className="cx-settings-entry"
                data-pi-usage-surface="P10-USAGE-12-CX"
                onClick={() => setActive("使用活动")}
              >
                <span className="cx-settings-entry-label">使用活动</span>
                <span className="cx-settings-entry-hint">本机会话统计</span>
                <ChevronRight aria-hidden size={14} strokeWidth={1.75} />
              </button>
            ) : null}
            <CodexSettingsGroup title="外观" id="外观" registerRef={registerRef} note="主题跟随时随系统；界面卡片只切换展示样式，不重连、不丢当前会话和草稿。">
            <div className="cx-theme-cards" role="radiogroup" aria-label="主题" data-p4-surface="CX-SHELL-06" data-p4-ready="">
              {THEME_OPTIONS.map((option) => {
                const Icon = THEME_ICON[option.value]
                const on = prefs.theme === option.value
                return (
                  <button key={option.value} type="button" role="radio" aria-checked={on} className="cx-theme-card" data-active={on ? "" : undefined} onClick={() => act.setPref("theme", option.value)}>
                    <span className="cx-theme-preview" data-theme-preview={option.value} aria-hidden>
                      <span className="cx-theme-preview-side" />
                      <span className="cx-theme-preview-main">
                        <span className="cx-theme-preview-line" />
                        <span className="cx-theme-preview-line cx-theme-preview-line-short" />
                        <span className="cx-theme-preview-box" />
                      </span>
                    </span>
                    <span className="cx-theme-card-label">
                      <Icon aria-hidden size={13} strokeWidth={1.5} />
                      {option.label}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="cx-ui-cards" role="radiogroup" aria-label="界面">
              {PI_UI_VARIANT_LIST.map((item) => {
                const on = prefs.ui === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-testid={item.testId}
                    data-ui-variant={item.id}
                    className="cx-ui-card"
                    data-active={on ? "" : undefined}
                    onClick={() => act.setPref("ui", item.id)}
                  >
                    <span className="cx-ui-preview" data-ui-preview={item.id} aria-hidden>
                      <span className="cx-ui-preview-bar" />
                      <span className="cx-ui-preview-body">
                        <span className="cx-ui-preview-side" />
                        <span className="cx-ui-preview-thread" />
                      </span>
                    </span>
                    <span className="cx-ui-card-text">
                      <span className="cx-ui-card-title">
                        {item.label}
                        {on ? <Check aria-hidden size={13} strokeWidth={2} className="cx-ui-card-check" /> : null}
                      </span>
                      <span className="cx-ui-card-desc">{item.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="对话" id="对话" registerRef={registerRef}>
            <CodexSettingsRow label="工具显示密度" hint="精简：读取与查看合并成一行 · 详细：可展开看内容">
              <CodexSegmented value={prefs.density} label="工具显示密度" options={DENSITY_OPTIONS} onChange={(next) => act.setPref("density", next)} />
            </CodexSettingsRow>
            <CodexSettingsRow label="忙时默认投递" hint="运行中再发消息：插入当前回合 / 等这轮结束">
              <CodexSegmented
                value={prefs.delivery}
                label="忙时默认投递"
                options={[
                  { value: "steer", label: "插入当前回合" },
                  { value: "follow_up", label: "等这轮结束" },
                ]}
                onChange={(next) => act.setPref("delivery", next)}
              />
            </CodexSettingsRow>
            <CodexSettingsRow label="会话列表分组" hint="按设备与目录分组 / 平铺">
              <CodexSegmented
                value={prefs.grouping}
                label="会话列表分组"
                options={[
                  { value: "device", label: "按设备" },
                  { value: "flat", label: "平铺" },
                ]}
                onChange={(next) => act.setPref("grouping", next)}
              />
            </CodexSettingsRow>
            <CodexSettingsRow label="字体大小" hint="界面字号（本版固定标准）">
              <span className="cx-set-value">标准</span>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="通知与声音" id="通知与声音" registerRef={registerRef} note="提示音与网页回答确认框由电脑端设置接管。这里的开关只读。">
            <CodexSettingsRow label="回合结束提示音" hint="在电脑端设置里调整（网页端只读）">
              <span className="cx-set-value">{prefs.completionSound ? "开" : "关"}</span>
            </CodexSettingsRow>
            <CodexSettingsRow label="网页回答确认框" hint="在电脑端设置里调整（P9 A 的审批卡仍可远程回答）">
              <span className="cx-set-value">{prefs.dialogRemoteAnswer ? "开" : "关"}</span>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="移动端" id="移动端" registerRef={registerRef} note="仅影响移动端断点；桌面端呈现不变。">
            <div className="cx-settings-mobile-nav">
              <MobileNavSetting value={prefs.mobileNav} onChange={(mode) => act.setPref("mobileNav", mode)} />
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="设备" id="设备" registerRef={registerRef} note="配对新设备会打开电脑端配对流程；配对后这台浏览器会连上你的 relay。">
            <CodexSettingsRow label="配对新设备…" hint="在电脑上运行 attach，或生成一次性配对码">
              <button type="button" className="cx-set-action" data-p4-action="settings-pair-device" disabled={!onOpenPairing} onClick={onOpenPairing}>
                配对
              </button>
            </CodexSettingsRow>
            {relay.devices.length === 0 ? <CodexSettingsRow label="还没有设备" hint="在电脑上运行 deploy/attach.sh 打开连接窗口" /> : null}
            {relay.devices.map((device) => (
              <CodexSettingsRow key={device.id} label={device.name} hint={`${device.online ? "在线" : "未连接"}${device.id === relay.selectedDeviceId ? " · 当前设备" : ""}`}>
                <span className="cx-set-dot" data-online={device.online ? "" : undefined} aria-hidden />
              </CodexSettingsRow>
            ))}
          </CodexSettingsGroup>
          <CodexSettingsGroup title="连接与帮助" id="连接与帮助" registerRef={registerRef}>
            <CodexSettingsRow label="服务器" hint={relay.online ? "已连接" : "已断开"}>
              <span className="cx-set-value">{typeof window === "undefined" ? "—" : window.location.host || "—"}</span>
            </CodexSettingsRow>
            <CodexSettingsRow label="服务端协议" hint={relay.serverProto != null ? `v${relay.serverProto}` : "—"}>
              <span className="cx-set-value">{relay.serverCaps.length > 0 ? `${relay.serverCaps.length} 项能力` : "—"}</span>
            </CodexSettingsRow>
            <CodexSettingsRow label="重新连接" hint="立刻重连 relay">
              <button type="button" className="cx-set-action" onClick={() => relay.reconnectNow()}>
                重连
              </button>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="关于" id="关于" registerRef={registerRef} note="这些设置只保存在这个浏览器里。">
            <CodexSettingsRow label="Pi-Remote" hint="pi 多端同步 · Codex 界面变体">
              <span className="cx-set-value">codex</span>
            </CodexSettingsRow>
            <CodexSettingsRow label={armed ? "再点一次退出登录" : "退出登录"} hint="清掉这个浏览器里保存的 token" danger>
              <button
                type="button"
                className="cx-set-action cx-set-action-danger"
                onClick={() => {
                  if (!armed) {
                    setArmed(true)
                    window.setTimeout(() => setArmed(false), 3000)
                    return
                  }
                  setArmed(false)
                  relay.logout()
                }}
              >
                {armed ? "确认退出" : "退出"}
              </button>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="主题自定义" id="主题自定义" registerRef={registerRef} note="主题自定义（表面色 / 强调色 / 字体 / 半透明侧栏）需要扩展接入。">
            <div className="cx-theme-custom" data-p4-surface="CX-PAGE-02" data-capability-state={themeCustom.status} data-p4-ready="">
              <div className="cx-theme-custom-head">
                <span className="cx-set-row-label">强调色 / 背景色 / 前景色</span>
                <CodexCapabilityBadge label={themeCustom.simulated ? "模拟演示" : "可接入"} view={themeCustom.view} />
              </div>
              <div className="cx-theme-swatches">
                {(["accent", "background", "foreground"] as const).map((key) => (
                  <label className="cx-theme-swatch" key={key}>
                    <span>{key}</span>
                    <input
                      type="color"
                      value={customTheme[key]}
                      disabled={!themeCustom.interactive}
                      aria-label={`主题颜色 ${key}`}
                      data-p4-action={`theme-${key}`}
                      onChange={(event) => {
                        const value = event.target.value
                        setCustomTheme((cur) => ({ ...cur, [key]: value }))
                        themeCustom.actions?.applyTheme?.({ [key]: value })
                      }}
                    />
                    <code>{customTheme[key]}</code>
                  </label>
                ))}
              </div>
              <div className="cx-theme-custom-actions">
                <button type="button" className="cx-set-action" disabled={!themeCustom.interactive} data-p4-action="theme-import" onClick={() => themeCustom.actions?.applyTheme?.({ importedFrom: "theme.json" } as never)}>
                  导入主题…
                </button>
                <button type="button" className="cx-set-action" disabled={!themeCustom.interactive} data-p4-action="theme-copy" onClick={() => relay.notify("已复制当前主题 JSON（模拟演示）")}>
                  复制主题
                </button>
                <button type="button" className="cx-set-action" disabled={!themeCustom.interactive} data-p4-action="theme-reset" onClick={() => themeCustom.actions?.resetTheme?.()}>
                  重置
                </button>
              </div>
              <p className="cx-run-hint">{themeCustom.view ? `${themeCustom.view.reason}（见 ${themeCustom.view.docsPath}）` : "已接入 theme-custom provider。"}</p>
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="扩展" id="扩展" registerRef={registerRef} note="扩展注册的能力与状态；禁用项接入扩展后即时解锁（无需刷新）。">
            <div className="cx-ext-settings" data-p4-surface="CX-PAGE-09" data-p4-ready="">
              {extensionRows.length === 0 ? <CodexSettingsRow label="还没有扩展能力" hint="接入 @/pi/extensions provider 后出现在这里" /> : null}
              {extensionRows.map((row) => (
                <CodexSettingsRow key={row.capability} label={labelOf(row.capability, row.meta.label)} hint={`${row.meta.description} · ${row.meta.docAnchor}`}>
                  <span className="cx-ext-status" data-status={row.status}>{row.status === "available" ? "可用" : row.status === "simulated" ? "模拟演示" : "未接入"}</span>
                </CodexSettingsRow>
              ))}
              <CodexSettingsRow label="插件 / PRs / 自动化页面" hint="这些页面入口在侧栏；能力状态同上">
                <span className="cx-set-actions">
                  <button type="button" className="cx-set-action" onClick={() => onOpenLocalPage?.("plugins")}>扩展</button>
                  <button type="button" className="cx-set-action" onClick={() => onOpenLocalPage?.("prs")}>代码审查</button>
                  <button type="button" className="cx-set-action" onClick={() => onOpenLocalPage?.("automations")}>计划任务</button>
                </span>
              </CodexSettingsRow>
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="技能" id="技能" registerRef={registerRef} note="可复用技能包（浏览 / 启停 / 调用）需要扩展接入。">
            <CodexSettingsRow label="技能管理页" hint={caps.statusOf("skills") === "simulated" ? "模拟演示数据可用" : "本机 pi 未提供 skills 能力"}>
              <span className="cx-set-actions">
                <CodexBadge tone={caps.statusOf("skills") === "available" ? "ok" : "neutral"}>{caps.statusOf("skills") === "available" ? "可用" : caps.statusOf("skills") === "simulated" ? "模拟演示" : "未接入"}</CodexBadge>
                <button type="button" className="cx-set-action" onClick={() => onOpenLocalPage?.("skills")}>打开</button>
              </span>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="连接" id="连接" registerRef={registerRef} note="外部服务连接需要扩展接入。">
            <CodexSettingsRow label="外部连接" hint={caps.statusOf("connectors") === "simulated" ? "模拟演示数据可用" : "本机 pi 未提供连接器能力"}>
              <span className="cx-set-actions">
                <CodexBadge tone={caps.statusOf("connectors") === "available" ? "ok" : "neutral"}>{caps.statusOf("connectors") === "available" ? "可用" : caps.statusOf("connectors") === "simulated" ? "模拟演示" : "未接入"}</CodexBadge>
                <button type="button" className="cx-set-action" onClick={() => onOpenLocalPage?.("connectors")}>打开</button>
              </span>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="审批策略" id="审批策略" registerRef={registerRef} note="审批策略（默认 / 自动审查 / 完全访问）需要扩展接入；Pi 当前按审批卡逐次确认。">
            <div data-p4-surface="CX-PAGE-04" data-capability-state={permissions.status} data-p4-ready="">
              {[
                { id: "default", label: "默认（逐次确认）", hint: "每次敏感动作都弹审批卡" },
                { id: "auto", label: "自动审查", hint: "低风险动作自动通过，高风险仍审批" },
                { id: "full", label: "完全访问", hint: "全部放行（仅本机显示，扩展记录）" },
              ].map((row) => (
                <CodexSettingsRow key={row.id} label={row.label} hint={row.hint}>
                  <CodexSwitch
                    on={permissionChoice === row.id}
                    label={`权限档位 ${row.label}`}
                    stage={!permissions.interactive}
                    onToggle={() => {
                      if (!permissions.interactive) {
                        relay.notify(`权限档位需要 permission-tiers 扩展：${permissions.view?.reason ?? "未接入"}（见 ${permissions.view?.docsPath ?? "扩展接入文档"}）`, "warn")
                        return
                      }
                      setPermissionChoice(row.id)
                      permissions.actions?.selectTier?.(row.id)
                    }}
                  />
                </CodexSettingsRow>
              ))}
              <p className="cx-run-hint">{permissions.view ? `${permissions.view.reason}（见 ${permissions.view.docsPath}）` : ""}</p>
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="运行位置" id="运行位置" registerRef={registerRef} note="设置默认运行位置：当前设备 / 指定文件夹 / 远端设备。">
            <div className="cx-workmode-cards" data-p4-surface="CX-PAGE-03" data-capability-state={workMode.status} data-p4-ready="">
              {[
                { id: "coding", title: "编码场景", desc: "默认在本机设备 + 项目目录开线程", mode: "当前设备" },
                { id: "chatting", title: "聊天场景", desc: "默认远端在线设备（若无则本机）", mode: "远端设备" },
              ].map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="cx-workmode-card"
                  data-active={workModeChoice === card.id ? "" : undefined}
                  data-p4-action={`workmode-${card.id}`}
                  onClick={() => {
                    setWorkModeChoice(card.id)
                    workMode.actions?.selectWorkMode?.(card.id)
                  }}
                >
                  <span className="cx-workmode-title">{card.title}</span>
                  <span className="cx-workmode-desc">{card.desc}</span>
                  <span className="cx-workmode-mode">运行位置默认：{card.mode}</span>
                </button>
              ))}
            </div>
          </CodexSettingsGroup>
          <CodexSettingsGroup title="归档会话" id="归档会话" registerRef={registerRef} note="归档 / 恢复会话需要 session-archive 能力；当前 pi 的归档由电脑端会话列表管理。">
            <CodexSettingsRow label="归档会话" hint={`已加载 ${Object.values(relay.sessionsByDevice).flat().length} 个会话；归档状态由电脑端保存`}>
              <CodexBadge>{caps.statusOf("session-pin") === "simulated" ? "模拟演示" : "只读"}</CodexBadge>
            </CodexSettingsRow>
          </CodexSettingsGroup>
          </div>
        )}
      </div>
    </div>
  )
}
