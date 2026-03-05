# @relensdev/relens Changelog

All notable changes to the `@relensdev/relens` npm package.

## [Unreleased]

## [0.2.1] - 2026-03-04

### Changed
- Package renamed from `relens` to `@relensdev/relens`
- Source files included in package for editor Go-to-Definition support

## [0.2.0] - 2026-03-04

Initial release.

### Added
- `<RelensProvider>` component with React Profiler API integration
- Configuration: `enabled`, `maxEntries`, `sampleRate`, `filter`, `network`, `userEvents`, `instanceId`
- Fiber tree walker: per-component selfDuration, changedProps, renderCause, effects
- Off-thread processing via Web Worker ring buffer
- Network interceptor: fetch/XHR with ref-counted install guard
- User event capture: clicks, input, keydown, scroll, submit, focus, blur
- Zero overhead when `enabled={false}`
- Production dead code elimination (Fragment in production builds)
