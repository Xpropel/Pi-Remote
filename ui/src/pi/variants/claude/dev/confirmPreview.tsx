import { createRoot } from "react-dom/client"
import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeApprovalCard } from "../approval/ClaudeApprovalCard"
import "../styles/reset.css"
import "../styles/tokens.css"
import "../styles/dark.css"
import "../styles/claude.css"

/**
 * 仅开发预览：把变体自写的审批卡以 confirm 形态挂到一个自有作用域里（P3-7 截图证据）。
 * 假 relay/act 只满足卡片渲染所需的最小字段；不参与产品构建（Vite 构建入口无本页）。
 */
const params = new URLSearchParams(location.search)
const theme = params.get("theme") === "dark" ? "dark" : "light"

const dialog = {
  dialogId: "preview-confirm",
  kind: "confirm",
  title: "允许 pi 运行这条命令吗？",
  message: "npm test -- mobile",
  startedAt: Date.now() - 38_000,
  timeout: 120_000,
  answerable: true,
}

const relay = {
  dialogs: [dialog],
  dialogReceipts: [],
  uiPrompt: null,
  dismissDialogReceipt: () => {},
  sendDialogAnswer: async () => "ok",
  busy: true,
  online: true,
  roomId: "preview-room",
} as unknown as PiContainerProps["relay"]
const act = { setBlockedBy: () => {} } as unknown as PiContainerProps["act"]
const p = { relay, ui: {} as never, act, keyboardOpen: false, variant: "desktop" as const }

const root = createRoot(document.getElementById("root")!)
root.render(
  <div
    data-pi-ui="claude"
    data-pi-theme={theme}
    className="claude-root"
    style={{ minHeight: "100vh", display: "flex", flexDirection: "column", paddingTop: "120px", alignItems: "center", background: "var(--claude-s1)" }}
  >
    <div style={{ width: 680, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--claude-font-sans)", fontSize: 12, color: "var(--claude-text-3)" }}>
        Claude v2 · 自有审批卡（confirm 形态；三阶按钮：拒绝 / 次要 / 单次批准）
      </div>
      <ClaudeApprovalCard p={p} />
      <div style={{ height: 44, borderRadius: 20, border: "1px solid var(--claude-border)", background: "var(--claude-s3)", boxShadow: "var(--claude-composer-shadow)", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: "var(--claude-font-sans)", fontSize: 15, color: "var(--claude-text-3)" }}>
        pi 正在回复，输入后 Enter 将插入当前回合…
      </div>
    </div>
  </div>,
)
