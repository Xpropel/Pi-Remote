import { useEffect, useState } from "react"
import { Dialog } from "radix-ui"
import {
  PiButton,
  PiDesktopShell,
  PiDeviceMenu,
  PiDialog,
  PiMenu,
  PiOverlay,
  PiPhonePage,
  PiSheet,
  PiStatusLine,
  PiTopBar,
} from "@/components/pi/shared"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { usePiShellShortcuts } from "@/pi/hooks/usePiShellShortcuts"
import { MOCK_DEVICES, MOCK_NOW, mockSessionCounts } from "@/pi/dev/fixtures/gallery/shared"

/*
 * #/play/overlays：p4-base 的浮层原语自测页（不是设计屏，不参加对图）。ui-interact 的 prim-* 用例在这里验：
 * PiDialog / PiSheet 的焦点进出、Tab 圈住、Esc、背后 inert、触发元素没了时回顶栏标题；PiOverlay 直接用（focus=content，灯箱的用法）；
 * PiMenu 的 ↑↓ / Enter 选中 / Esc / 焦点回触发元素；
 * PiStatusLine 的倒计时不进 live region、"已重新连接"到时消失（减少动效时直接消失）。
 */

const OPENER = "inline-flex h-8 items-center rounded-(--cw-radius-button) border border-(--cw-border) bg-(--cw-surface) px-3 text-(length:--cw-text-md) text-(--cw-text)"
const FIELD = "h-(--cw-pi-field-h) w-full rounded-(--cw-radius-input) border border-(--cw-border) bg-(--cw-surface) px-2.5 text-(length:--cw-text-md) text-(--cw-text)"

type DialogId = "input" | "info" | "danger" | "remove" | "viewer"
type LinkDemo = "waiting" | "restored" | "leaving" | null

/** 状态行演示：waiting 每秒倒数（9 → 1 循环）；点"已重新连接"→ 1 秒后淡出 300ms → 卸掉 */
function useLinkDemo() {
  const [link, setLink] = useState<LinkDemo>("waiting")
  const [seconds, setSeconds] = useState(9)
  useEffect(() => {
    if (link !== "waiting") return
    const t = window.setInterval(() => setSeconds((s) => (s <= 1 ? 9 : s - 1)), 1000)
    return () => window.clearInterval(t)
  }, [link])
  useEffect(() => {
    if (link === "restored") {
      const t = window.setTimeout(() => setLink("leaving"), 1000)
      return () => window.clearTimeout(t)
    }
    if (link === "leaving") {
      const t = window.setTimeout(() => setLink(null), 300)
      return () => window.clearTimeout(t)
    }
  }, [link])
  const line = link == null ? null : link === "waiting" ? <PiStatusLine state="waiting" seconds={seconds} attempt={3} /> : <PiStatusLine state="restored" leaving={link === "leaving"} />
  return { line, restore: () => setLink("restored"), link }
}

