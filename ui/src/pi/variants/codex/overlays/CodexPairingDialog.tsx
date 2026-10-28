import { useEffect, useRef, useState } from "react"
import { Copy } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import {
  ADMIN_TOKEN_COPY,
  adminTokenErrorText,
  adminTokenReady,
  attachCommand,
  canRevoke,
  COPY,
  deviceErrorText,
  formatPairCode,
  pairCommands,
} from "@/relay/devices"
import { useNow } from "../hooks/useCodex"
import { CodexButton, CodexDialog, CodexSpinner } from "../primitives/primitives"
import { piClock } from "../logic/view"

/**
 * 设备与配对（[X-图14] 设备码页 / X-12 语言）：管理员令牌本机保存（relay.adminToken，不落日志）→ 生成配对码（pair_create）
 * → 倒计时 + attach 命令复制；已登记设备可撤销（点两次）。行为复用 @/relay/devices 的口径与 relay 动作，呈现自写。
 */
export function CodexPairingDialog({ p, onClose }: { p: VariantAppProps; onClose: () => void }) {
  const { relay } = p
  const now = useNow(1000)
  const [editing, setEditing] = useState(!adminTokenReady(relay.adminToken))
  const [draft, setDraft] = useState(relay.adminToken)
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [platform, setPlatform] = useState<"unix" | "windows">("unix")
  const [armed, setArmed] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const saved = adminTokenReady(relay.adminToken)
  const ready = saved && !editing
  const generate = async () => {
    if (creating || !ready) return
    setCreating(true)
    setError(null)
    try {
      const next = await relay.createPairCode(relay.adminToken)
      if (alive.current) setPair(next)
    } catch (e) {
      if (alive.current) setError(adminTokenErrorText(e))
    } finally {
      if (alive.current) setCreating(false)
    }
  }
  const revoke = async (deviceId: string) => {
    if (armed !== deviceId) {
      setArmed(deviceId)
      window.setTimeout(() => setArmed(null), 3000)
      return
    }
    setArmed(null)
    try {
      await relay.revokeDevice(deviceId, relay.adminToken)
      relay.pushNotice({ level: "success", title: "已撤销这台设备" })
    } catch (e) {
      relay.pushNotice({ level: "error", title: `撤销失败：${deviceErrorText(e)}` })
    }
  }
  const commands = pair ? pairCommands(pair.code) : []
  const shown = pair ? formatPairCode(pair.code) : null
  const remaining = pair ? pair.expiresAt - now : 0
  return (
    <CodexDialog
      title="设备与配对"
      onClose={onClose}
      width={560}
      footer={
        <CodexButton kind="primary" onClick={onClose}>
          完成
        </CodexButton>
      }
    >
      {!relay.canManageDevices ? (
        <p className="cx-dialog-text">当前服务端还不支持设备配对和撤销（需要协议 v4）。在要接入的电脑上运行 deploy/attach.sh（Windows：deploy\attach.cmd）打开连接窗口。</p>
      ) : editing || !ready ? (
        <div className="cx-field-group">
          <label className="cx-field">
            <span className="cx-field-label">{ADMIN_TOKEN_COPY.label}</span>
            <input
              className="cx-field-input"
              type="password"
              autoComplete="off"
              placeholder="relay 管理员令牌（只保存在这个浏览器）"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <p className="cx-field-hint">{ADMIN_TOKEN_COPY.hint}</p>
          <div className="cx-dialog-actions-inline">
            <CodexButton
              kind="primary"
              disabled={!draft.trim()}
              onClick={() => {
                relay.setAdminToken(draft.trim())
                setEditing(false)
              }}
            >
              保存
            </CodexButton>
            {saved ? (
              <CodexButton kind="ghost" onClick={() => setEditing(false)}>
                取消
              </CodexButton>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="cx-pair">
          {pair && shown ? (
            <div className="cx-pair-code">
              <div className="cx-pair-code-value">{shown}</div>
              <div className="cx-pair-code-note">{remaining > 0 ? `${piClock(remaining)} 后过期` : "已过期"}</div>
              <div className="cx-pair-platforms" role="tablist">
                {(["unix", "windows"] as const).map((key) => (
                  <button key={key} type="button" role="tab" aria-selected={platform === key} className="cx-seg-btn" data-active={platform === key ? "" : undefined} onClick={() => setPlatform(key)}>
                    {key === "unix" ? "macOS / Linux" : "Windows"}
                  </button>
                ))}
              </div>
              <div className="cx-pair-command">
                <code>{attachCommand(platform === "windows" ? "windows" : "mac")} --pair {shown}</code>
                <button type="button" className="cx-icon-btn" aria-label="复制配对命令" onClick={() => void navigator.clipboard.writeText(commandOf(commands, platform)).catch(() => undefined)}>
                  <Copy aria-hidden size={13} strokeWidth={1.5} />
                </button>
              </div>
              <p className="cx-field-hint">{COPY.pairHint}</p>
              <div className="cx-dialog-actions-inline">
                <CodexButton kind="outline" onClick={() => void generate()}>
                  重新生成
                </CodexButton>
              </div>
            </div>
          ) : (
            <div className="cx-pair-empty">
              <p className="cx-dialog-text">{COPY.pairHint}</p>
              <CodexButton kind="primary" disabled={creating} onClick={() => void generate()}>
                {creating ? <CodexSpinner size={12} /> : null}
                生成配对码
              </CodexButton>
            </div>
          )}
          {error ? (
            <p role="alert" className="cx-dialog-error">
              {error}
            </p>
          ) : null}
          <div className="cx-pair-devices">
            <div className="cx-pair-devices-head">已登记的设备</div>
            {relay.devices.length === 0 ? <p className="cx-field-hint">还没有设备</p> : null}
            {relay.devices.map((device) => (
              <div className="cx-pair-device" key={device.id}>
                <span className="cx-pair-device-name">{device.name}</span>
                <span className="cx-pair-device-sub">{device.online ? "在线" : "未连接"}</span>
                {canRevoke(device) ? (
                  <button type="button" className="cx-pair-revoke" onClick={() => void revoke(device.id)}>
                    {armed === device.id ? "确认撤销" : "撤销"}
                  </button>
                ) : null}
              </div>
            ))}
            <p className="cx-field-hint">{COPY.revokeExplain}</p>
          </div>
          <button type="button" className="cx-inline-link" onClick={() => setEditing(true)}>
            更换管理员令牌
          </button>
        </div>
      )}
    </CodexDialog>
  )
}

function commandOf(commands: readonly { platform: "windows" | "unix"; command: string }[], platform: "unix" | "windows"): string {
  return commands.find((c) => c.platform === platform)?.command ?? ""
}
