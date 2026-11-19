/**
 * 手机端设置 · 通知（整页 ○ 纯本地；未读角标按 ◐ 只读）。
 *
 * 提醒时机 / 提醒条件 / 提示音：浏览器侧实现，改完即写本机偏好。
 * ◐ 标签页未读角标：现有角标机制同类可借，但“角标本体”尚无扩展桥，先只读呈现 +「需扩展桥」。
 */
import { useSettings } from "../../SettingsContext.tsx"
import {
  MobileGroup,
  MobileOptionList,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
  MobileSwitch,
} from "../atoms.tsx"

const CONDITION_OPTIONS = [
  { value: "away", title: "仅当我不在页面时" },
  { value: "always", title: "总是提醒" },
] as const

export function NotificationsPage() {
  const { prefs, act } = useSettings()

  const toggleSystemNotify = (checked: boolean) => {
    if (!checked) {
      act.setPref("notifySystem", false)
      return
    }
    if (typeof Notification === "undefined") {
      act.notify("当前浏览器不支持系统通知", "warn")
      return
    }
    if (Notification.permission === "granted") {
      act.setPref("notifySystem", true)
      return
    }
    if (Notification.permission === "denied") {
      act.notify("浏览器已拦截系统通知，请在站点权限中开启", "warn")
      return
    }
    void Notification.requestPermission().then((perm) => {
      if (perm === "granted") act.setPref("notifySystem", true)
      else act.notify("未授予系统通知权限", "warn")
    })
  }

  return (
    <MobilePageBody page="notifications">
      <MobileGroup label="提醒时机">
        <MobileRow title="等你回答时">
          <MobileSwitch
            label="等你回答时提醒"
            checked={prefs.notifyWaiting}
            onChange={(checked) => act.setPref("notifyWaiting", checked)}
          />
        </MobileRow>
        <MobileRow title="出错时">
          <MobileSwitch
            label="出错时提醒"
            checked={prefs.notifyError}
            onChange={(checked) => act.setPref("notifyError", checked)}
          />
        </MobileRow>
        <MobileRow title="任务完成时">
          <MobileSwitch
            label="任务完成时提醒"
            checked={prefs.notifyComplete}
            onChange={(checked) => act.setPref("notifyComplete", checked)}
          />
        </MobileRow>
      </MobileGroup>

      <MobileGroup label="提醒条件">
        <MobileOptionList
          label="提醒条件"
          marker="radio"
          value={prefs.notifyOnlyWhenAway ? "away" : "always"}
          options={CONDITION_OPTIONS}
          onChange={(value) => act.setPref("notifyOnlyWhenAway", value === "away")}
        />
      </MobileGroup>

      <MobileGroup label="方式">
        <MobileRow title="提示音">
          <MobileSwitch
            label="提示音"
            checked={prefs.notifySound}
            onChange={(checked) => act.setPref("notifySound", checked)}
          />
        </MobileRow>
        <MobileRow title="未读角标">
          <MobileSwitch label="未读角标" checked={prefs.notifyBadge} onChange={(checked) => act.setPref("notifyBadge", checked)} />
        </MobileRow>
        <MobileRow title="系统桌面通知" tooltip="离开页面时通过浏览器发送系统通知（不含对话正文）">
          <MobileSwitch label="系统桌面通知" checked={prefs.notifySystem} onChange={toggleSystemNotify} />
        </MobileRow>
        <MobileReadOnlyRow title="当前方式" value={prefs.notifySystem ? "应用内提醒 + 系统通知" : "应用内提醒"} />
      </MobileGroup>
    </MobilePageBody>
  )
}