function DesktopPrimitives() {
  const [dialog, setDialog] = useState<DialogId | null>(null)
  const [removable, setRemovable] = useState(true)
  const [device, setDevice] = useState(MOCK_DEVICES[0]?.id ?? "")
  const demo = useLinkDemo()
  // 没有外壳动作：只为 Esc 分层与"浮层开着时 ⌘ 组合不触发"
  usePiShellShortcuts({ enabled: true, canStop: false })
  const close = () => setDialog(null)
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  return (
    <PiDesktopShell
      sidebar={<div aria-hidden className="h-full w-(--cw-pi-sidebar-w) shrink-0 bg-(--cw-sidebar-bg)" />}
      topBar={<PiTopBar variant="desktop" title="浮层原语自测" showActions={false} />}
      statusLine={demo.line}
    >
      <div data-pi-play-primitives="" className="flex flex-col items-start gap-3 p-10">
        <button type="button" data-cw-id="pi-play-open-dialog" className={OPENER} onClick={() => setDialog("input")}>
          打开改名弹窗（有输入框）
        </button>
        <button type="button" data-cw-id="pi-play-open-info" className={OPENER} onClick={() => setDialog("info")}>
          打开说明弹窗（只有主按钮）
        </button>
        <button type="button" data-cw-id="pi-play-open-danger" className={OPENER} onClick={() => setDialog("danger")}>
          打开删除确认（危险）
        </button>
        {removable && (
          <button type="button" data-cw-id="pi-play-open-remove" className={OPENER} onClick={() => setDialog("remove")}>
            打开会删掉这一行的弹窗
          </button>
        )}
        <button type="button" data-cw-id="pi-play-open-viewer" className={OPENER} onClick={() => setDialog("viewer")}>
          打开全屏浮层（PiOverlay，焦点进容器，灯箱的用法）
        </button>
        <PiMenu
          trigger={
            <button type="button" data-cw-id="pi-play-open-menu" className={OPENER}>
              设备菜单 ∨
            </button>
          }
          align="start"
        >
          <PiDeviceMenu devices={MOCK_DEVICES} counts={mockSessionCounts()} value={device} title="运行在" now={MOCK_NOW} onSelect={setDevice} />
        </PiMenu>
        <button type="button" data-cw-id="pi-play-restore" className={OPENER} onClick={demo.restore} disabled={demo.link !== "waiting"}>
          模拟"已重新连接"
        </button>
        <p data-pi-play-device="" className="m-0 text-(length:--cw-text-sm) text-(--cw-pi-text-secondary)">
          当前设备：{device}
        </p>
      </div>
      <PiDialog
        open={dialog === "input"}
        onOpenChange={onOpenChange}
        title="改名（自测）"
        viewport="desktop"
        width={360}
        footer={
          <>
            <PiButton kind="outline" onClick={close}>
              取消
            </PiButton>
            <PiButton onClick={close}>保存</PiButton>
          </>
        }
      >
        <input data-cw-id="pi-play-dialog-input" aria-label="会话名称" defaultValue="整理 README 的配对步骤" className={FIELD} />
      </PiDialog>
      <PiDialog open={dialog === "info"} onOpenChange={onOpenChange} title="说明（自测）" viewport="desktop" width={360} footer={<PiButton onClick={close}>知道了</PiButton>}>
        <p className="m-0 text-(length:--cw-text-md) text-(--cw-text-2)">没有输入框的弹窗，焦点进主按钮。</p>
      </PiDialog>
      <PiDialog
        open={dialog === "danger"}
        onOpenChange={onOpenChange}
        title="删除会话（自测）"
        danger
        viewport="desktop"
        width={360}
        footer={
          <>
            <PiButton kind="outline" data-pi-autofocus="" onClick={close}>
              取消
            </PiButton>
            <PiButton onClick={close}>删除</PiButton>
          </>
        }
      >
        <p className="m-0 text-(length:--cw-text-md) text-(--cw-text-2)">危险确认弹窗，焦点进"取消"。</p>
      </PiDialog>
      <PiDialog
        open={dialog === "remove"}
        onOpenChange={onOpenChange}
        title="删掉触发元素（自测）"
        viewport="desktop"
        width={360}
        footer={
          <PiButton
            data-cw-id="pi-play-remove-confirm"
            onClick={() => {
              setRemovable(false)
              close()
            }}
          >
            删除这一行
          </PiButton>
        }
      >
        <p className="m-0 text-(length:--cw-text-md) text-(--cw-text-2)">关闭后触发它的按钮已经不在页面上，焦点回顶栏标题。</p>
      </PiDialog>
      <PiOverlay
        open={dialog === "viewer"}
        onOpenChange={onOpenChange}
        label="全屏浮层（自测）"
        focus="content"
        backdrop={false}
        contentData={{ "data-pi-play-viewer": "" }}
        className="absolute inset-0 flex items-center justify-center bg-(--cw-pi-lightbox-bg)"
      >
        <div className="flex items-center gap-3">
          <button type="button" className={OPENER}>
            上一张
          </button>
          <button type="button" className={OPENER}>
            下一张
          </button>
          <Dialog.Close asChild>
            <button type="button" className={OPENER}>
              关闭
            </button>
          </Dialog.Close>
        </div>
      </PiOverlay>
    </PiDesktopShell>
  )
}

function PhonePrimitives() {
  const [sheet, setSheet] = useState<"list" | "rename" | null>(null)
  const close = () => setSheet(null)
  return (
    <PiPhonePage
      topBar={<PiTopBar variant="phone-page" title="浮层原语自测" />}
      sheet={
        <>
          <PiSheet
            open={sheet === "list"}
            onOpenChange={(open) => !open && close()}
            title="选择设备（自测）"
            footer={
              <PiButton variant="phone" className="flex-1" onClick={close}>
                完成
              </PiButton>
            }
          >
            <div data-pi-play-sheet-list="" className="flex flex-col gap-2 px-2 pb-2">
              {MOCK_DEVICES.slice(0, 3).map((d) => (
                <PiButton key={d.id} kind="outline" variant="phone" className="w-full" onClick={close}>
                  {d.name}
                </PiButton>
              ))}
            </div>
          </PiSheet>
          <PiDialog
            open={sheet === "rename"}
            onOpenChange={(open) => !open && close()}
            title="改名（自测）"
            viewport="phone"
            footer={
              <PiButton variant="phone" className="flex-1" onClick={close}>
                保存
              </PiButton>
            }
          >
            <input data-cw-id="pi-play-sheet-input" aria-label="会话名称" defaultValue="整理 README 的配对步骤" className={FIELD} />
          </PiDialog>
        </>
      }
    >
      <div data-pi-play-primitives="" className="flex flex-col items-start gap-3 p-4">
        <button type="button" data-cw-id="pi-play-open-sheet" className={OPENER} onClick={() => setSheet("list")}>
          打开 sheet（按钮列表）
        </button>
        <button type="button" data-cw-id="pi-play-open-rename-sheet" className={OPENER} onClick={() => setSheet("rename")}>
          打开改名（手机弹窗 = 全高 sheet）
        </button>
      </div>
    </PiPhonePage>
  )
}

export function PlayPrimitives({ viewport }: { viewport: PiLayout }) {
  return viewport === "phone" ? <PhonePrimitives /> : <DesktopPrimitives />
}
