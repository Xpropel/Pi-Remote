import { useEffect, useMemo, useState } from "react"
import { GhostIconButton } from "@/components/kit"
import { Ellipsis, PanelRight } from "@/components/kit/icons"
import { PiSessionInfoCard } from "@/components/pi/shell"
import { PiButton, PiIconButton, PiMenu, PiSheet, PiTopBar, usePiStatic } from "@/components/pi/shared"
import { gitBranchOf, gitBranchText, sessionModelLine, type PiGitBranch } from "@/pi/model/sessionInfo"
import { otherAttentionCount, sidebarDataOf } from "@/pi/model/sidebarSource"
import { attentionRoomTitle } from "@/relay/attention"
import { A_SESSION_MENU, SessionRowMenu } from "./SessionMenuContainer"
import { openPiDialog, PI_UI_IDS, type PiContainerProps } from "./types"

/** 会话信息：手机点标题出的 sheet（ui.sheet）；桌面静态态（#/live 对图）把标题悬停卡钉开（ui.menu） */
export const A_SESSION_INFO = "a:session-info"

/**
 * get_git_branch（G11：扩展 cmdGetGitBranch 回 { branch, repoRoot, detached }，已对照 extension/pi-remote-sync.ts 核实）。
 * 只在会话已载入、pi 在线时问；换会话、每轮结束后再问一次（本机可能切了分支）。没有结果就是 null（分支行整行不出现）。
 */
function useGitBranch(p: PiContainerProps, enabled: boolean): PiGitBranch | null {
  const { relay } = p
  const room = relay.roomId
  const ask = enabled && !!room && relay.authed && relay.online && !relay.lazySession
  const seq = relay.turnEnd?.seq ?? 0
  const run = relay.runCommand
  const [got, setGot] = useState<{ room: string; branch: PiGitBranch | null } | null>(null)
  useEffect(() => {
    if (!ask) return
    let alive = true
    run("get_git_branch").then(
      (reply) => {
        if (alive) setGot({ room, branch: gitBranchOf(reply) })
      },
      () => {
        if (alive) setGot({ room, branch: null })
      },
    )
    return () => {
      alive = false
    }
  }, [ask, room, seq, run])
  return ask && got?.room === room ? got.branch : null
}

/** 当前会话的标题、设备、注意力（顶栏和会话信息共用） */
function useSessionHead(p: PiContainerProps) {
  const { devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice } = p.relay
  const data = useMemo(
    () => sidebarDataOf({ devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice }),
    [devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice],
  )
  const room = rooms.find((r) => r.id === roomId) ?? null
  const row = data.sessions.find((x) => x.id === roomId)
  const deviceId = row?.deviceId ?? room?.deviceId ?? selectedDevice?.id ?? null
  const device = data.devices.find((d) => d.id === deviceId) ?? null
  const title = roomId ? (row?.title ?? attentionRoomTitle(room)) : ""
  return { data, room, row, device, title, cwd: row?.cwd || room?.cwd || "" }
}

/** 会话信息卡（桌面悬停卡 / 手机 sheet 里的各行） */
function InfoCard({ p, head, branch, variant }: { p: PiContainerProps; head: ReturnType<typeof useSessionHead>; branch: PiGitBranch | null; variant: "desktop" | "phone" }) {
  const { relay } = p
  return (
    <PiSessionInfoCard
      variant={variant}
      title={head.title}
      device={head.device}
      branch={gitBranchText(branch)}
      cwd={head.cwd}
      model={sessionModelLine(relay.modelMeta, relay.model, relay.thinkingLevel)}
      usage={relay.usage ?? {}}
      // relay 里房间 id 就是会话 id
      sessionId={relay.roomId}
      onUsage={() => openPiDialog(p, { id: PI_UI_IDS.usage })}
    />
  )
}

