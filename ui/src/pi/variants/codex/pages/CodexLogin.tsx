import { useState } from "react"
import { useCodexCapability } from "../logic/capability"
import { CodexCapabilityBadge, CodexDisabledNote } from "../primitives/CodexCapability"
import { attachCommand, formatPairCode } from "@/relay/devices"
import type { VariantAppProps } from "@/pi/variants/types"
import { relayHostOf } from "../logic/view"
import { CodexMark } from "../primitives/primitives"

/**
 * Codex 登录页（CX-PAGE-10/11 / [X-图14] / X-12）：
 * - token 登录是 Pi-Remote 真实入口（访问令牌）；
 * - 「用配对码连接」映射 Pi 配对流程：生成一次性配对码 + 在设备上运行 attach 命令（不照搬 OAuth 设备码页）。
 * 生产无扩展时配对入口禁用并解释；dev/mock 下可生成配对码并复制命令。
 */
export function CodexLogin({ relay, layout }: VariantAppProps) {
  const phone = layout === "phone"
  const host = relayHostOf(import.meta.env.VITE_RELAY_URL, location)
  const [value, setValue] = useState("")
  const [form, setForm] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [pairPlatform, setPairPlatform] = useState<"mac" | "windows">("mac")
  const deviceCap = useCodexCapability("device-code-login")
  const login = deviceCap.data?.login ?? null
  const canSubmit = value.trim().length > 0
  const pairCommand = `${attachCommand(pairPlatform)} --pair ${login?.code ? formatPairCode(login.code) : ""}`
  return (
    <div className="cx-login" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="page" data-p4-surface="CX-PAGE-10" data-p4-ready="">
      <div className="cx-login-card">
        <div className="cx-login-brand">
          <CodexMark size={phone ? 26 : 30} />
          <span className="cx-login-wordmark">Pi-Remote</span>
        </div>
        {form ? (
          <>
            <label className="cx-login-label" htmlFor="cx-login-token">
              访问令牌
            </label>
            <input
              id="cx-login-token"
              className="cx-login-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴访问令牌"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) relay.login(value)
              }}
            />
            {relay.authError ? (
              <p role="alert" className="cx-login-error">
                {relay.authError}，已清除这个浏览器里保存的令牌
              </p>
            ) : null}
            <button type="button" className="cx-login-primary" disabled={!canSubmit} onClick={() => relay.login(value)}>
              连接
            </button>
            <button type="button" className="cx-login-link" onClick={() => setForm(false)}>
              返回
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cx-login-primary" onClick={() => setForm(true)}>
              连接 Pi-Remote
            </button>
            <button
              type="button"
              className="cx-login-link cx-login-link-muted"
              data-p4-action="pair-device-login"
              onClick={() => {
                if (!deviceCap.interactive) {
                  relay.notify(`配对码连接需要扩展接入：${deviceCap.view?.reason ?? "本机 pi 未提供"}${deviceCap.view ? `（见 ${deviceCap.view.docsPath}）` : ""}`, "warn")
                  return
                }
                deviceCap.actions?.startDeviceCodeLogin?.()
                setPairOpen(true)
              }}
            >
              用配对码连接
            </button>
            {pairOpen ? (
              <div className="cx-device-code" data-p4-surface="CX-PAGE-11" data-capability-state={deviceCap.status} data-p4-ready="">
                <div className="cx-device-code-head">
                  <span>设备配对码</span>
                  <CodexCapabilityBadge label={deviceCap.simulated ? "模拟演示" : "可接入"} view={deviceCap.view} />
                </div>
                <div className="cx-device-code-value">{login?.code ? formatPairCode(login.code) : "生成中…"}</div>
                <div className="cx-pair-platforms" role="tablist" aria-label="接入平台">
                  {(["mac", "windows"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={pairPlatform === key}
                      className="cx-seg-btn"
                      data-active={pairPlatform === key ? "" : undefined}
                      onClick={() => setPairPlatform(key)}
                    >
                      {key === "mac" ? "macOS / Linux" : "Windows"}
                    </button>
                  ))}
                </div>
                <p className="cx-device-code-hint">在要接入的电脑上运行下面的命令（配对码一次性有效）：</p>
                <button
                  type="button"
                  className="cx-pair-command"
                  data-p4-action="copy-pair-command"
                  onClick={() => {
                    void navigator.clipboard.writeText(pairCommand).catch(() => undefined)
                    relay.notify("已复制配对命令")
                  }}
                >
                  <code>{pairCommand}</code>
                </button>
                <div className="cx-dialog-actions-inline">
                  <button
                    type="button"
                    className="cx-login-link"
                    onClick={() => {
                      deviceCap.actions?.cancel?.()
                      setPairOpen(false)
                    }}
                  >
                    取消
                  </button>
                </div>
                <CodexDisabledNote>配对码由本机 pi 生成；接入扩展后这里可直接复制命令。</CodexDisabledNote>
              </div>
            ) : null}
          </>
        )}
        <p className="cx-login-foot">连接到你的 relay · {host}</p>
      </div>
    </div>
  )
}
