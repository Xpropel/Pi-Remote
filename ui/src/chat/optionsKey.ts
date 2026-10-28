/**
 * 选项列表的稳定键。
 *
 * 调用方（projects / inactive 等）每次渲染都传新数组，数组引用每帧都变。
 * 谁要是拿数组引用当"选项变没变"的判断依据，渲染期对齐就会每次重渲都误判为变化，
 * 把高亮/选中态打回第一项——修复等于白做。所以只认 id 序列，不认引用。
 *
 * 用 JSON 而不是 join("|")：id 里带分隔符时后者会把两组不同的选项算成同一个键。
 */
export function optionsKey(options: readonly { id: string }[]): string {
  return JSON.stringify(options.map((o) => o.id))
}
