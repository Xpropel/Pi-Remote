/*
 * 模型菜单 Auto 的取值规则（纯函数，测试直接加载，不要引别的模块）。
 * Auto 是本机按设备记的选择：开着时用设备默认模型，菜单里的模型列表置灰、输入框旁的按钮写 "Auto"。
 */

/**
 * 某台设备存下的 Auto：只认 true，没存过 = 关。
 * 不能返回 undefined 让菜单按"当前就是默认模型"去猜：那样菜单里 Auto 亮着、列表置灰，输入框旁的按钮却还写着模型名。
 */
export function modelAutoStored(record: Readonly<Record<string, boolean>>, scope: string): boolean {
  return record[scope] === true
}

/**
 * 菜单里 Auto 实际开没开（开着 = 列表置灰、不能手选）。
 * 没有 Auto 行（设备没报默认模型，或默认模型不在列表里）时恒为关：否则存着的 Auto 会让整张列表一个都选不了。
 * 有 Auto 行时依次取：容器传的受控值 → 菜单自己记的 → 当前模型是不是默认模型（只有画廊静态屏走到这一步）。
 */
export function modelAutoOn({
  showAuto,
  auto,
  internal,
  currentIsDefault,
}: {
  showAuto: boolean
  auto?: boolean
  internal?: boolean | null
  currentIsDefault: boolean
}): boolean {
  if (!showAuto) return false
  return auto ?? internal ?? currentIsDefault
}