/**
 * 会话信息（plan §7.1 session-info，a 线）：usage / modelMeta / thinkingLevel / rooms·roomId（cwd、设备）/ runCommand。
 * model/sessionInfo.ts：缓存命中 = cacheRead / (input + cacheRead)、模型行、get_git_branch 回包（G11）；缺数据的行整行不出现。
 * 上下文圆环 / "窗口不可信只写 token 数"在 PiSessionInfoCard 里（contextUsage 的口径）。
 *
 * SessionInfoContainer：会话的顶栏。桌面 PiTopBar desktop（标题悬停卡 = 会话信息；右端 "…" = 当前会话的会话菜单 + "复制工作目录"（B04），
 * 分屏钮 = ⌘.）；手机 PiTopBar phone-chat（‹ 返回列表 + 其他会话的注意力计数、点标题开 SessionInfoSheet、… 开会话菜单 sheet）。
 * 没有打开的会话时是空顶栏（不放标题和右端按钮）。
 */
export function SessionInfoContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const isStatic = usePiStatic()
  const head = useSessionHead(props)
  // 只有桌面的悬停卡要分支（手机在 SessionInfoSheet 打开时再问）；设备离线时问不到（命令通道直接拒）
  const branch = useGitBranch(props, variant === "desktop" && (!!head.device?.online || !relay.deviceMode))
  if (variant === "phone") {
    return (
      <PiTopBar
        variant="phone-chat"
        title={head.title}
        platform={head.device?.platform}
        backCount={otherAttentionCount(head.data.attention, relay.roomId, head.device?.id ?? null)}
        onBack={() => act.setPhonePage("list")}
        onTitleClick={relay.roomId ? () => act.openSheet({ id: A_SESSION_INFO }) : undefined}
        actions={
          <PiIconButton
            label="会话菜单"
            icon={<Ellipsis />}
            data-pi-session-more=""
            onClick={relay.roomId && head.row ? () => act.openSheet({ id: A_SESSION_MENU, arg: relay.roomId }) : undefined}
          />
        }
      />
    )
  }
  if (!relay.roomId) return <PiTopBar variant="desktop" showActions={false} />
  const paneOpen = ui.pane != null
  return (
    <PiTopBar
      variant="desktop"
      title={head.title}
      platform={head.device?.platform}
      hoverCard={<InfoCard p={props} head={head} branch={branch} variant="desktop" />}
      // 静态态：session-info 屏把悬停卡钉开；可交互时由 Radix HoverCard 按悬停开合
      {...(isStatic ? { hoverCardOpen: ui.menu?.id === A_SESSION_INFO } : {})}
      paneOpen={paneOpen}
      onTogglePane={act.togglePane}
      actions={
        <>
          {/* 顶栏 …（B04）：当前会话的会话菜单 + "复制工作目录"；静态态只有这颗钮（同默认的"更多"） */}
          <PiMenu kind="dropdown" side="bottom" align="end" trigger={<GhostIconButton label="更多" icon={<Ellipsis />} />}>
            {head.row ? <SessionRowMenu {...props} rowId={relay.roomId} copyCwd /> : null}
          </PiMenu>
          <GhostIconButton
            label="打开 / 关闭右侧面板 ⌘."
            icon={<PanelRight />}
            forced={paneOpen ? "pressed" : undefined}
            onClick={act.togglePane}
            aria-pressed={isStatic ? undefined : paneOpen}
          />
        </>
      }
    />
  )
}

/**
 * 手机点标题后的会话信息 sheet（PhoneApp 的 sheet 槽，design B06）：同悬停卡的各行（行高 44）+ 描边"重命名" / 黑色"用量明细"。没开时什么都不画。
 */
export function SessionInfoSheet(props: PiContainerProps) {
  const { relay, ui, act } = props
  const head = useSessionHead(props)
  const open = ui.sheet?.id === A_SESSION_INFO && !!relay.roomId
  const branch = useGitBranch(props, open && (!!head.device?.online || !relay.deviceMode))
  if (!open) return null
  return (
    <PiSheet
      title="会话信息"
      onOpenChange={(open) => {
        if (!open) act.closeSheet()
      }}
      footer={
        <>
          <PiButton kind="outline" variant="phone" className="flex-1" onClick={() => openPiDialog(props, { id: PI_UI_IDS.rename, arg: relay.roomId })}>
            重命名
          </PiButton>
          <PiButton variant="phone" className="flex-1" onClick={() => openPiDialog(props, { id: PI_UI_IDS.usage })}>
            用量明细
          </PiButton>
        </>
      }
    >
      <InfoCard p={props} head={head} branch={branch} variant="phone" />
    </PiSheet>
  )
}
