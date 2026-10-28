import { PiNoticeCard } from "@/components/pi/shared"
import type { PiContainerProps } from "./types"

/**
 * 通知卡（plan §7.1 background-alerts，a 线）：relay.notices（noticeCore / noticeStore / useNotices：单槽、队列 5、合并、抢占）+ noticeQueue。
 * 放在顶栏下居中（外壳的 notice 槽，桌面宽 420、不压住发送 / 停止键，修 U-20；手机整宽减 32）；连接和进度不进通知槽（它们在 relay.notice 单槽，
 * 分别由状态行和 composer 状态行承载）。PiNoticeCard 的 error 级 role="alert"，其余 role="status"。
 * 右上"+N" = 后面还排着几条；标题后"×N" = 同 key 合并的次数。悬停 / 焦点在卡里时暂停计时（N8）。
 * 卡上的按钮：× → dismissNotice；第 i 个文字按钮 → runNoticeAction(item, actions[i])（会不会顺带关卡由 noticeCore 定）。
 * 标题前缀 / 角标 / 提示音（P5.7）在 PiApp 里，不在这里。外壳只在 relay.notices 非空时放这个槽。
 */
export function NoticeContainer(props: PiContainerProps) {
  const { relay, variant } = props
  const item = relay.notices[0]
  if (!item) return null
  return (
    <div
      data-pi-notice-host={item.id}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") relay.pauseNotice(item.id, "hover")
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") relay.resumeNotice(item.id, "hover")
      }}
      onFocus={() => relay.pauseNotice(item.id, "focus")}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (!next || !event.currentTarget.contains(next)) relay.resumeNotice(item.id, "focus")
      }}
    >
      <PiNoticeCard
        level={item.level}
        title={item.title}
        body={item.body || undefined}
        actions={item.actions.map((a) => ({ label: a.label, primary: a.kind === "primary" }))}
        count={relay.noticeQueue || undefined}
        merged={item.count > 1 ? item.count : undefined}
        variant={variant}
        onAction={(index) => {
          const action = item.actions[index]
          if (action) relay.runNoticeAction(item, action)
        }}
        onDismiss={() => relay.dismissNotice(item.id)}
      />
    </div>
  )
}
