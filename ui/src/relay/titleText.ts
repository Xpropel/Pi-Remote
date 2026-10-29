/**
 * 会话标题文本规则（设计 D §2.1）：首条用户消息作标题素材时的清洗口径，全 UI 一份。
 *
 * 优先级（改名 label → pi 会话名 → 首条消息 → label → cwd 目录名 → id 前缀）不在
 * 这里管——各标题函数（useRelay.roomTitle / attentionRoomTitle / devices 的
 * ListedSession.title）早就同源定版；本模块只钉死"首条消息"这一段的生成规则：
 *  1. 取材：第一条含文本的 user 消息（纯图片/纯附件不作素材，顺延下一条）——
 *     取材发生在生成端（extension 清单/扫描、relay 索引），本模块处理拿到手的文本；
 *  2. 清洗：多行折叠为一行（换行与连续空白 → 单空格）；删除控制字符
 *     （\u0000–\u001F 除空白类外；\u007F 一并删）；首尾去空白。
 *     斜杠命令开头的文本保留原样（`/review xxx` 本身就是意图，不清洗掉）；
 *  3. 截断：数据层上限 80 字，按 Unicode 码点截，绝不切坏代理对；
 *     呈现层截断由侧边栏 ellipsis 负责，两层不重复截。
 *
 * 隐私口径（§2.1-5）：首条消息可能含用户粘贴的敏感文本——标题只在 viewer
 * 已鉴权链路内出现；绝不进页面外通知载荷（设计 D §1.6 定版）；用户改名即
 * 全量覆盖（优先级保证呈现让位，落盘的 firstMessage 不删，改名撤销后可恢复）。
 */
// test/*.test.mjs 用 node 直接跑 .ts 源文件，本文件无导入

/** 标题数据层上限（沿 relay/sessionArchive.js 现行口径）：80 字，按码点算。 */
export const SESSION_TITLE_MAX = 80

/** 按 Unicode 码点截断：展开迭代走码点，代理对不会被切成两半。 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) {
    // 快速路径也要防"UTF-16 长度 ≤ max 但码点数更少"之外的误判：长度 ≤ max 时码点数必 ≤ max
    return text
  }
  return [...text].slice(0, max).join("")
}

/**
 * 首条消息 → 标题文本：清洗折叠 + 80 码点截。入参为空/纯空白/全控制字符时返回 ""，
 * 调用方据此顺延到标题优先级的下一档（label/目录名/id），不要拿空串当标题。
 */
export function cleanSessionTitleText(raw: string | null | undefined): string {
  if (!raw) return ""
  const folded = raw
    // 控制字符删除（\t\n\r 是空白类，留给下一步折叠；其余 \u0000-\u001F 与 \u007F 直接删）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    // 多行与连续空白折叠为单个空格
    .replace(/\s+/g, " ")
    .trim()
  if (!folded) return ""
  return truncateCodePoints(folded, SESSION_TITLE_MAX)
}
