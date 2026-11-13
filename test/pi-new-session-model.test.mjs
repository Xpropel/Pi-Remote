// 模型菜单 Auto 已整体移除（2026-11-13 用户裁决：「我们就没有 auto 模型」）：
// 菜单只剩搜索 + 已配置模型列表，输入框旁的按钮永远写当前实际模型名；
// 原 pi-model-auto.test.mjs 的 Auto 规则与接线断言随 Auto 一起删除，本文件只留两组：
// 1. 「没有 Auto 了」的回归钉（菜单 / 容器 / 存储层都不许再出现 Auto）；
// 2. 从 pi-model-auto.test.mjs 搬来的新会话页一组——新会话页只读显示设备默认模型，
//    那是另一回事（不是 Auto 行），行为不变、断言原样保留。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

describe("模型菜单不再有 Auto", () => {
  test("PiModelMenu：没有 Auto 行、没有 Auto 开关、props 不再收 defaultModel / auto / onAutoChange", () => {
    const src = read("components/pi/composer/PiModelMenu.tsx")
    assert.doesNotMatch(src, /pi-model-auto/)
    assert.doesNotMatch(src, /ModelAutoRow|modelAutoOn|autoOn|showAuto/)
    assert.doesNotMatch(src, /Auto：使用设备默认模型/)
    assert.doesNotMatch(src, /defaultModel\?|auto\?:|onAutoChange\?:/)
  })

  test("Auto 规则模块已删除，容器与共享层不再有 Auto 接线与存储", () => {
    assert.equal(fs.existsSync(new URL("../ui/src/components/pi/composer/modelAuto.ts", import.meta.url)), false)
    const container = read("pi/containers/ComposerContainer.tsx")
    assert.doesNotMatch(container, /useModelAuto|modelAuto|onAutoChange/)
    assert.doesNotMatch(container, /name: "Auto"/)
    const shared = read("pi/containers/cShared.ts")
    assert.doesNotMatch(shared, /useModelAuto|MODEL_AUTO|modelAuto/)
  })

  test("输入框旁的模型按钮永远显示当前实际模型（modelPillOf），不写 Auto", () => {
    const src = read("pi/containers/ComposerContainer.tsx")
    assert.match(src, /model=\{modelPillOf\(relay\)\}/)
  })
})

describe("新会话页的模型：只读显示设备默认模型，绝不向已有房间发命令", () => {
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  const fnBody = (src, head) => {
    const at = src.indexOf(head)
    assert.ok(at >= 0, `找不到 ${head}`)
    const next = src.slice(at + head.length).search(/\n(?:export )?(?:function|const) /)
    return next < 0 ? src.slice(at) : src.slice(at, at + head.length + next)
  }

  test("NewSessionContainer：不挂模型菜单 / sheet，不碰 set_model、set_thinking_level、Auto", () => {
    const src = code(read("pi/containers/NewSessionContainer.tsx"))
    for (const bad of [/ModelMenuContent/, /useModelActions/, /set_model/, /set_thinking_level/, /setThinking|setModel\(/, /useModelAuto/, /useModelData/, /modelMenu=/, /C_IDS\.newModel/, /runCommand\(/]) {
      assert.doesNotMatch(src, bad, `新会话页不该出现 ${bad}`)
    }
    assert.match(src, /const modelName = useDeviceDefaultModelName\(relay, device\?\.id \?\? null\) \?\? EMPTY_MODEL_FALLBACK/)
    assert.match(src, /model=\{\{ name: modelName, thinking: "" \}\}/)
  })

  test("useDeviceDefaultModelName：只发只读的 get_available_models，且只问同一台设备上的当前房间", () => {
    const body = code(fnBody(read("pi/containers/cShared.ts"), "export function useDeviceDefaultModelName("))
    assert.match(body, /currentRoomDeviceId\(relay\) === deviceId && commandsReady\(relay\)/)
    assert.match(body, /ready \? "get_available_models" : null/)
    assert.deepEqual(body.match(/"[a-z]+_[a-z_]+"/g), ['"get_available_models"'], "只有这一条命令")
    assert.doesNotMatch(body, /set_|runCommand\(/)
    assert.match(body, /return name \? modelPillName\(\{ model: name \}\) : null/)
    assert.doesNotMatch(read("pi/containers/cShared.ts"), /newModel:/, "C_IDS 里没有新会话页的模型菜单 id")
  })

  test("PiEmptyComposer：模型是静态文字（不是按钮、没有菜单），配一句说明；拿不到名字写「设备默认模型」", () => {
    const src = code(read("components/pi/composer/PiEmptyComposer.tsx"))
    assert.doesNotMatch(src, /withMenu\(\s*"model"/)
    assert.doesNotMatch(src, /sheetClick\("model"/)
    const at = src.indexOf('data-cw-id="pi-new-model"')
    assert.equal(src.slice(src.lastIndexOf("<", at), at).trim(), "<div", "模型显示是 div，不是按钮 / TextSelector")
    const block = src.slice(at, src.indexOf("</div>", at))
    assert.doesNotMatch(block, /aria-haspopup|onClick|tabIndex/)
    assert.match(block, /\{modelLabel\}[\s\S]*\{modelNote\}/)
    assert.match(src, /export const EMPTY_MODEL_FALLBACK = "设备默认模型"/)
    assert.match(src, /export const EMPTY_MODEL_NOTE = "开始后可在输入框里切换"/)
  })
})
