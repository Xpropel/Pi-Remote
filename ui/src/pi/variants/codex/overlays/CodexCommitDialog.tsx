import { GitCommitHorizontal } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { useCodexCapability } from "../logic/capability"
import { CodexButton, CodexDialog } from "../primitives/primitives"
import { CodexExtensionNotice } from "../primitives/CodexCapability"

/**
 * Commit 对话框（CX-DLG-06 / [X-图13④]）：Commit / Commit and push / Commit and create PR 三阶。
 * 能力 `git-commit`：生产无 provider → 三个动作禁用 + 契约说明/docsPath；mock 注入 → 走 actions.commit/push/createPr。
 */
export function CodexCommitDialog({ p, onClose }: { p: VariantAppProps; onClose: () => void }) {
  const cap = useCodexCapability("git-commit")
  const repo = cap.data?.repos?.[0]?.repoPath ?? null
  const disabled = !cap.interactive || !cap.actions?.commit || !repo
  const run = (mode: "commit" | "push" | "pr") => {
    if (disabled || !cap.actions?.commit || !repo) return
    cap.actions.commit(repo, "Codex UI commit")
    if (mode !== "commit") cap.actions.push?.(repo)
    if (mode === "pr") cap.actions.createPr?.(repo)
    p.relay.notify(mode === "commit" ? "已提交（模拟演示）" : mode === "push" ? "已提交并推送（模拟演示）" : "已提交并创建 PR（模拟演示）", "warn")
    onClose()
  }
  return (
    <CodexDialog
      title="提交改动"
      subtitle={repo ?? "没有可用的仓库（扩展未接入）"}
      onClose={onClose}
      width={420}
      footer={
        <>
          <CodexButton kind="outline" onClick={onClose}>
            取消
          </CodexButton>
          <CodexButton kind="primary" disabled={disabled} data-p4-action="commit-and-pr" onClick={() => run("pr")}>
            提交并创建 PR
          </CodexButton>
        </>
      }
    >
      <div data-p4-surface="CX-DLG-06" data-capability-state={cap.status} data-p4-ready="">
        <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        <div className="cx-dialog-actions-inline">
          <CodexButton kind="outline" disabled={disabled} data-p4-action="commit-only" onClick={() => run("commit")}>
            <GitCommitHorizontal aria-hidden size={13} strokeWidth={1.5} />
            提交
          </CodexButton>
          <CodexButton kind="outline" disabled={disabled} data-p4-action="commit-and-push" onClick={() => run("push")}>
            提交并推送
          </CodexButton>
        </div>
        <p className="cx-dialog-text">
          提交链路（提交 / 推送 / 创建 PR）需要 git 扩展接入；接入后此处可直接操作。
        </p>
      </div>
    </CodexDialog>
  )
}
