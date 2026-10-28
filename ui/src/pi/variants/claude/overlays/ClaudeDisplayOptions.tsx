import type { PiContainerProps } from "@/pi/containers/types"
import { writePrefs } from "../model/logic"
import { ClaudeSheet } from "../primitives/ClaudePrimitives"
import { ClaudeRow, ClaudeSegment } from "../primitives/ClaudePrimitives"
import { CLAUDE_OVERLAY } from "./ids"

/**
 * 显示选项（手机账户栏滑杆打开的 sheet / 桌面可作为轻量浮层）：主题 / 密度 / 分组三项快速修改，
 * 与设置页共用同一写入口径（model/settingsView + act.setPref）。
 */
export function ClaudeDisplayOptions({ p }: { p: PiContainerProps }) {
  const { ui, act } = p
  const open = ui.sheet?.id === CLAUDE_OVERLAY.displayOptions
  if (!open) return null
  const write = (patch: Parameters<typeof writePrefs>[1]) => writePrefs(p, patch)
  return (
    <ClaudeSheet title="显示选项" onClose={() => act.closeSheet()}>
      <div className="claude-displayoptions">
        <ClaudeRow
          label="主题"
          control={
            <ClaudeSegment
              label="主题"
              value={ui.prefs.theme}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
              onChange={(value) => write({ theme: value })}
            />
          }
        />
        <ClaudeRow
          label="工具显示"
          control={
            <ClaudeSegment
              label="工具显示"
              value={ui.prefs.density}
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
          control={
            <ClaudeSegment
              label="会话分组"
              value={ui.prefs.grouping}
              options={[
                { value: "device", label: "按设备" },
                { value: "flat", label: "平铺" },
              ]}
              onChange={(value) => write({ grouping: value })}
            />
          }
        />
      </div>
    </ClaudeSheet>
  )
}

export { CLAUDE_OVERLAY }
