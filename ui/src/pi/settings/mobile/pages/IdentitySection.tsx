/**
 * Mobile settings > Devices: viewer identity + authorized viewers.
 *
 * This is the mobile presentation of the desktop IdentitySection
 * (settings/pages/IdentitySection.tsx): the SAME state machine, the SAME
 * identity bridge (pages/identityApi.ts -- the single seam to the identity
 * core in relay/viewerIdentity.ts, whose keypair lives in this browser's
 * IndexedDB), and the SAME shaping/copy modules (pages/identityLogic.ts,
 * pages/identityBackup.ts). Nothing here generates, stores, or reads key
 * material itself, so a browser that enables its identity on mobile and
 * later opens desktop settings sees one and the same identity.
 *
 * The passphrase and the raw ACK are held only in form state / local
 * variables for the duration of one submit, are cleared immediately
 * afterwards, and are never logged, persisted, or sent anywhere.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { KeyRound, MonitorSmartphone, ShieldCheck } from "lucide-react"
import { useSettings } from "../../SettingsContext.tsx"
import { downloadTextFile } from "../../pages/dataTools.ts"
import {
  createIdentityBackup,
  IdentityBackupError,
  openIdentityBackup,
  parseIdentityBackup,
  serializeIdentityBackup,
  BACKUP_PASSPHRASE_MIN_LENGTH,
  type IdentityBackupPackage,
} from "../../pages/identityBackup.ts"
import {
  authorizedViewerRowsOf,
  backupStatusTextOf,
  formatFingerprintText,
  identityStateViewOf,
  isSelfViewerRow,
  registrationErrorTextOf,
  viewerStatusTextOf,
  IDENTITY_BACKUP_RECOMMENDATION,
  IDENTITY_ENABLE_INTRO,
  IDENTITY_NOT_REGISTERED_TEXT,
  IDENTITY_PHASE_NOTE,
  IDENTITY_UNRECOVERABLE_WARNING,
  IDENTITY_WAITING_ACK_TEXT,
  VIEWERS_UNSUPPORTED_TEXT,
  VIEWER_REVOKE_ACK_NOTICE,
  type AuthorizedViewerRow,
  type IdentityStateView,
} from "../../pages/identityLogic.ts"
import { loadIdentityBridge, type IdentityBridge } from "../../pages/identityApi.ts"
import { lastOnlineTextOf } from "../../pages/devicesLogic.ts"
import { MobileCard, MobileGroup, MobileNote, MobileTag } from "../atoms.tsx"

type PanelKind = "none" | "enable" | "export" | "import" | "forget"

type RosterState =
  | { phase: "loading" }
  | { phase: "unsupported" }
  | { phase: "error"; text: string }
  | { phase: "ready"; rows: AuthorizedViewerRow[] }

function errorTextOf(error: unknown): string {
  if (error instanceof IdentityBackupError) {
    switch (error.code) {
      case "open_failed":
        return "口令不正确，或备份文件已损坏。"
      case "bad_format":
        return "这不是有效的身份备份文件。"
      case "unsupported_version":
        return "这份备份的版本不受当前版本支持。"
      case "bad_params":
        return "备份参数异常，文件可能已损坏。"
      case "weak_passphrase":
        return `口令至少需要 ${BACKUP_PASSPHRASE_MIN_LENGTH} 个字符。`
      case "no_webcrypto":
        return "当前浏览器没有可用的 WebCrypto，无法处理备份。"
      default:
        return "备份处理失败。"
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export function MobileIdentitySection() {
  const { p, act } = useSettings()
  const relayRef = useRef(p.relay)
  relayRef.current = p.relay
  const [bridge, setBridge] = useState<IdentityBridge | null | undefined>(undefined)
  const [view, setView] = useState<IdentityStateView | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [roster, setRoster] = useState<RosterState>({ phase: "loading" })
  const [panel, setPanel] = useState<PanelKind>("none")
  const [justEnabled, setJustEnabled] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const now = Date.now()

  const refreshRoster = useCallback(async (active: IdentityBridge) => {
    if (!active.listViewers) {
      setRoster({ phase: "unsupported" })
      return
    }
    try {
      const raw = await active.listViewers()
      setRoster({ phase: "ready", rows: authorizedViewerRowsOf(raw) })
    } catch (error) {
      setRoster({ phase: "error", text: errorTextOf(error) })
    }
  }, [])

  const refresh = useCallback(
    async (active: IdentityBridge) => {
      try {
        setView(identityStateViewOf(await active.getState()))
        setStateError(null)
      } catch (error) {
        setStateError(errorTextOf(error))
      }
      await refreshRoster(active)
    },
    [refreshRoster],
  )

  useEffect(() => {
    let cancelled = false
    void loadIdentityBridge(relayRef.current).then((loaded) => {
      if (cancelled) return
      setBridge(loaded)
      if (loaded) void refresh(loaded)
      else setRoster({ phase: "unsupported" })
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Same re-read discipline as the desktop section: enabling identity
  // reconnects the socket for key auth, and an ACK can be delivered long
  // after this page opened, so re-read whenever the relay reports a new
  // auth or identity state instead of only on mount and own actions.
  const relayIdentity = p.relay.viewerIdentity
  const identitySignal = [
    p.relay.authed ? "authed" : "unauthed",
    relayIdentity?.registered ? "registered" : "unregistered",
    relayIdentity?.hasAck ? "ack" : "no-ack",
    relayIdentity?.ackFp ?? "",
    relayIdentity?.keyFp ?? "",
  ].join("|")
  const seenSignalRef = useRef<string | null>(null)
  useEffect(() => {
    if (seenSignalRef.current === null) {
      seenSignalRef.current = identitySignal
      return
    }
    if (seenSignalRef.current === identitySignal) return
    seenSignalRef.current = identitySignal
    if (bridge) void refresh(bridge)
  }, [identitySignal, bridge, refresh])

  const phase = bridge === undefined ? "loading" : bridge === null ? "unavailable" : (view?.phase ?? "none")

  /* ---------------- enable ---------------- */

  const [enableAcked, setEnableAcked] = useState(false)
  const enableIdentity = async () => {
    if (!bridge || busy) return
    setBusy("enable")
    try {
      await bridge.enable()
      setPanel("none")
      setEnableAcked(false)
      setJustEnabled(true)
      await refresh(bridge)
      act.notify("观看端身份已启用，本浏览器以后用密钥登录")
    } catch (error) {
      act.notify(`启用失败：${errorTextOf(error)}`, "bad")
    } finally {
      setBusy(null)
    }
  }

  /* ---------------- backup export ---------------- */

  const [exportPass, setExportPass] = useState("")
  const [exportPass2, setExportPass2] = useState("")
  const [exportError, setExportError] = useState<string | null>(null)
  const runExport = async () => {
    if (!bridge || busy) return
    setExportError(null)
    if (exportPass.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
      setExportError(`口令至少需要 ${BACKUP_PASSPHRASE_MIN_LENGTH} 个字符。`)
      return
    }
    if (exportPass !== exportPass2) {
      setExportError("两次输入的口令不一致。")
      return
    }
    setBusy("export")
    let ack: Uint8Array | null = null
    try {
      ack = await bridge.exportAck()
      if (!ack) {
        setExportError("本机还没有内容钥，暂时无法创建备份。")
        return
      }
      const pkg = await createIdentityBackup({
        ack,
        passphrase: exportPass,
        meta: { accountId: view?.accountId ?? undefined, viewerId: view?.viewerId ?? undefined },
      })
      const day = new Date(pkg.createdAt).toISOString().slice(0, 10)
      const ok = downloadTextFile(`pi-remote-identity-backup-${day}.json`, serializeIdentityBackup(pkg))
      if (!ok) {
        setExportError("浏览器没有放行下载，请检查下载设置后重试。")
        return
      }
      await bridge.markBackedUp(pkg.createdAt)
      setExportPass("")
      setExportPass2("")
      setPanel("none")
      setJustEnabled(false)
      await refresh(bridge)
      act.notify("口令备份已生成并下载，请把文件与口令分开保管")
    } catch (error) {
      setExportError(errorTextOf(error))
    } finally {
      // The exported ACK copy must not linger in this component's memory.
      ack?.fill(0)
      setBusy(null)
    }
  }

  /* ---------------- backup import ---------------- */

  const fileInput = useRef<HTMLInputElement | null>(null)
  const [importPkg, setImportPkg] = useState<IdentityBackupPackage | null>(null)
  const [importName, setImportName] = useState<string | null>(null)
  const [importPass, setImportPass] = useState("")
  const [importError, setImportError] = useState<string | null>(null)
  const pickImportFile = async (file: File | null) => {
    setImportError(null)
    setImportPkg(null)
    setImportName(null)
    if (!file) return
    try {
      const pkg = parseIdentityBackup(await file.text())
      setImportPkg(pkg)
      setImportName(file.name)
    } catch (error) {
      setImportError(errorTextOf(error))
    }
  }
  const runImport = async () => {
    if (!bridge || !importPkg || busy) return
    setImportError(null)
    setBusy("import")
    let opened: { ack: Uint8Array } | null = null
    try {
      opened = await openIdentityBackup(importPkg, importPass)
      await bridge.importAck(opened.ack)
      setImportPass("")
      setImportPkg(null)
      setImportName(null)
      setPanel("none")
      await refresh(bridge)
      act.notify("内容钥已从备份恢复")
    } catch (error) {
      setImportError(errorTextOf(error))
    } finally {
      opened?.ack.fill(0)
      setBusy(null)
    }
  }

  /* ---------------- forget (recovery) ---------------- */

  const runForget = async () => {
    if (!bridge?.forget || busy) return
    setBusy("forget")
    try {
      await bridge.forget()
      setPanel("none")
      setJustEnabled(false)
      await refresh(bridge)
      act.notify("已忘记本机身份，本机密钥与内容钥副本已清除")
    } catch (error) {
      act.notify(`忘记本机身份失败：${errorTextOf(error)}`, "bad")
    } finally {
      setBusy(null)
    }
  }

  /* ---------------- revoke ---------------- */

  const [revokeTarget, setRevokeTarget] = useState<AuthorizedViewerRow | null>(null)
  const runRevoke = async () => {
    if (!bridge?.revokeViewer || !revokeTarget || busy) return
    setBusy("revoke")
    try {
      await bridge.revokeViewer(revokeTarget.viewerId)
      setRevokeTarget(null)
      await refreshRoster(bridge)
      act.notify(`已撤销观看端「${revokeTarget.name}」的登录资格`)
    } catch (error) {
      act.notify(`撤销失败：${errorTextOf(error)}`, "bad")
    } finally {
      setBusy(null)
    }
  }

  /* ---------------- render ---------------- */

  return (
    <>
      <MobileGroup label="观看端身份" description={IDENTITY_PHASE_NOTE} stacked>
        <MobileCard>
          {phase === "loading" ? <div className="sm-identity-line">正在读取本机身份状态…</div> : null}

          {phase === "unavailable" ? (
            <div className="sm-identity-line">本版本尚未接通身份核心，这里不会假装可用；升级到带身份核心的版本后即可启用。</div>
          ) : null}

          {stateError ? <div className="sm-identity-error">读取身份状态失败：{stateError}</div> : null}

          {phase === "none" ? (
            <>
              <div className="sm-identity-block">
                <div className="sm-identity-title">本机观看端身份</div>
                <p className="sm-identity-text">{IDENTITY_ENABLE_INTRO}</p>
                <div className="sm-device-actions">
                  <button
                    type="button"
                    className="sm-device-action"
                    disabled={busy !== null}
                    onClick={() => setPanel(panel === "enable" ? "none" : "enable")}
                  >
                    启用观看端身份
                  </button>
                </div>
              </div>
              {panel === "enable" ? (
                <div className="sm-identity-panel" data-sm-identity-panel="enable">
                  <p className="sm-identity-warning">{IDENTITY_UNRECOVERABLE_WARNING}</p>
                  <label className="sm-identity-check">
                    <input type="checkbox" checked={enableAcked} onChange={(event) => setEnableAcked(event.target.checked)} />
                    <span>我已理解：没有口令备份、持钥设备又全部丢失时，历史记录无法恢复。</span>
                  </label>
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => setPanel("none")}>
                      再想想
                    </button>
                    <button
                      type="button"
                      className="sm-device-action sm-device-action--danger"
                      disabled={!enableAcked || busy !== null}
                      onClick={() => void enableIdentity()}
                    >
                      {busy === "enable" ? "正在生成密钥…" : "确认启用"}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {phase === "not-registered" || phase === "waiting-ack" || phase === "ready" ? (
            <>
              <div className="sm-identity-block" data-sm-identity={phase}>
                <div className="sm-device-head">
                  <ShieldCheck size={19} strokeWidth={1.7} aria-hidden="true" />
                  <span className="sm-device-name">本机观看端身份</span>
                </div>
                <div className="sm-identity-meta">
                  <span>
                    身份指纹 <span className="sm-identity-fp">{formatFingerprintText(view?.keyFp)}</span>
                  </span>
                  {phase === "ready" ? (
                    <span>
                      内容钥指纹 <span className="sm-identity-fp">{formatFingerprintText(view?.ackFp)}</span>
                      {/* Keep the backup status with its separator on the
                          fingerprint line's flow, like the desktop card. */}
                      <span>
                        {" · "}
                        {backupStatusTextOf(view as IdentityStateView)}
                        {view?.backedUpAt ? `（${lastOnlineTextOf(view.backedUpAt, now)}）` : ""}
                      </span>
                    </span>
                  ) : null}
                </div>
                <div className="sm-device-actions">
                  {/* Re-register stays available in the ready state too: a
                      registration that drifted (relay rebuilt, roster lost)
                      must be repairable without forgetting the identity. */}
                  {phase === "not-registered" || phase === "ready" ? (
                    <button type="button" className="sm-device-action" disabled={busy !== null} onClick={() => void enableIdentity()}>
                      {busy === "enable" ? "正在登记…" : "重新登记"}
                    </button>
                  ) : null}
                  {phase === "ready" ? (
                    <button
                      type="button"
                      className="sm-device-action"
                      disabled={busy !== null}
                      onClick={() => setPanel(panel === "export" ? "none" : "export")}
                    >
                      导出备份
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="sm-device-action"
                    disabled={busy !== null}
                    onClick={() => setPanel(panel === "import" ? "none" : "import")}
                  >
                    导入备份
                  </button>
                  {/* Forget is offered in every live phase, ready included:
                      the shared confirmation panel below carries the
                      ACK-loss warning, so the ready state needs no weaker
                      path to the same destructive action. */}
                  <button
                    type="button"
                    className="sm-device-action"
                    disabled={busy !== null || !bridge?.forget}
                    title={bridge?.forget ? undefined : "当前连接不支持忘记本机身份"}
                    onClick={() => setPanel(panel === "forget" ? "none" : "forget")}
                  >
                    忘记本机身份
                  </button>
                </div>
              </div>

              {phase === "not-registered" && view ? (
                <div className="sm-identity-error">
                  {registrationErrorTextOf(view)}
                  {IDENTITY_NOT_REGISTERED_TEXT}
                </div>
              ) : null}

              {phase === "waiting-ack" ? <div className="sm-identity-waiting">{IDENTITY_WAITING_ACK_TEXT}</div> : null}

              {panel === "forget" ? (
                <div className="sm-identity-panel" data-sm-identity-panel="forget">
                  <p>
                    忘记本机身份会清掉这个浏览器里的身份密钥和内容钥副本，回到未启用状态；之后可以重新启用，生成一副全新的密钥。
                  </p>
                  <p className="sm-identity-warning">
                    注意：如果这把内容钥没有别的副本（口令备份，或其它持有它的设备），用它加密过的历史将无法再解开。中转服务名册里若有本机的登记行，不受本操作影响，需要时在下方名册里另行撤销。
                  </p>
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => setPanel("none")}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="sm-device-action sm-device-action--danger"
                      disabled={busy !== null || !bridge?.forget}
                      onClick={() => void runForget()}
                    >
                      {busy === "forget" ? "正在清除…" : "确认忘记本机身份"}
                    </button>
                  </div>
                </div>
              ) : null}

              {justEnabled && phase === "ready" ? (
                <div className="sm-identity-panel" data-sm-identity-panel="backup-recommendation">
                  <p>{IDENTITY_BACKUP_RECOMMENDATION}</p>
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => setJustEnabled(false)}>
                      稍后再说
                    </button>
                    <button type="button" className="sm-device-action" onClick={() => setPanel("export")}>
                      现在创建口令备份
                    </button>
                  </div>
                </div>
              ) : null}

              {panel === "export" && phase === "ready" ? (
                <div className="sm-identity-panel" data-sm-identity-panel="export">
                  <p>
                    给备份设一个口令。备份文件里只有被口令加密过的内容钥；没有这个口令，谁拿到文件也解不开。口令本身不会被保存或发送到任何地方。
                  </p>
                  <label className="sm-identity-field">
                    <span>备份口令（至少 {BACKUP_PASSPHRASE_MIN_LENGTH} 个字符）</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="sm-identity-input"
                      value={exportPass}
                      onChange={(event) => setExportPass(event.target.value)}
                    />
                  </label>
                  <label className="sm-identity-field">
                    <span>再输入一次</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="sm-identity-input"
                      value={exportPass2}
                      onChange={(event) => setExportPass2(event.target.value)}
                    />
                  </label>
                  {exportError ? <p className="sm-identity-error-text">{exportError}</p> : null}
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => setPanel("none")}>
                      取消
                    </button>
                    <button type="button" className="sm-device-action" disabled={busy !== null} onClick={() => void runExport()}>
                      {busy === "export" ? "正在生成…" : "生成并下载备份"}
                    </button>
                  </div>
                </div>
              ) : null}

              {panel === "import" ? (
                <div className="sm-identity-panel" data-sm-identity-panel="import">
                  <p>
                    选择一份身份备份文件并输入当时设的口令，内容钥会恢复到本机。恢复成功后，本机与备份对应的内容钥指纹一致。
                    {phase === "ready" ? "注意：本机现在已有内容钥，导入会覆盖它。" : ""}
                  </p>
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => fileInput.current?.click()}>
                      选择备份文件
                    </button>
                    {importName ? <span className="sm-identity-file-name">{importName}</span> : null}
                  </div>
                  {importPkg ? (
                    <p>
                      内容钥指纹 <span className="sm-identity-fp">{formatFingerprintText(importPkg.ackFp)}</span>
                    </p>
                  ) : null}
                  <label className="sm-identity-field">
                    <span>备份口令</span>
                    <input
                      type="password"
                      autoComplete="off"
                      className="sm-identity-input"
                      value={importPass}
                      onChange={(event) => setImportPass(event.target.value)}
                    />
                  </label>
                  {importError ? <p className="sm-identity-error-text">{importError}</p> : null}
                  <div className="sm-device-actions">
                    <button type="button" className="sm-device-action" onClick={() => setPanel("none")}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="sm-device-action"
                      disabled={!importPkg || !importPass || busy !== null}
                      onClick={() => void runImport()}
                    >
                      {busy === "import" ? "正在恢复…" : "导入并恢复内容钥"}
                    </button>
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".json,application/json"
                    className="sm-visually-hidden"
                    aria-label="选择身份备份文件"
                    onChange={(event) => {
                      void pickImportFile(event.target.files?.[0] ?? null)
                      event.target.value = ""
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </MobileCard>
      </MobileGroup>

      <MobileGroup label="已授权观看端" stacked>
        <MobileCard>
          {roster.phase === "loading" ? <div className="sm-identity-line">正在读取观看端名册…</div> : null}
          {roster.phase === "unsupported" ? <div className="sm-identity-line">{VIEWERS_UNSUPPORTED_TEXT}</div> : null}
          {roster.phase === "error" ? <div className="sm-identity-error">读取观看端名册失败：{roster.text}</div> : null}
          {roster.phase === "ready" && roster.rows.length === 0 ? (
            <div className="sm-identity-line">还没有登记过观看端身份</div>
          ) : null}
          {roster.phase === "ready"
            ? roster.rows.map((row) => {
                const self = view ? isSelfViewerRow(row, view) : false
                return (
                  <div className="sm-identity-block" key={row.viewerId} data-sm-viewer={row.viewerId}>
                    <div className="sm-device-head">
                      {row.admin ? (
                        <KeyRound size={19} strokeWidth={1.7} aria-hidden="true" />
                      ) : (
                        <MonitorSmartphone size={19} strokeWidth={1.7} aria-hidden="true" />
                      )}
                      <span className="sm-device-name">{row.name}</span>
                      {self ? <MobileTag>当前浏览器</MobileTag> : null}
                    </div>
                    <div className="sm-identity-meta">
                      <span>
                        {viewerStatusTextOf(row, now)}
                        {" · "}
                        <span className="sm-identity-fp">{formatFingerprintText(row.keyFp)}</span>
                      </span>
                    </div>
                    {!row.revoked && !self ? (
                      <div className="sm-device-actions">
                        <button
                          type="button"
                          className="sm-device-action sm-device-action--danger"
                          disabled={busy !== null || !bridge?.revokeViewer}
                          title={bridge?.revokeViewer ? undefined : "当前连接不支持撤销观看端"}
                          onClick={() => setRevokeTarget(row)}
                        >
                          撤销
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })
            : null}
          {revokeTarget ? (
            <div className="sm-identity-panel" data-sm-identity-panel="revoke">
              <p>确认撤销观看端「{revokeTarget.name}」？撤销后它无法再登录本账号。</p>
              <p className="sm-identity-warning">{VIEWER_REVOKE_ACK_NOTICE}</p>
              <div className="sm-device-actions">
                <button type="button" className="sm-device-action" onClick={() => setRevokeTarget(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="sm-device-action sm-device-action--danger"
                  disabled={busy !== null}
                  onClick={() => void runRevoke()}
                >
                  {busy === "revoke" ? "正在撤销…" : "确认撤销"}
                </button>
              </div>
            </div>
          ) : null}
        </MobileCard>
      </MobileGroup>

      <MobileNote>观看端名册只登记公钥（公开数据），私钥与内容钥永远不会发给中转服务。</MobileNote>
    </>
  )
}
