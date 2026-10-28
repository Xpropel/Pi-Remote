/**
 * 发送键偏好 → composer 的 React context（无视觉）。
 *
 * `PiSettingsHost` 已从 `pi_remote_pi_settings_v2` 读出 prefs.sendKey，
 * 用 Provider 交给三套桌面 / 三套手机 composer；设置页改完立即生效，不需要刷新。
 * 没有 Provider 的静态画廊 / 独立部件保持旧行为（Enter 发送）。
 */
import { createContext, useContext } from "react"
import { PI_SEND_KEY_DEFAULT, type PiSendKey } from "./composerSendKey"

export const PiSendKeyContext = createContext<PiSendKey>(PI_SEND_KEY_DEFAULT)

/** 当前 composer 应消费的发送键；无 Provider = enter（旧行为）。 */
export function usePiSendKey(): PiSendKey {
  return useContext(PiSendKeyContext)
}
