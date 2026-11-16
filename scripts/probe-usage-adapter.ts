/**
 * 阶段 E 真实上游 usage 适配（纯函数，零依赖、零 IO）。
 *
 * 独立于 `probe-stable-conversation-id-real.mjs` 的原因是：与项目既定架构一致
 * （`probe-core.ts` 放纯逻辑、driver 只做 I/O 与编排），并且让单元测试可以只 import
 * 本模块 + `probe-core.ts`，不把构建产物 `lib/index.js` 拖进 vitest。用 `.ts` 后缀
 * 是为了让 `tests/` 的静态 import 得到真实类型检查（driver 以 Node 24 类型擦除
 * 直接 import `./probe-core.ts`，同样能吃 `.ts`）。
 *
 * 背景（E3 1 组 smoke、正式数据出现前发现，见 docs/E-PHASE-FROZEN-PLAN.md §11）：
 *   `hy4free` / CN 的终态 usage 同时给出规范计数对
 *     `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（命中时 7936 / 112，
 *     `prompt_tokens = 8048 = hit + miss`，完全自洽），以及两个冗余命中量字段：
 *     `prompt_tokens_details.cached_tokens`（=== hit，7936）和顶层 `cached_tokens`
 *     （cold/warm 恒为 0，与 prompt 缓存无关，是上游惰性占位）。
 *   离线设计（防御式）的 `normalizeUsage` 用 `cached = cachedTop ?? cachedDetails`，
 *   取到顶层 0 而非 details 7936，于是 `hitSources=[7936,7936,0]` 触发
 *   HIT_SOURCE_CONFLICT，`cpRate=0` 与 `hmRate=0.986` 触发 RATE_CONFLICT，
 *   每个 ON warm 轮被误判 invalid（OFF warm hit=0 不受影响）——这是 scorer 对
 *   真实冗余 schema 的误报，不是数据问题。
 *
 * 本适配是**唯一且最小**的处理：当且仅当规范 hit/miss 计数对都存在（number）时，
 * 从浅副本里删除顶层 `cached_tokens` 这一个恒 0 冗余字段。于是：
 *   - `cached` 回退到 `prompt_tokens_details.cached_tokens`（=== hit），
 *   - 保留 `prompt_tokens`（⇒ PARTITION_CONFLICT 护栏仍生效）、
 *   - 保留 `prompt_tokens_details.cached_tokens`（⇒ HIT_SOURCE_CONFLICT 护栏仍生效）、
 *   - rate 仍走主口径 `hit/(hit+miss)`，cpRate 仅作交叉校验，不静默选有利口径。
 *
 * 关键性质（「会咬」测试覆盖，见 tests/probe-real-adapter.spec.ts）：
 *   - 对 OFF/ON、cold/warm **完全一致**：不读 hit/miss 的取值，只看是否为 number；
 *     被删字段在所有观测轮次恒为 0，删它不可能偏袒任一臂或任何有利结果。
 *   - 不修改 `probe-core.ts`（A–D 冻结哈希不变），只在 E driver 边界做适配。
 *   - 缺任一规范计数 ⇒ 原样返回（不适配，让离线 scorer 自己判缺字段/无效）。
 *   - 原对象不变（返回副本）；非对象/null/数组原样返回。
 *   - 绝不删除 `prompt_tokens` / `prompt_tokens_details`：删掉任何一个都会让
 *     PARTITION_CONFLICT / HIT_SOURCE_CONFLICT 护栏失效，这是护栏保留断言要咬的点。
 *
 * 不展示任何真实账号 / token / ID / 路径；示例数值只用计数器类别。
 */
export type UsageObject = Record<string, unknown>

/**
 * 类型保持（identity transform 语义）：输入是 `UsageObject | null` 时返回仍是
 * `UsageObject | null`，可直接喂给 `normalizeUsage`；输入是别的（数字/数组/null
 * 等防御性用例）时也原样返回同一类型，测试无需 `as any` 抑制。泛型 + `unknown`
 * 桥接只在函数内部用一次，调用方拿到的是精确类型。
 */
export function adaptTerminalUsage<T>(terminal: T): T {
  if (terminal === null || typeof terminal !== 'object' || Array.isArray(terminal)) return terminal
  const t = terminal as unknown as UsageObject
  const hit = t['prompt_cache_hit_tokens']
  const miss = t['prompt_cache_miss_tokens']
  const hasCanonicalPair = typeof hit === 'number' && Number.isFinite(hit)
    && typeof miss === 'number' && Number.isFinite(miss)
  if (!hasCanonicalPair) return terminal
  if (!Object.prototype.hasOwnProperty.call(t, 'cached_tokens')) return terminal
  const copy: UsageObject = { ...t }
  delete copy['cached_tokens']
  return copy as unknown as T
}
