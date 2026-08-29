/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT）— 版本由构建期 define 注入，
 *   而非运行时读 package.json（发布包只含 lib/，不含 package.json 的
 *   可解析路径）。沿用该做法。
 *
 * @module dsh-connect-workbuddy/version
 */

declare const __DSH_WORKBUDDY_VERSION__: string

/** The npm package version this build was produced from. */
export const WORKBUDDY_CONNECT_VERSION: string =
  typeof __DSH_WORKBUDDY_VERSION__ === 'string' && __DSH_WORKBUDDY_VERSION__ !== ''
    ? __DSH_WORKBUDDY_VERSION__
    : '0.0.0-dev'
