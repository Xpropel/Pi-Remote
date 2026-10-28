import type { VariantAppProps } from "@/pi/variants/types"
import { CodexSegmented } from "../pages/CodexSettingsGroup"
import { CodexButton } from "../primitives/primitives"

/** 显示选项（分组方式 / 密度 / 设备筛选）：菜单语言 12 圆角；写偏好只经 act.setPref */
export function CodexDisplayOptions({ p, onClose }: { p: VariantAppProps; onClose: () => void }) {
  const { relay, ui, act } = p
  return (
    <div className="cx-display-options" role="dialog" aria-label="显示选项">
      <div className="cx-pop-head">显示选项</div>
      <div className="cx-display-row">
        <span>分组方式</span>
        <CodexSegmented
          value={ui.prefs.grouping}
          label="分组方式"
          options={[
            { value: "device", label: "按设备" },
            { value: "flat", label: "平铺" },
          ]}
          onChange={(next) => act.setPref("grouping", next)}
        />
      </div>
      <div className="cx-display-row">
        <span>密度</span>
        <CodexSegmented
          value={ui.prefs.density}
          label="密度"
          options={[
            { value: "compact", label: "精简" },
            { value: "balanced", label: "平衡" },
            { value: "detailed", label: "详细" },
          ]}
          onChange={(next) => act.setPref("density", next)}
        />
      </div>
      <div className="cx-display-row">
        <span>设备筛选</span>
        <select className="cx-select" value={ui.prefs.deviceFilter ?? "all"} onChange={(event) => act.setPref("deviceFilter", event.target.value === "all" ? null : event.target.value)}>
          <option value="all">全部设备</option>
          {relay.devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </div>
      <div className="cx-dialog-actions-inline">
        <CodexButton kind="outline" onClick={onClose}>
          完成
        </CodexButton>
      </div>
    </div>
  )
}
