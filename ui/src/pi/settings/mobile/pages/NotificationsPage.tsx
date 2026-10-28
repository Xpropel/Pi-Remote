/**
 * 手机端设置 · 通知（整页 ○ 纯本地；未读角标按 ◐ 只读）。
 *
 * 提醒时机 / 提醒条件 / 提示音：浏览器侧实现，改完即写本机偏好。
 * ◐ 标签页未读角标：现有角标机制同类可借，但“角标本体”尚无扩展桥，先只读呈现 +「需扩展桥」。
 */
import { useSettings } from "../../SettingsContext.tsx"
import {
  MobileGroup,
  MobileNote,
  MobileOptionList,
  MobilePageBody,
  MobileReadOnlyRow,
  MobileRow,
  MobileSwitch,
} from "../atoms.tsx"

const CONDITION_OPTIONS = [
  { value: "away", title: "仅当我不在页面时", description: "正在看的会话不会弹提醒" },
  { value: "always", title: "总是提醒" },
] as const

export function NotificationsPage() {
  const { prefs, act } = useSettings()

  return (
    <MobilePageBody page="notifications">
      <MobileGroup label="提醒时机">
        <MobileRow title="等待你确认时" description="会话停下来等你拍板时提醒">
          <MobileSwitch
            label="等待你确认时提醒"
            checked={prefs.notifyWaiting}
            onChange={(checked) => act.setPref("notifyWaiting", checked)}
          />
        </MobileRow>
        <MobileRow title="出错时" description="构建或运行失败时提醒">
          <MobileSwitch
            label="出错时提醒"
            checked={prefs.notifyError}
            onChange={(checked) => act.setPref("notifyError", checked)}
          />
        </MobileRow>
        <MobileRow title="任务完成时" description="长任务跑完时提醒">
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
        <MobileRow title="提示音" description="提醒出现时播放短提示音">
          <MobileSwitch
            label="提示音"
            checked={prefs.notifySound}
            onChange={(checked) => act.setPref("notifySound", checked)}
          />
        </MobileRow>
        <MobileRow title="未读角标" description="显示待处理数量" status="bridge">
          <MobileSwitch label="未读角标（只读）" checked={prefs.notifyBadge} disabled />
        </MobileRow>
        <MobileReadOnlyRow title="当前方式" value="应用内提醒" />
      </MobileGroup>

      <MobileNote>暂仅支持应用内提醒；离开页面时不会推送。</MobileNote>
    </MobilePageBody>
  )
}
