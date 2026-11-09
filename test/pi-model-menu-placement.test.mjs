// Side placement of the model menu's floating card / parameter panel
// (ui/src/components/pi/composer/explainerPlacement.ts): the float opens on
// the menu's right while it fits, and flips left before it would overflow
// the viewport. Pure Node test, same loading style as pi-model.test.mjs.
import test from "node:test"
import assert from "node:assert/strict"
import { explainerSideOf, EXPLAINER_FLOAT_WIDTH, EXPLAINER_VIEWPORT_MARGIN } from "../ui/src/components/pi/composer/explainerPlacement.ts"

test("explainerSideOf: design constants (card width 248, viewport margin 8)", () => {
  assert.equal(EXPLAINER_FLOAT_WIDTH, 248)
  assert.equal(EXPLAINER_VIEWPORT_MARGIN, 8)
})

test("explainerSideOf: a left-anchored menu keeps the float on the right", () => {
  // Menu right edge at 660 in a 1440 viewport: 660 + 8 + 248 = 916 <= 1432.
  assert.equal(explainerSideOf(660, 1440, 8), "right")
})

test("explainerSideOf: a right-anchored menu flips the float to the left", () => {
  // The verified defect (verify-2120 tB-hover): menu right edge near 1190 in
  // a 1440 viewport: 1190 + 8 + 248 = 1446 > 1432, the card ran off screen.
  assert.equal(explainerSideOf(1190, 1440, 8), "left")
})

test("explainerSideOf: the fit boundary is inclusive", () => {
  // 1176 + 8 + 248 = 1432 = 1440 - 8 exactly: still fits on the right.
  assert.equal(explainerSideOf(1176, 1440, 8), "right")
  // One pixel further right no longer fits.
  assert.equal(explainerSideOf(1177, 1440, 8), "left")
})

test("explainerSideOf: gap and float width are parameters, not hard-coded", () => {
  // The static anchor's wider offset (12) flips earlier than the float's 8.
  assert.equal(explainerSideOf(1176, 1440, 12), "left")
  // A narrower float (the 212-wide parameter panel) would still fit where
  // the 248 card does not; the menu deliberately decides with 248 for both.
  assert.equal(explainerSideOf(1177, 1440, 8, 212), "right")
})

test("explainerSideOf: narrow viewports flip unless the menu is near the left edge", () => {
  assert.equal(explainerSideOf(300, 800, 8), "right")
  assert.equal(explainerSideOf(560, 800, 8), "left")
})
