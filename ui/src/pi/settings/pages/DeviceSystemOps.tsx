/**
 * Settings > Devices > one device's system-operations expansion (desktop).
 *
 * Rendered under the device row while it is expanded; unmounting on collapse
 * stops the polling (useSystemOps), and the attach-held status is re-read on
 * the next expansion. The whole area is gated on the device advertising the
 * "device.ops" cap; offline devices show the offline note instead -- except
 * while an operation is running, when the area stays live so a restart that
 * takes the device offline mid-operation still reports its outcome.
 */
import { useNow } from "@/pi/hooks/useNow"
import type { Device } from "@/relay/devices"
import { deviceNameOf } from "./devicesLogic"
import {
  compactSystemOpLabelOf,
  compactSystemOpsSummaryOf,
  deviceOpsSupportedOf,
  operationResultOf,
  operationRowsOf,
  SYSTEM_OPS_OFFLINE_TEXT,
  SYSTEM_OPS_UNSUPPORTED_TEXT,
  versionCellsOf,
  type RoomBusyLike,
  type SystemOpsFacts,
} from "./systemOpsLogic"
import { SystemOpsConfirm } from "./SystemOpsConfirm"
import { useSystemOps, type SystemOpsRelayLike } from "./useSystemOps"

export interface DeviceSystemOpsProps {
  relay: SystemOpsRelayLike
  device: Device
  rooms: readonly RoomBusyLike[]
}

export function DeviceSystemOps({ relay, device, rooms }: DeviceSystemOpsProps) {
  const ops = useSystemOps(relay, device, rooms)
  const now = useNow(1000)
  const running = ops.status.state === "running"
  const name = deviceNameOf(device)

  const confirmDialog = ops.confirmKind ? (
    <SystemOpsConfirm
      key={`${device.id}-${ops.confirmKind}`}
      viewport="desktop"
      open
      onOpenChange={(open) => {
        if (!open) ops.setConfirmKind(null)
      }}
      kind={ops.confirmKind}
      deviceName={name}
      busy={ops.busy}
      update={ops.update}
      onConfirm={() => ops.startOperation(ops.confirmKind as NonNullable<typeof ops.confirmKind>)}
    />
  ) : null

  if (!device.online && !running) {
    return (
      <div className="settings-device-ops" data-settings-device-ops={device.id}>
        <span className="settings-ops-note">{SYSTEM_OPS_OFFLINE_TEXT}</span>
      </div>
    )
  }
  if (!deviceOpsSupportedOf(device)) {
    return (
      <div className="settings-device-ops" data-settings-device-ops={device.id}>
        <span className="settings-ops-note">{SYSTEM_OPS_UNSUPPORTED_TEXT}</span>
      </div>
    )
  }
  if (ops.loadPhase === "loading") {
    return (
      <div className="settings-device-ops" data-settings-device-ops={device.id}>
        <span className="settings-ops-note">正在读取设备信息…</span>
      </div>
    )
  }
  if (ops.loadPhase === "error" || !ops.diag) {
    return (
      <div className="settings-device-ops" data-settings-device-ops={device.id}>
        <span className="settings-ops-note is-error">{ops.loadError || "读取设备信息失败"}</span>
        <button type="button" className="settings-device-action" onClick={ops.reload}>
          重试
        </button>
      </div>
    )
  }

  const facts: SystemOpsFacts = {
    device,
    diag: ops.diag,
    update: ops.update,
    updateCheckError: ops.updateCheckError,
    busy: ops.busy,
  }
  const cells = versionCellsOf(ops.diag, ops.update)
  const rows = operationRowsOf(facts, ops.status, now)
  const result = operationResultOf(ops.status, now)
  const summary = compactSystemOpsSummaryOf(rows, result)

  return (
    <div className="settings-device-ops" data-settings-device-ops={device.id}>
      <div className="settings-ops-ver">
        {cells.map((cell) => (
          <div className="settings-ops-ver-cell" key={cell.label}>
            <span className="settings-ops-ver-k">{cell.label}</span>
            <span className="settings-ops-ver-v">
              {cell.value}
              {cell.tag ? <span className="settings-ops-ver-tag">{cell.tag}</span> : null}
            </span>
          </div>
        ))}
      </div>
      <div className="settings-ops-bar">
        {rows.map((row) => (
          <button
            key={row.kind}
            type="button"
            data-settings-op={row.kind}
            className={`settings-device-action${row.buttonPrimary ? " is-primary" : ""}`}
            disabled={!row.buttonEnabled}
            title={[row.warningText, row.description].filter(Boolean).join("") || undefined}
            onClick={() => {
              if (row.buttonAction === "recheck") ops.recheckUpdate()
              else if (row.buttonAction === "run" || row.buttonAction === "retry") ops.setConfirmKind(row.kind)
            }}
          >
            {row.phaseText ? <span className="settings-ops-spinner" aria-hidden="true" /> : null}
            <span>{compactSystemOpLabelOf(row)}</span>
          </button>
        ))}
        <button type="button" className="settings-device-action settings-ops-refresh" disabled={running} onClick={ops.reload}>
          刷新
        </button>
      </div>
      {summary.runningRow ? (
        <div className="settings-ops-foot">
          <span className="settings-ops-spinner" aria-hidden="true" />
          <span>
            {summary.runningRow.title} · {summary.runningRow.phaseText} · {summary.runningRow.description}
          </span>
        </div>
      ) : summary.failedRow ? (
        <div className="settings-op-error">
          {summary.failedRow.title}：{summary.failedRow.errorText || summary.failedRow.description}
        </div>
      ) : summary.okText || summary.warnText || summary.mutedText ? (
        <div className="settings-ops-foot">
          {summary.okText ? <span className="settings-ops-ok">✓ {summary.okText}</span> : null}
          {summary.warnText ? <span className="settings-op-warn">{summary.warnText}</span> : null}
          {summary.mutedText ? <span>{summary.mutedText}</span> : null}
        </div>
      ) : null}
      {confirmDialog}
    </div>
  )
}
