/**
 * P10.3「使用活动」dev-only mock 出口。
 * 生产 UI 不 import 本目录：真实数据经 `usage.activity.v1`（relay/extension）进入页面。
 */
export * from "./generate.ts"
export {
  PI_UI_USAGE_FIXTURE_IDS,
  PI_UI_USAGE_FIXTURES,
  PI_UI_USAGE_STATE_IDS,
  PI_UI_USAGE_STATES,
  PI_UI_USAGE_UNAVAILABLE_REASONS,
  formatUsageDayLabel,
  piUiUsageFixtureDayKeys,
  piUiUsageFixtureMeta,
  piUiUsageFixtureMetaOf,
  piUiUsageStateMetaOf,
  type PiUiUsageErrorState,
  type PiUiUsageFixtureMeta,
  type PiUiUsageModelDisplayExpectation,
  type PiUiUsageStateId,
  type PiUiUsageStateMeta,
  type PiUiUsageStates,
  type PiUiUsageUnavailableState,
} from "./fixtures.ts"
