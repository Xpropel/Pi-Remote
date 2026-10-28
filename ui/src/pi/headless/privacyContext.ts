import { createContext, useContext } from "react"

/**
 * 隐私模式上下文（P13 设置页 v2 宿主消费线）——只放 context / hook，Provider 在同目录 privacy.tsx。
 *
 * 设置页 v2 把隐私模式存在本机偏好 `pi_remote_pi_settings_v2.privacyMode`；宿主在
 * PiApp / 开发画廊的 #/live 读取后经 Provider 交给根节点。根节点只写
 * `data-pi-privacy="on"`（并镜像到 `<html>`），脱敏交给 CSS；**真实数据不动**。
 */
export const PiPrivacyContext = createContext(false)

export function usePiPrivacy(): boolean {
  return useContext(PiPrivacyContext)
}
