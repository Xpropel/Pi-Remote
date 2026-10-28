import { useEffect, useState } from "react"
import type { PiContainerProps } from "@/pi/containers/types"
import { PI_UI_VARIANT_LIST, type PiUiVariant } from "../../types"
import { settingsPrefsFor, writePrefs } from "../model/logic"
import { usePiUiCapabilities } from "@/pi/extensions"
import { UsageActivityPage } from "@/pi/usage"
import { MobileNavSetting } from "@/pi/mobile"
import { linkSummaryOf } from "../model/view"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import { ClaudeButton, ClaudeCard, ClaudeRow, ClaudeSegment, ClaudeSwitch } from "../primitives/ClaudePrimitives"
import { formatDate } from "../model/format"
import { useNow } from "../primitives/useClaude"

/**
 * Claude v2 自有设置页（C-06：外观 › 界面三张卡片（现有 / Claude / Codex）+ 主题/密度/分组 + 衬线分组标题 + 8/10 圆角行）。
 * 读写口径复用 @/pi/model/settingsView 纯函数（新偏好键 + 旧键三项 + relay.sendMode）；界面切换用 act.setUiVariant。
 */

const SECTIONS = [
  { id: "appearance", label: "外观" },
  { id: "conversation", label: "对话" },
  { id: "notify", label: "通知与声音" },
  { id: "mobile", label: "移动端" },
  { id: "devices", label: "设备" },
  { id: "usage", label: "使用活动" },
  { id: "about", label: "关于" },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

export function ClaudeSettingsPage({ p }: { p: PiContainerProps }) {
  const { relay, act } = p
  const prefs = settingsPrefsFor(p)
  const caps = usePiUiCapabilities()
  const now = useNow(60_000)
  const [section, setSection] = useState<SectionId>("appearance")
  const [armed, setArmed] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(timer)
  }, [armed])
  const write = (patch: Parameters<typeof writePrefs>[1]) => writePrefs(p, patch)
  const link = linkSummaryOf(relay)
  const phone = p.variant === "phone"
  const content = (
    <div className="claude-settings">
      {phone ? null : (
        <nav className="claude-settings-nav" aria-label="设置分类">
          <h1 className="claude-settings-h">设置</h1>
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" className="claude-settings-navitem" data-active={section === item.id ? "" : undefined} onClick={() => setSection(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <div className="claude-settings-main">
        {phone ? (
          <div className="claude-settings-mobiletabs">
            {SECTIONS.map((item) => (
              <button key={item.id} type="button" className="claude-chip" data-active={section === item.id ? "" : undefined} onClick={() => setSection(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {section === "mobile" ? (
          <ClaudeCard title="移动端">
            <p className="claude-settings-note">仅影响移动端断点（≤767px）；桌面端呈现不变。切换后立即生效并跨设备跟随账号。</p>
            <div className="claude-settings-mobile-nav">
              <MobileNavSetting value={p.ui.prefs.mobileNav} onChange={(mode) => p.act.setPref("mobileNav", mode)} />
            </div>
          </ClaudeCard>
        ) : null}
        {section === "usage" ? (
          <div data-pi-usage-host="claude">
            <UsageActivityPage relay={relay} deviceId={relay.selectedDeviceId ?? undefined} />
          </div>
        ) : null}
        {section === "appearance" ? (
          <>
            <section className="claude-settings-section">
              <h2 className="claude-settings-sectiontitle">界面</h2>
              <p className="claude-settings-note">三套设计各自独立；选中立即切换，不重连、不丢当前会话和草稿。</p>
              <div className="claude-variant-cards" role="radiogroup" aria-label="界面">
                {PI_UI_VARIANT_LIST.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={prefs.ui === item.id}
                    data-testid={item.testId}
                    data-ui-variant={item.id}
                    className="claude-variant-card"
                    data-active={prefs.ui === item.id ? "" : undefined}
                    onClick={() => act.setUiVariant(item.id as PiUiVariant)}
                  >
                    <span className="claude-variant-card-title">{item.label}</span>
                    <span className="claude-variant-card-desc">{item.description}</span>
                  </button>
                ))}
              </div>
            </section>
            <ClaudeCard title="主题">
              <ClaudeRow
                label="外观主题"
                hint="跟随系统时，浅色 / 深色随电脑或手机的设置切换"
                control={
                  <ClaudeSegment
                    label="主题"
                    value={prefs.theme}
                    options={[
                      { value: "system", label: "跟随系统" },
                      { value: "light", label: "浅色" },
                      { value: "dark", label: "深色" },
                    ]}
                    onChange={(value) => write({ theme: value })}
                  />
                }
              />
            </ClaudeCard>
            <ClaudeCard title="密度">
              <ClaudeRow
                label="工具显示"
                hint="精简：读取和查看合并成一行；平衡：读取一行、命令是终端卡、改动是 diff 卡"
                control={
                  <ClaudeSegment
                    label="工具显示"
                    value={prefs.density}
                    options={[
                      { value: "compact", label: "精简" },
                      { value: "balanced", label: "平衡" },
                      { value: "detailed", label: "详细" },
                    ]}
                    onChange={(value) => write({ density: value })}
                  />
                }
              />
              <ClaudeRow
                label="会话分组"
                hint="按设备与目录分组，或平铺按最近活动排序"
                control={
                  <ClaudeSegment
                    label="会话分组"
                    value={prefs.grouping}
                    options={[
                      { value: "device", label: "按设备" },
                      { value: "flat", label: "平铺" },
                    ]}
                    onChange={(value) => write({ grouping: value })}
                  />
                }
              />
            </ClaudeCard>
          </>
        ) : null}

        {section === "conversation" ? (
          <ClaudeCard title="对话">
            <ClaudeRow
              label="pi 忙的时候发消息"
              hint="默认的投递方式；输入框下面也能临时改"
              control={
                <ClaudeSegment
                  label="忙时投递"
                  value={prefs.busyDelivery}
                  options={[
                    { value: "steer", label: "插入当前回合" },
                    { value: "follow_up", label: "排队到下一回合" },
                  ]}
                  onChange={(value) => write({ busyDelivery: value })}
                />
              }
            />
            <ClaudeRow label="在网页上回答电脑上的确认框" hint="关掉后，确认框只能在电脑终端里回答" control={<ClaudeSwitch label="在网页上回答电脑上的确认框" checked={prefs.dialogRemote} onChange={(next) => write({ dialogRemote: next })} />} />
          </ClaudeCard>
        ) : null}

        {section === "notify" ? (
          <ClaudeCard title="完成提示音">
            <ClaudeRow label="回合结束或出错时响一声" hint="页面在前台时不响" control={<ClaudeSwitch label="完成提示音" checked={prefs.sound} onChange={(next) => write({ sound: next })} />} />
          </ClaudeCard>
        ) : null}

        {section === "devices" ? (
          <ClaudeCard title="设备" action={<ClaudeButton kind="outline" className="claude-btn-sm" onClick={() => act.openDialog({ id: CLAUDE_OVERLAY.pairing })}>配对新设备…</ClaudeButton>}>
            {relay.devices.length === 0 ? <p className="claude-settings-note">还没有设备。配对新设备后，会话会出现在侧栏。</p> : null}
            {relay.devices.map((device) => (
              <ClaudeRow
                key={device.id}
                label={device.name}
                hint={`${device.platform} · ${device.online ? "在线" : "未连接"}${device.paired ? " · 已配对" : ""}${device.windowExpiresAt ? ` · 窗口剩余 ${Math.max(0, Math.ceil(((device.windowExpiresAt ?? 0) - now) / 3600000))}h` : ""}`}
                control={
                  <button type="button" className="claude-link-btn" onClick={() => act.openDialog({ id: CLAUDE_OVERLAY.pairing })}>
                    管理
                  </button>
                }
              />
            ))}
          </ClaudeCard>
        ) : null}

        {section === "appearance" ? (
          <ClaudeCard title="扩展能力">
            {caps.list().slice(0, 40).map((item) => (
              <ClaudeRow
                key={item.capability}
                label={item.meta.label}
                hint={item.status === "available" ? "已接入" : item.status === "simulated" ? "模拟演示 · 非真实" : `${item.meta.unavailableReason}（扩展接入文档 ${item.meta.docAnchor}）`}
                control={<span data-pi-capability={item.capability} data-capability-state={item.status}>{item.status}</span>}
              />
            ))}
          </ClaudeCard>
        ) : null}
        {section === "about" ? (
          <>
            <ClaudeCard title="连接">
              <ClaudeRow label="服务器" hint={link.text} control={<span className="claude-settings-mono">{relay.serverProto ? `协议 v${relay.serverProto}` : "旧协议"}</span>} />
              <ClaudeRow label="重新连接" hint="立即重试一次，不等退避" control={<ClaudeButton kind="outline" className="claude-btn-sm" onClick={relay.reconnectNow}>重新连接</ClaudeButton>} />
            </ClaudeCard>
            <ClaudeCard title="关于">
              <ClaudeRow label="Pi-Remote" hint={`这些设置只保存在这个浏览器里。当前界面：Claude v2`} control={<span className="claude-settings-mono">{formatDate(now, now)}</span>} />
              <ClaudeRow
                label="退出登录"
                hint={armed ? "再点一次确认退出" : "清除这个浏览器里保存的 token"}
                onClick={() => {
                  if (!armed) {
                    setArmed(true)
                    return
                  }
                  setArmed(false)
                  relay.logout()
                }}
                control={null}
              />
            </ClaudeCard>
          </>
        ) : null}
      </div>
    </div>
  )
  void deviceOpen
  void setDeviceOpen
  return content
}
