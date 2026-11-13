// 模型菜单 Auto 的回归（第一轮 S4 修的两处）：
// 1. Auto 默认关——没存过选择时，菜单不能按"当前就是默认模型"把 Auto 点亮、把列表置灰，
//    否则菜单写着 Auto、输入框旁的按钮却还写着模型名；
// 2. 设备没报默认模型（不出 Auto 行）时列表不置灰——存着的 Auto 不能让整张列表一个都选不了。
// 规则在 composer/modelAuto.ts（纯函数）；下面再钉住菜单与容器都走这两个函数。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { modelAutoOn, modelAutoStored } from "../ui/src/components/pi/composer/modelAuto.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

describe("modelAutoStored：Auto 默认关", () => {
  test("没存过 = 关", () => {
    assert.equal(modelAutoStored({}, "dev-1"), false)
  })

  test("只认本设备存下的 true", () => {
    assert.equal(modelAutoStored({ "dev-1": true }, "dev-1"), true)
    assert.equal(modelAutoStored({ "dev-1": false }, "dev-1"), false)
    assert.equal(modelAutoStored({ "dev-2": true }, "dev-1"), false)
    assert.equal(modelAutoStored({ local: true }, "dev-1"), false)
  })
})

describe("modelAutoOn：开着才置灰列表", () => {
  test("没有 Auto 行（设备没报默认模型）：受控 true、菜单内部 true、当前即默认，都不置灰", () => {
    for (const input of [{ auto: true }, { internal: true }, { currentIsDefault: true }, { auto: true, internal: true, currentIsDefault: true }]) {
      assert.equal(modelAutoOn({ showAuto: false, currentIsDefault: false, ...input }), false, JSON.stringify(input))
    }
  })

  test("有 Auto 行、受控 false：当前就是默认模型也不置灰（产品里容器总会传受控值）", () => {
    assert.equal(modelAutoOn({ showAuto: true, auto: false, currentIsDefault: true }), false)
    assert.equal(modelAutoOn({ showAuto: true, auto: false, internal: true, currentIsDefault: true }), false)
  })

  test("有 Auto 行、受控 true：置灰", () => {
    assert.equal(modelAutoOn({ showAuto: true, auto: true, currentIsDefault: false }), true)
  })

  test("没受控（画廊静态屏）：先看菜单自己记的，再看当前是不是默认模型", () => {
    assert.equal(modelAutoOn({ showAuto: true, internal: false, currentIsDefault: true }), false)
    assert.equal(modelAutoOn({ showAuto: true, internal: true, currentIsDefault: false }), true)
    assert.equal(modelAutoOn({ showAuto: true, internal: null, currentIsDefault: true }), true)
    assert.equal(modelAutoOn({ showAuto: true, currentIsDefault: false }), false)
  })

  test("组合：新设备第一次打开菜单（当前正是默认模型）= Auto 关、列表可选", () => {
    const auto = modelAutoStored({}, "dev-1")
    assert.equal(modelAutoOn({ showAuto: true, auto, currentIsDefault: true }), false)
  })

  test("组合：存着 Auto、设备没报默认模型 = 列表可选", () => {
    const auto = modelAutoStored({ "dev-1": true }, "dev-1")
    assert.equal(modelAutoOn({ showAuto: false, auto, currentIsDefault: false }), false)
  })
})

describe("接线：菜单与容器都走这两条规则", () => {
  test("useModelAuto 的值来自 modelAutoStored", () => {
    assert.match(read("pi/containers/cShared.ts"), /return \{ auto: modelAutoStored\(record, scope\), setAuto \}/)
  })

  test("三种模型菜单（静态 / 桌面可交互 / 手机 sheet）都用 modelAutoOn，不再各写一份", () => {
    const src = read("components/pi/composer/PiModelMenu.tsx")
    assert.equal((src.match(/const autoOn = modelAutoOn\(\{[^}]*\}\)/g) ?? []).length, 3)
    assert.doesNotMatch(src, /const autoOn = (?!modelAutoOn\()/)
    assert.match(src, /const showAuto = !!defaultModel && defaultAvailable/)
  })

  test("追问框：菜单拿受控值，输入框旁的按钮在 Auto 开着时写 Auto（新会话页没有模型菜单，见下）", () => {
    const p = "pi/containers/ComposerContainer.tsx"
    const src = read(p)
    assert.ok((src.match(/auto=\{modelAuto\.auto\}/g) ?? []).length >= 2, `${p}：桌面与手机菜单都要传 auto`)
    assert.match(src, /model=\{modelAuto\.auto \? \{ name: "Auto", thinking: "" \} : modelPillOf\(relay\)\}/)
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
