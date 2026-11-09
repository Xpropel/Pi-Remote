// Side placement for the model menu's floating card / parameter panel.
//
// The float normally opens on the menu's right side. When the menu sits near
// the viewport's right edge there is no room for the float there, so it flips
// to the menu's left side instead of overflowing off screen. One formula
// serves both floats (the explainer card and the parameter panel render in
// the same slot): the caller measures the menu card's right edge and passes
// the gap the float keeps from the menu.

export type ExplainerSide = "right" | "left"

/** Width reserved for the side float when deciding the side (the explainer card is 248 wide) */
export const EXPLAINER_FLOAT_WIDTH = 248

/** Minimum margin between the float and the viewport edge */
export const EXPLAINER_VIEWPORT_MARGIN = 8

/**
 * The side the float opens on: "right" while menuRight + gap + floatWidth
 * still fits inside the viewport (minus the edge margin), "left" otherwise.
 */
export function explainerSideOf(menuRight: number, viewportWidth: number, gap: number, floatWidth: number = EXPLAINER_FLOAT_WIDTH): ExplainerSide {
  return menuRight + gap + floatWidth <= viewportWidth - EXPLAINER_VIEWPORT_MARGIN ? "right" : "left"
}
