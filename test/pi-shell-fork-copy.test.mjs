import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { forkEntryIdForTurn, forkTurnOf } from "../ui/src/pi/model/transcriptView.ts"
import { PI_COPIED_MS, piCopyText } from "../ui/src/components/pi/conversation/clipboard.ts"

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

describe("reply fork helpers & UI wiring", () => {
  const items = [
    { kind: "user", key: "u1", text: "first question", images: [] },
    { kind: "assistant", key: "a1", blocks: [{ kind: "text", text: "first answer" }] },
    { kind: "user", key: "u2", text: "second question", images: [] },
    { kind: "assistant", key: "a2", blocks: [{ kind: "text", text: "second answer" }] },
    { kind: "user", key: "u3-queued", text: "queued msg", images: [], status: "awaiting" },
    { kind: "user", key: "u4-failed", text: "failed msg", images: [], failed: true },
  ]

  test("forkTurnOf ignores awaiting/failed user items and identifies latest vs earlier turns", () => {
    assert.deepEqual(forkTurnOf(items, "a2"), {
      fromEnd: 0,
      isLatest: true,
      userText: "second question",
    })
    assert.deepEqual(forkTurnOf(items, "a1"), {
      fromEnd: 1,
      isLatest: false,
      userText: "first question",
    })
    assert.equal(forkTurnOf(items, "missing"), null)
  })

  test("forkEntryIdForTurn resolves earlier turn entry ID via path / onPath / parentId even when history head is truncated", () => {
    const fullTree = {
      path: ["s0", "m0", "e-u0", "e-a0", "e-u1", "e-a1", "e-u2", "e-t2", "e-a2"],
      leafId: "e-a2",
      tree: [
        {
          entry: { id: "s0", parentId: null, type: "session" },
          children: [
            {
              entry: { id: "m0", parentId: "s0", type: "model_change" },
              children: [
                {
                  entry: { id: "e-u0", parentId: "m0", type: "message", role: "user", preview: "old question" },
                  children: [
                    {
                      entry: { id: "e-a0", parentId: "e-u0", type: "message", role: "assistant" },
                      children: [
                        {
                          entry: { id: "e-u1", parentId: "e-a0", type: "message", role: "user", preview: "first question" },
                          children: [
                            {
                              entry: { id: "e-a1", parentId: "e-u1", type: "message", role: "assistant" },
                              children: [
                                {
                                  entry: { id: "e-u2", parentId: "e-a1", type: "message", role: "user", preview: "second question" },
                                  children: [
                                    {
                                      entry: { id: "e-t2", parentId: "e-u2", type: "message", role: "toolResult" },
                                      children: [{ entry: { id: "e-a2", parentId: "e-t2", type: "message", role: "assistant" }, children: [] }],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const turn1 = forkTurnOf(items, "a1")
    assert.ok(turn1)
    assert.equal(forkEntryIdForTurn(fullTree, turn1), "e-a1")

    const turn2 = forkTurnOf(items, "a2")
    assert.ok(turn2)
    assert.equal(forkEntryIdForTurn(fullTree, turn2), "e-a2")

    // Falls back cleanly when only leafId + parentId links are provided (no path/onPath)
    const minimalTree = { leafId: "e-a2", tree: fullTree.tree }
    assert.equal(forkEntryIdForTurn(minimalTree, turn1), "e-a1")
  })

  test("PiTurnParts & TranscriptContainer wire fork button and checkmark copy state", () => {
    const parts = code(read("ui/src/components/pi/conversation/PiTurnParts.tsx"))
    assert.match(parts, /data-cw-id="pi-reply-copy"/)
    assert.match(parts, /data-copied=\{copied \? "true" : undefined\}/)
    assert.match(parts, /text-\(--cw-green\)/)
    assert.match(parts, /data-cw-id="pi-reply-fork"/)
    assert.match(parts, /\(copied \|\| forking\) && "opacity-100"/)

    const container = code(read("ui/src/pi/containers/TranscriptContainer.tsx"))
    assert.match(container, /forkReply:\s*async\s*\(item\)/)
    assert.match(container, /runCommand\("clone"\)/)
    assert.match(container, /runCommand\("get_tree"\)/)
    assert.match(container, /runCommand\("fork", \{ entryId, position: "at" \}\)/)
    assert.match(container, /forkingRef\.current/)
    assert.match(container, /forkSessionFile\(targetPath/)
    assert.match(container, /请等待当前回复结束后再分叉/)

    const dialogs = code(read("ui/src/pi/containers/DialogsContainer.tsx"))
    assert.match(dialogs, /runCommand\("fork", \{ entryId, position: "before" \}\)/)
    assert.match(dialogs, /lazy\.id === relay\.roomId/)
    assert.match(dialogs, /forkedSessionRow\(data\)/)
    assert.match(dialogs, /selectListedSession\(forked\)/)

    const transcript = code(read("ui/src/components/pi/conversation/PiTranscript.tsx"))
    assert.match(transcript, /\(!end\?\.error \|\| turnHasText\)/)
    assert.match(transcript, /\[&_\[data-cw-id=pi-reply-copy\]\]:hidden/)
  })

  test("forkTurnOf ignores queued/sending items and forkEntryIdForTurn handles image-only turns cleanly", () => {
    const withQueued = [
      { kind: "user", key: "u1", text: "  first question  ", images: [] },
      { kind: "assistant", key: "a1", blocks: [{ kind: "text", text: "first answer" }] },
      { kind: "user", key: "u-img", text: "", images: [] },
      { kind: "assistant", key: "a-img", blocks: [{ kind: "text", text: "image answer" }] },
      { kind: "user", key: "u-sending", text: "sending", images: [], status: "sending" },
      { kind: "user", key: "u-queued", text: "queued", images: [], queued: true },
    ]
    const imgTurn = forkTurnOf(withQueued, "a-img")
    assert.deepEqual(imgTurn, { fromEnd: 0, isLatest: true, userText: "" })

    const firstTurn = forkTurnOf(withQueued, "a1")
    assert.deepEqual(firstTurn, { fromEnd: 1, isLatest: false, userText: "first question" })

    // Reordered / drifted tree with empty-preview image turn at slot 0 must not wildcard-match a text turn
    const tree = {
      path: ["u-img", "a-img", "u1", "a1", "t1", "x-other"],
      leafId: "x-other",
      tree: [
        {
          entry: { id: "u-img", parentId: null, type: "message", role: "user", preview: "" },
          children: [
            {
              entry: { id: "a-img", parentId: "u-img", type: "message", role: "assistant" },
              children: [
                {
                  entry: { id: "u1", parentId: "a-img", type: "message", role: "user", preview: "first question truncated" },
                  children: [
                    {
                      entry: { id: "a1", parentId: "u1", type: "message", role: "assistant" },
                      children: [
                        {
                          entry: { id: "t1", parentId: "a1", type: "message", role: "toolResult" },
                          children: [{ entry: { id: "x-other", parentId: "t1", type: "custom" }, children: [] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    assert.equal(forkEntryIdForTurn(tree, firstTurn), "t1")
    assert.equal(forkEntryIdForTurn(tree, imgTurn), "a-img")
  })
})

describe("HTTP clipboard copy fallback & feedback duration", () => {
  test("PI_COPIED_MS is 1500ms", () => {
    assert.equal(PI_COPIED_MS, 1500)
  })

  test("piCopyText rejects empty string immediately", async () => {
    assert.equal(await piCopyText(""), false)
  })

  test("piCopyText uses synchronous textarea execCommand fallback on insecure HTTP and restores focus", async () => {
    const prevWindow = globalThis.window
    const prevDocument = globalThis.document
    const prevNavigator = globalThis.navigator
    const prevHTMLElement = globalThis.HTMLElement

    class FakeEl {}
    let restored = 0
    const prevFocus = new FakeEl()
    prevFocus.focus = () => {
      restored += 1
    }

    let appended = null
    let removed = 0
    let focusedTa = 0
    let selected = 0
    let selectionRange = null
    let execCmd = null
    let asyncClipboardCalled = false

    const ta = {
      value: "",
      style: {},
      attributes: new Map(),
      setAttribute(k, v) {
        this.attributes.set(k, v)
      },
      focus() {
        focusedTa += 1
      },
      select() {
        selected += 1
      },
      setSelectionRange(a, b) {
        selectionRange = [a, b]
      },
      remove() {
        removed += 1
      },
    }

    Object.defineProperty(globalThis, "HTMLElement", { value: FakeEl, configurable: true })
    Object.defineProperty(globalThis, "window", { value: { isSecureContext: false }, configurable: true })
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async () => {
            asyncClipboardCalled = true
          },
        },
      },
      configurable: true,
    })
    Object.defineProperty(globalThis, "document", {
      value: {
        activeElement: prevFocus,
        body: {
          appendChild(el) {
            appended = el
          },
        },
        createElement(tag) {
          assert.equal(tag, "textarea")
          return ta
        },
        execCommand(cmd) {
          execCmd = cmd
          return true
        },
      },
      configurable: true,
    })

    try {
      const ok = await piCopyText("Hello clipboard!")
      assert.equal(ok, true)
      assert.equal(asyncClipboardCalled, false)
      assert.equal(appended, ta)
      assert.equal(ta.value, "Hello clipboard!")
      assert.equal(ta.style.left, "-9999px")
      assert.equal(focusedTa, 1)
      assert.equal(selected, 1)
      assert.deepEqual(selectionRange, [0, "Hello clipboard!".length])
      assert.equal(execCmd, "copy")
      assert.equal(removed, 1)
      assert.equal(restored, 1)
    } finally {
      Object.defineProperty(globalThis, "HTMLElement", { value: prevHTMLElement, configurable: true })
      Object.defineProperty(globalThis, "window", { value: prevWindow, configurable: true })
      Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true })
      Object.defineProperty(globalThis, "document", { value: prevDocument, configurable: true })
    }
  })
})

describe("interactive PTY shell contracts across UI, relay, and extension", () => {
  test("PiShellPane drives xterm over shell_open, shell_input, shell_resize and subscribeShellEvents", () => {
    const pane = code(read("ui/src/components/pi/conversation/PiShellPane.tsx"))
    assert.match(pane, /data-cw-id="pi-shell-viewport"/)
    assert.match(pane, /data-cw-id="pi-shell-sigint"/)
    assert.match(pane, /data-cw-id="pi-shell-clear"/)
    assert.match(pane, /data-cw-id="pi-shell-copy"/)
    assert.match(pane, /data-cw-id="pi-shell-restart"/)
    assert.match(pane, /runCommand\("shell_open"/)
    assert.match(pane, /runCommand\("shell_input"/)
    assert.match(pane, /runCommand\("shell_resize"/)
    assert.match(pane, /subscribeShellEvents\(/)
  })

  test("PaneContainer and PiPaneTabs integrate shell view", () => {
    const container = code(read("ui/src/pi/containers/PaneContainer.tsx"))
    assert.match(container, /view === "shell"/)
    assert.match(container, /<PiShellPane\b/)
    assert.match(container, /showShell/)

    const tabs = code(read("ui/src/components/pi/conversation/PiPaneTabs.tsx"))
    assert.match(tabs, /id:\s*"shell"/)
    assert.match(tabs, /cwId:\s*"pi-pane-tab-shell"/)
    assert.match(tabs, /data-cw-id="pi-pane-rail-shell"/)
  })

  test("extension implements shell commands, encrypted-room guard, and token env stripping", () => {
    const ext = read("extension/pi-remote-sync.ts")
    for (const cmd of ["shell_open", "shell_input", "shell_resize", "shell_close"]) {
      assert.match(ext, new RegExp(`case "${cmd}"`))
    }
    assert.match(ext, /PI_REMOTE_DISABLE_SHELL/)
    assert.match(ext, /Encrypted rooms do not support plaintext interactive shell/)
    for (const tok of ["PI_REMOTE_TOKEN", "PI_REMOTE_DEVICE_TOKEN", "PI_REMOTE_VIEWER_TOKEN", "PI_REMOTE_ADMIN_TOKEN", "PI_REMOTE_LOCAL_TOKEN"]) {
      assert.match(ext, new RegExp(tok))
    }
    assert.match(ext, /e\.message\.role === "user"/)
  })
})
