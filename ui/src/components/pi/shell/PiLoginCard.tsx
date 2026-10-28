import { useId } from "react"
import { cn } from "@/lib/utils"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { PiMark, usePiStatic } from "@/components/pi/shared"
import { APrimaryButton, ATokenInput } from "./parts"

export interface PiLoginCardProps {
  variant: "desktop" | "phone"
  /** relay 地址（脚注） */
  relayHost: string
  /**
   * empty = 空表单（"连接"禁用，design §9.2）；typing = 已输入（"连接"可点）；
   * error = token 错（输入框下红字，已清掉本地 token）；connecting = 按钮内 Spinner
   */
  state?: "empty" | "typing" | "error" | "connecting"
  /** P5（可交互）：输入框里的 token，受控。不传 onValueChange = 静态（画廊截图，值按 state 画） */
  value?: string
  onValueChange?: (value: string) => void
  /** P5：点"连接" / 回车（只在 token 去空白后非空时调用） */
  onSubmit?: () => void
  /** P5：输入框下的红字（relay.authError 的人话）；不传时 error 态用默认文案 */
  errorText?: string
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
  className?: string
}

const DEFAULT_ERROR = "token 不正确，已清除这个浏览器里保存的 token"

/**
 * 登录卡（design A01；compose from kit: Button(solid-black), GhostIconButton；推断：Cursor 帧里没有登录页）。
 * 白卡细描边：PiMark 40 → "连接 Pi-Remote" → 说明 → 密码框 → 黑色"连接"（整宽）→ 脚注 relay 地址。
 * 桌面卡宽 400、输入框 / 按钮高 40；手机卡整宽、高 48，输入框字号 16。
 * 可交互（P5 LoginContainer）：value 受控，"连接"只在 token 去空白后非空时可点（design §9.2），回车同"连接"；token 不进日志。
 */
export function PiLoginCard({ variant, relayHost, state = "empty", value = "", onValueChange, onSubmit, errorText, static: staticProp, className }: PiLoginCardProps) {
  const isStatic = usePiStatic(staticProp)
  const live = !isStatic && onValueChange != null
  const errorId = useId()
  const phone = variant === "phone"
  const scale = phone ? "lg" : "field"
  const ready = value.trim().length > 0
  const connecting = state === "connecting"
  const error = state === "error" ? (errorText ?? DEFAULT_ERROR) : null
  const disabled = live ? !ready || connecting : state === "empty" || state === "error"
  return (
    <form
      data-pi-login-card={state}
      aria-label="连接 Pi-Remote"
      onSubmit={(event) => {
        event.preventDefault()
        if (live && ready && !connecting) onSubmit?.()
      }}
      className={cn(
        "flex flex-col rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-composer)",
        phone ? "w-full px-5 pt-6 pb-5" : "w-[400px] px-8 pt-8 pb-6",
        className,
      )}
    >
      <PiMark size={40} />
      <h1 className="mt-5 mb-0 text-(length:--cw-text-2xl) leading-[26px] font-semibold text-(--cw-text)">连接 Pi-Remote</h1>
      <p className="mt-1.5 mb-0 text-(length:--cw-text-base) leading-[20px] text-(--cw-pi-text-secondary)">
        {/* 手机宽度放不下一行：两句分两行，免得末行只剩「里。」 */}
        输入查看端 token。{phone ? <br /> : null}token 只存在这个浏览器里。
      </p>
      <ATokenInput
        label="查看端 token"
        placeholder="查看端 token"
        value={live ? value : state === "empty" || state === "error" ? "" : "pi-viewer-token-example"}
        scale={scale}
        className="mt-6"
        {...(live ? { onValueChange, autoFocus: true, describedBy: error ? errorId : undefined, invalid: !!error } : {})}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-2 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
          {error}
        </p>
      )}
      <APrimaryButton type="submit" scale={scale} disabled={disabled} className="mt-3 w-full">
        {connecting ? (
          <>
            <PiSpinner size={14} label="正在连接" className="text-(--cw-primary-fg)" />
            正在连接…
          </>
        ) : (
          "连接"
        )}
      </APrimaryButton>
      <p className="mt-4 mb-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">连接到 {relayHost}</p>
    </form>
  )
}
