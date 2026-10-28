import { useEffect, useRef, useState } from "react"
import type { PiContainerProps } from "@/pi/containers/types"
import { ADMIN_TOKEN_COPY, adminTokenErrorText, adminTokenReady, canRevoke, COPY, newlyPaired, pairBaseline } from "@/relay/devices"
import type { Device } from "@/relay/devices"
import { ClaudeBadge, ClaudeButton, ClaudeCopyField, ClaudeDialog, ClaudeField, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { useNow } from "../primitives/useClaude"
import { CLAUDE_OVERLAY } from "./ids"

/**
 * Claude v2 自有设备配对（删除/改名之外的 a 线浮层）：配对码生成 + 倒计时 + 设备撤销（两次确认）+ 管理员令牌。
 * 交互逻辑移植自产品口径（relay.createPairCode / revokeDevice / setAdminToken / canManageDevices），渲染与文案排版全部自有。
 */

type Pair = { code: string; expiresAt: number; baseline: Record<string, boolean> }

function formatPairCode(code: string): string {
  const clean = code.replace(/\s+/g, "")
  return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean
}

function remainText(expiresAt: number, now: number): string {
  const left = Math.max(0, expiresAt - now)
  const m = Math.floor(left / 60000)
  const s = Math.floor((left % 60000) / 1000)
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

const ATTACH_COMMAND = {
  unix: "cd <pi-remote 仓库> && ./deploy/attach.sh",
  windows: "cd <pi-remote 仓库>\\deploy && attach.cmd",
}

export function ClaudePairingDialog({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const desktopOpen = ui.dialog?.id === CLAUDE_OVERLAY.pairing
  const sheetOpen = ui.sheet?.id === CLAUDE_OVERLAY.pairing
  const open = desktopOpen || sheetOpen
  const close = () => (sheetOpen ? act.closeSheet() : act.closeDialog())
  const now = useNow(1000)
  const [pair, setPair] = useState<Pair | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [armed, setArmed] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [platform, setPlatform] = useState<"unix" | "windows">("unix")
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!open) {
      // 关闭时同步清空这次打开的状态（React 文档允许的“派生状态重置”写法）
      // eslint-disable-next-line react/set-state-in-effect
      setPair(null)
      setError(null)
      setArmed(null)
    }
  }, [open])
  if (!open) return null

  const saved = adminTokenReady(relay.adminToken)
  const ready = saved && !editing
  const devices: Device[] = [...relay.devices].sort((a, b) => (a.online === b.online ? (a.firstSeenAt ?? a.lastAttachAt ?? 0) - (b.firstSeenAt ?? b.lastAttachAt ?? 0) : a.online ? -1 : 1))
  const paired = pair ? newlyPaired(pair.baseline, devices) : null
  const expired = pair != null && pair.expiresAt <= now

  const generate = async () => {
    if (creating || !ready) return
    setCreating(true)
    setError(null)
    const baseline = pairBaseline(devices)
    try {
      const next = await relay.createPairCode(relay.adminToken)
      if (alive.current) setPair({ ...next, baseline })
    } catch (e) {
      if (alive.current) setError(adminTokenErrorText(e))
    } finally {
      if (alive.current) setCreating(false)
    }
  }
  const revoke = async (deviceId: string, name: string) => {
    if (revoking || !ready) return
    if (armed !== deviceId) {
      setArmed(deviceId)
      return
    }
    setRevoking(deviceId)
    setError(null)
    try {
      await relay.revokeDevice(deviceId, relay.adminToken)
      relay.pushNotice({ level: "success", title: `已撤销「${name}」，它要重新配对才能再连` })
      if (alive.current) setArmed(null)
    } catch (e) {
      if (alive.current) setError(adminTokenErrorText(e))
    } finally {
      if (alive.current) setRevoking(null)
    }
  }

  const body = (
    <div className="claude-pairing">
      {!relay.canManageDevices ? (
        <p className="claude-dialog-text">当前服务端还不支持设备配对和撤销（需要协议 v4）。在要接入的电脑上运行下面的命令打开连接窗口。</p>
      ) : (
        <>
          <section className="claude-pairing-section">
            <h3 className="claude-pairing-title">生成配对码</h3>
            {!saved || editing ? (
              <>
                <p className="claude-dialog-hint">{ADMIN_TOKEN_COPY.required}</p>
                <ClaudeField
                  label="管理员令牌"
                  type="password"
                  value={draft}
                  placeholder="粘贴管理员令牌"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adminTokenReady(draft)) {
                      relay.setAdminToken(draft.trim())
                      setDraft("")
                      setEditing(false)
                    }
                  }}
                />
                <p className="claude-dialog-hint">{ADMIN_TOKEN_COPY.hint}</p>
                <div className="claude-dialog-actions">
                  {saved ? (
                    <ClaudeButton kind="ghost" onClick={() => setEditing(false)}>
                      取消
                    </ClaudeButton>
                  ) : null}
                  <ClaudeButton
                    kind="primary"
                    disabled={!adminTokenReady(draft)}
                    onClick={() => {
                      relay.setAdminToken(draft.trim())
                      setDraft("")
                      setEditing(false)
                    }}
                  >
                    保存令牌
                  </ClaudeButton>
                </div>
              </>
            ) : (
              <div className="claude-pairing-generate">
                <ClaudeBadge tone="muted">管理员令牌已保存</ClaudeBadge>
                <button type="button" className="claude-link-btn" onClick={() => setEditing(true)}>
                  更换
                </button>
                <ClaudeButton kind="primary" disabled={creating} onClick={() => void generate()}>
                  {creating ? "正在生成…" : pair ? "重新生成" : "生成配对码"}
                </ClaudeButton>
              </div>
            )}
            {error ? (
              <p className="claude-dialog-error" role="alert">
                {error}
              </p>
            ) : null}
            {pair ? (
              <div className="claude-pairing-code" data-expired={expired ? "" : undefined}>
                <span className="claude-pairing-code-text">{formatPairCode(pair.code)}</span>
                <span className="claude-pairing-code-meta">
                  {paired ? `已配对：${paired.name}` : expired ? COPY.pairExpired : `${remainText(pair.expiresAt, now)} 内有效`}
                </span>
              </div>
            ) : null}
            {pair && !paired && !expired ? <p className="claude-dialog-hint">{COPY.pairDone}</p> : null}
          </section>

          <section className="claude-pairing-section">
            <div className="claude-pairing-attach-head">
              <h3 className="claude-pairing-title">在电脑上接入</h3>
              <div className="claude-segment claude-segment-sm" role="radiogroup" aria-label="系统">
                {(["unix", "windows"] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={platform === value} className="claude-segment-item" data-active={platform === value ? "" : undefined} onClick={() => setPlatform(value)}>
                    {value === "unix" ? "macOS / Linux" : "Windows"}
                  </button>
                ))}
              </div>
            </div>
            <pre className="claude-pairing-cmd">{ATTACH_COMMAND[platform]}</pre>
            <ClaudeCopyField value={ATTACH_COMMAND[platform]} label="复制命令" />
          </section>

          <section className="claude-pairing-section">
            <h3 className="claude-pairing-title">已配对的设备</h3>
            {devices.length === 0 ? <p className="claude-dialog-hint">还没有设备。</p> : null}
            <div className="claude-pairing-devices">
              {devices.map((device) => {
                const canRevokeThis = canRevoke(device)
                return (
                  <div key={device.id} className="claude-pairing-device">
                    <span className="claude-pairing-device-name">{device.name}</span>
                    <span className="claude-pairing-device-meta">
                      {device.platform} · {device.online ? "在线" : "离线"} {device.paired ? "· 已配对" : device.auth === "legacy" ? "· 旧鉴权" : ""}
                    </span>
                    {canRevokeThis ? (
                      <button
                        type="button"
                        className="claude-link-btn"
                        data-danger={armed === device.id ? "" : undefined}
                        disabled={revoking === device.id || !ready}
                        onClick={() => void revoke(device.id, device.name)}
                      >
                        {revoking === device.id ? "撤销中…" : armed === device.id ? "再点一次确认撤销" : "撤销"}
                      </button>
                    ) : (
                      <span className="claude-pairing-device-meta">{COPY.revokeExplain}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )

  if (sheetOpen) {
    return (
      <ClaudeSheet title="设备与配对" onClose={close} footer={<ClaudeButton kind="primary" onClick={close}>完成</ClaudeButton>}>
        {body}
      </ClaudeSheet>
    )
  }
  return (
    <ClaudeDialog title="设备与配对" onClose={close} footer={<ClaudeButton kind="primary" onClick={close}>完成</ClaudeButton>} width={560}>
      {body}
    </ClaudeDialog>
  )
}
