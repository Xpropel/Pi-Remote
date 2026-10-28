import { PiMenu, usePiControllableOpen, type PiMenuProps } from "@/components/pi/shared"
import { PiMenuCloseContext } from "./menuClose"

export type PiCMenuProps = Omit<PiMenuProps, "kind">

/**
 * c 区的锚定菜单（P4，design §4.7 焦点表第 1 行）：shared PiMenu（dropdown）+ 受控 / 非受控 open，
 * 另给菜单内容一个关掉自己的函数（PiMenuCloseContext）：模型列表、目录列表这种 listbox 行不是 Radix Item，选中后要自己关菜单。
 * 静态态和 PiMenu 一样只渲染触发元素。
 */
export function PiCMenu({ open, onOpenChange, children, ...rest }: PiCMenuProps) {
  const [isOpen, setOpen] = usePiControllableOpen(open, onOpenChange)
  return (
    <PiMenu {...rest} open={isOpen} onOpenChange={setOpen}>
      <PiMenuCloseContext.Provider value={() => setOpen(false)}>{children}</PiMenuCloseContext.Provider>
    </PiMenu>
  )
}
