/**
 * 设置 › 通知（设计册 §9，源码 settings-set-notifications.html）。
 *
 * 整页 ○ 纯新建：提醒时机 / 条件 / 方式都只存浏览器本机偏好（pi_remote_pi_settings_v2），
 * 改完立即生效并持久化；没有「确定 / 取消」，也不经主机通道。
 *
 * 角标项是浏览器侧的未读标记；设计稿注明「暂仅支持应用内提醒；离开页面时不会推送」，
 * 本页不申请系统通知权限、不伪造系统推送。
 */
import { useSettings } from "../SettingsContext"
import { SettingsGroup, SettingsNote, SettingsPageTitle, SettingsRow, SettingsSwitch } from "../ui"
import "./notifications.css"

function ConditionRow({
  title,
  description,
  checked,
  onSelect,
}: {
  title: string
  description?: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={checked ? "settings-notify-radio is-on" : "settings-notify-radio"}
      onClick={onSelect}
    >
      <span className="settings-notify-ring" aria-hidden="true" />
      <span className="settings-notify-copy">
        <span className="settings-notify-title">{title}</span>
        {description ? <span className="settings-notify-desc">{description}</span> : null}
      </span>
    </button>
  )
}

export function NotificationsPage() {
  const { prefs, act } = useSettings()

  return (
    <div className="settings-page settings-notifications" data-settings-page="notifications">
      <SettingsPageTitle title="通知" />

      <SettingsGroup label="提醒时机" first>
        <SettingsRow title="等待你确认时" description="会话停下来等你拍板时提醒">
          <SettingsSwitch
            label="等待你确认时"
            checked={prefs.notifyWaiting}
            onChange={(checked) => act.setPref("notifyWaiting", checked)}
          />
        </SettingsRow>
        <SettingsRow title="出错时" description="构建或运行失败时提醒">
          <SettingsSwitch
            label="出错时"
            checked={prefs.notifyError}
            onChange={(checked) => act.setPref("notifyError", checked)}
          />
        </SettingsRow>
        <SettingsRow title="任务完成时" description="长任务跑完时提醒">
          <SettingsSwitch
            label="任务完成时"
            checked={prefs.notifyComplete}
            onChange={(checked) => act.setPref("notifyComplete", checked)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="提醒条件">
        <div className="settings-notify-radios" role="radiogroup" aria-label="提醒条件">
          <ConditionRow
            title="仅当我不在页面时"
            description="正在看的会话不会弹提醒"
            checked={prefs.notifyOnlyWhenAway}
            onSelect={() => act.setPref("notifyOnlyWhenAway", true)}
          />
          <ConditionRow
            title="总是提醒"
            checked={!prefs.notifyOnlyWhenAway}
            onSelect={() => act.setPref("notifyOnlyWhenAway", false)}
          />
        </div>
        <SettingsRow title="提示音" description="提醒出现时播放短提示音">
          <SettingsSwitch label="提示音" checked={prefs.notifySound} onChange={(checked) => act.setPref("notifySound", checked)} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="方式">
        <SettingsRow title="当前方式">
          <span className="settings-value">应用内提醒</span>
        </SettingsRow>
        <SettingsRow title="标签页未读角标" description="在浏览器标签标题上显示待处理数量">
          <SettingsSwitch label="标签页未读角标" checked={prefs.notifyBadge} onChange={(checked) => act.setPref("notifyBadge", checked)} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsNote>暂仅支持应用内提醒；离开页面时不会推送。</SettingsNote>
    </div>
  )
}
