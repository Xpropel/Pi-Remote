/**
 * 手机端设置 · 设备 · 系统操作（从设备列表点进的单设备页）。
 *
 * 与桌面展开区同一套状态与口径（useSystemOps / systemOpsLogic），只是布局按
 * 手机原子重排：返回行 → 版本块 → 结果行 → 四个操作行。整页按 device.ops
 * 能力位门控；离线显示离线说明——操作进行中除外（重启类操作会让设备中途
 * 离线，页面要留着报结果）。确认弹窗走 PiDialog 的 phone sheet 形态。
 */
import { ChevronLeft } from "lucide-react"
import type { Device } from "@/relay/devices"
import { useNow } from "@/pi/hooks/useNow"
import { deviceNameOf } from "../../pages/devicesLogic.ts"
import {
  deviceOpsSupportedOf,
  operationResultOf,
  operationRowsOf,
  SYSTEM_OPS_OFFLINE_TEXT,
  SYSTEM_OPS_UNSUPPORTED_TEXT,
  versionCellsOf,
  type RoomBusyLike,
  type SystemOpsFacts,
} from "../../pages/systemOpsLogic.ts"
import { SystemOpsConfirm } from "../../pages/SystemOpsConfirm.tsx"
import { useSystemOps, type SystemOpsRelayLike } from "../../pages/useSystemOps.ts"
import { MobileCard, MobileGroup, MobileNote, MobilePageBody } from "../atoms.tsx"

export interface MobileSystemOpsPageProps {
  relay: SystemOpsRelayLike
  device: Device
  rooms: readonly RoomBusyLike[]
  onBack: () => void
}

export function MobileSystemOpsPage({ relay, device, rooms, onBack }: MobileSystemOpsPageProps) {
  const ops = useSystemOps(relay, device, rooms)
  const now = useNow(1000)
  const running = ops.status.state === "running"
  const name = deviceNameOf(device)

  const confirmDialog = ops.confirmKind ? (
    <SystemOpsConfirm
      key={`${device.id}-${ops.confirmKind}`}
      viewport="phone"
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

  let content: React.ReactNode
  if (!device.online && !running) {
    content = <MobileNote>{SYSTEM_OPS_OFFLINE_TEXT}</MobileNote>
  } else if (!deviceOpsSupportedOf(device)) {
    content = <MobileNote>{SYSTEM_OPS_UNSUPPORTED_TEXT}</MobileNote>
  } else if (ops.loadPhase === "loading") {
    content = <MobileNote>正在读取设备信息…</MobileNote>
  } else if (ops.loadPhase === "error" || !ops.diag) {
    content = (
      <>
        <p className="sm-ops-note is-error">{ops.loadError || "读取设备信息失败"}</p>
        <div className="sm-ops-actions">
          <button type="button" className="sm-device-action" onClick={ops.reload}>
            重试
          </button>
        </div>
      </>
    )
  } else {
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
    content = (
      <>
        <div className="sm-ops-head">
          <button type="button" className="sm-device-action" onClick={ops.reload}>
            刷新
          </button>
        </div>
        <div className="sm-ops-ver">
          {cells.map((cell) => (
            <div className="sm-ops-ver-cell" key={cell.label}>
              <span className="sm-ops-ver-k">{cell.label}</span>
              <span className="sm-ops-ver-v">
                {cell.value}
                {cell.tag ? <span className="sm-ops-ver-tag">{cell.tag}</span> : null}
              </span>
            </div>
          ))}
        </div>
        {result ? (
          <div className="sm-op-row is-result">
            <span className="sm-op-main">
              <span className="sm-op-name is-ok">✓ {result.title}</span>
              <span className="sm-op-desc">{result.text}</span>
            </span>
          </div>
        ) : null}
        {rows.map((row) => (
          <div className="sm-op-row" key={row.kind} data-settings-op={row.kind}>
            <span className="sm-op-main">
              <span className={`sm-op-name${row.failed ? " is-error" : ""}`}>
                {row.phaseText ? <span className="sm-ops-spinner" aria-hidden="true" /> : null}
                {row.title}
                {row.phaseText ? <span className="sm-op-phase">{row.phaseText}</span> : null}
              </span>
              <span className="sm-op-desc">
                {row.warningText ? <span className="sm-op-warn">{row.warningText}</span> : null}
                {row.description}
              </span>
              {row.errorText ? <span className="sm-op-error">{row.errorText}</span> : null}
            </span>
            {row.buttonLabel ? (
              <button
                type="button"
                className={`sm-device-action${row.buttonPrimary ? " is-primary" : ""}`}
                disabled={!row.buttonEnabled}
                onClick={() => {
                  if (row.buttonAction === "recheck") ops.recheckUpdate()
                  else if (row.buttonAction === "run" || row.buttonAction === "retry") ops.setConfirmKind(row.kind)
                }}
              >
                {row.buttonLabel}
              </button>
            ) : null}
          </div>
        ))}
      </>
    )
  }

  return (
    <MobilePageBody page="devices-ops">
      <button type="button" className="sm-ops-back" onClick={onBack}>
        <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        设备
      </button>
      <MobileGroup label={`系统操作 · ${name}`} stacked>
        <MobileCard>{content}</MobileCard>
      </MobileGroup>
      {confirmDialog}
    </MobilePageBody>
  )
}
