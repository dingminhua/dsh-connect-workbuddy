# 推理强度（Reasoning Effort）调查记录

> 记录日期：2026-08-30
> 状态：**已修复**（2026-09-17，issue #7，随 2.0.10 发布）
> 触发：用户报告 DSH 中「思考开关只有 deepseek 有，其他都没有」；进一步指出 deepseek 实际支持多档位，「只有一个强度是不对的」。

> **本文件是调查当时的快照（2026-08-30），部分结论已被后续实测推翻。**
> 修复见 `4c39645`「解析单数 effort 形态的推理声明，单数模型不再注册为非推理」：
> `parseReasoning` 现同时解析两态，单数形态经 `singularEffortLadder` 折叠为复数
> （`supportedEfforts` 展开全阶梯 `low/medium/high/xhigh/max`、单数值折入
> `defaultEffort`、`canDisableThinking` 视为 `true`），adapter / 卡片 / 持久化零改动即生效。
> **下文凡与「已修复」冲突处，均已就地标注「⚠️ 已过期」——保留原文以存证当时的推理路径。**

---

## 一、问题现象

DSH 模型选择器里，各 WorkBuddy 模型的推理强度档位表现不一致，大量模型没有可选档位。用户观察到：

- deepseek 有一个「思考」相关状态
- glm 系模型「没开关但有三个选项」
- 其他模型（kimi / minimax / hy3 等）完全没有档位

---

## 二、上游 `/models` 端点数据（纯上游，实测 16 个 cli 模型）

上游 `reasoning` 字段有两种形态，且每个模型都带顶层 `supportsReasoning` / `onlyReasoning`：

### 形态 A：`supportedEfforts` 数组（可选手动档位）

| 模型 | supportedEfforts | defaultEffort | canDisableThinking |
|---|---|---|---|
| glm-5.3 | low, high, xhigh | high | true |
| glm-5.3-flash | low, high, max | high | true |
| hy3-x | low, high | high | false |
| hy4-preview | high | high | false |
| hy4-preview-x | high | high | false |

### 形态 B：`effort` 单值（固定档位，无 supportedEfforts）

| 模型 | effort | 备注 |
|---|---|---|
| deepseek-v4-flash | high | 仅推理（onlyReasoning:true） |
| deepseek-v4-pro | high | 仅推理 |
| hy3 | high | 仅推理 |
| auto | high | 仅推理，默认模型 |
| glm-5.2 | medium | 仅推理 |
| glm-5.1 | medium | 仅推理 |
| glm-5v-turbo | medium | 仅推理 |
| kimi-k3-1 | medium | 仅推理 |
| kimi-k2.7 | medium | 仅推理 |
| kimi-k2.6 | medium | 仅推理 |
| minimax-m3 | medium | 仅推理 |

> 所有 16 个 cli 模型 `supportsReasoning` 与 `onlyReasoning` 均为 `true`。

---

## 三、当前代码问题（根因）

> ⚠️ **已过期（2026-09-17 修复）**：以下是当时（2.0.9 及以前）的代码形态，现已是两态解析。保留以说明问题成因。

`src/upstream.ts` 的 `parseReasoning` 当时**只解析形态 A**：

```ts
const supportedEfforts = Array.isArray(raw['supportedEfforts']) ? ... : undefined
const defaultEffort = typeof raw['defaultEffort'] === 'string' ? ... : undefined
const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? ... : undefined
if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
  return undefined   // ← 形态 B（只有 effort）走到这里，返回 undefined
}
```

**后果**：形态 B 的 11 个 cli 模型（deepseek-v4-flash/pro、hy3、auto、glm-5.1/5.2、glm-5v-turbo、kimi-k3-1/k2.7/k2.6、minimax-m3）的 `reasoning` 被整体丢弃，`WorkBuddyModelInfo.reasoning` 为 `undefined`。

---

## 四、DSH 链路：无档位时强度怎么定

> ⚠️ **本节末尾的推断已被推翻（2026-09-17 实测）**：原文推断「上游收到无 `reasoning_effort` 的请求时按模型默认 `effort` 运行，即这些模型一直以 high/medium 在思考」。修复时的两网关实测结论相反——**不发 `reasoning_effort` 时上游返回 0 思考字符，默认即思考关闭**。因此当时这些模型的真实症状不是「一直以默认强度思考」，而是**根本没有思考**。保留下文原文以存证当时的推断路径。

当模型 `reasoning` 为 falsy（当时 deepseek 等）时，DSH 侧（`@deepseek-ai/dsh-llm-pi-ai` 的 `reasoningInfo`）返回**空对象**——不显示任何档位；请求时 `resolveReasoningLevel` 返回 `undefined`，**请求体不含 `reasoning_effort`**。

shim 原样透传（`prepareChatBody` 不处理 effort）。当时**推断**：WorkBuddy 上游收到无 `reasoning_effort` 的请求时，按模型默认 `reasoning.effort` 运行：

- deepseek → 固定用 **high**，且无法调整
- kimi / minimax / glm-5.1/5.2 / hy3 → 固定用 **medium**，且无法调整

即（原推断）：这些模型**实际一直在思考，但用户无法选择强度**。这解释了用户「deepseek 有思考但只有 fixed」的观察。

> 上述两条推断**均已被推翻**，见本节顶部提示。

---

## 五、实测 chat 接口：模型实际接受的档位

> 注意：以下是通过向 `/v2/chat/completions` 发带不同 `reasoning_effort` 的请求实测（HTTP 200 = 被接受）。**「被接受」不等同于「档位产生不同行为」**，且此探测会消耗积分，未覆盖全部模型×全部档位组合。

> ✅ **本节结论被修复采用**（第五节是本文件中被实证采纳的一节）。2026-09-17 的修复复测追加了两条关键事实：单数形态模型对全阶梯档位返回各异的 `reasoning_content`，且**不发 `reasoning_effort` 时零思考**——后者正是「单数 `effort` 是默认档而非唯一档」的直接依据。

| 模型 | 实测接受档位 |
|---|---|
| deepseek-v4-flash | low, medium, high, max |
| deepseek-v4-pro | minimal, low, medium, high, xhigh, max（全部） |
| hy3 / auto / hy3-x / hy4-preview | minimal, low, medium, high, xhigh, max（全部，前 4 个模型完整探测） |
| kimi-k3-1 | low, medium, high, max |
| minimax-m3 | low, medium, high |

> 关键结论：**上游 `/models` 端点只标了 `effort` 默认档位，但模型实际接受多个甚至全部档位。** 上游端点数据不完整。

未完整实测：glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5.1 / glm-5v-turbo / kimi-k2.7 / kimi-k2.6 / hy4-preview-x / deepseek 是否接受 minimal/xhigh。

---

## 六、DSH 侧档位契约（pi-ai）

`@earendil-works/pi-ai` 的 `ThinkingLevel`：`minimal | low | medium | high | xhigh | max`；`ModelThinkingLevel` 追加 `off`。

- `getSupportedThinkingLevels(model)`：`!model.reasoning` → 返回 `["off"]`
- `thinkingLevelMap`：`Partial<Record<ModelThinkingLevel, string | null>>`；缺失键用 provider 默认，`null` 表示该档位不支持
- `workBuddyThinkingLevelMap`（`src/adapter.ts`）：**未改动**——只从 `supportedEfforts` 建档位，且 `canDisableThinking !== true` 时 `off` 置 `null`。修复选择在**解析层**折叠而非改 adapter，因此这里照旧即可自动生效；`minimal` 不在 `SINGULAR_EFFORT_LADDER` 内（两网关复数载荷从未出现该档），故未被展开。

---

## 七、待决策（修复方向）

> ✅ **已决策（2026-09-17）**：采纳「结合实测」一路。修复把单数形态在解析层折叠为全阶梯（`low/medium/high/xhigh/max`），**不是**只显示声明的那一档。理由是实测证据：`effort` 是默认档、且各档 `reasoning_content` 确有差异。`minimal` 因从未在任何复数载荷中出现而不予展开。

用户要求**只依据上游 `/models` 端点**的信息梳理。基于该端点：

- **严格按上游**：形态 B 模型修复后是「固定档位」（deepseek=high，kimi=medium…），DSH 只显示该档位或标为 fixed，不开放其他档位。
- **结合实测**：deepseek 等实际接受多档位，可补一组档位（需用户确认每个模型真实档位）。← **最终采纳**

**当时的讨论状态：未决定。** 后由 issue #7 的实测结论定案。

---

## 八、按纯上游数据的信息增强清单（对应 `parseUpstreamModel`）

| 字段 | 当前 | 修复后 | 影响模型 | 落地情况 |
|---|---|---|---|---|
| `reasoning.effort` | 不解析（丢弃） | 解析并保留 | 11 个形态 B 模型 | ✅ 已落地（折叠为全阶梯 + 默认档） |
| `supportsReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（`thinkingLevelMap` 已够用，未采纳） |
| `onlyReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（同上） |
| `disabledMultimodal` | 不解析（图片已改手动） | 可选解析，不影响图片逻辑 | — | ❌ 未采纳（图片改手动勾选） |

> 后三行是**当时拟议的增强**，非缺陷——`reasoning` 档位已由 `parseReasoning` 全权决定，`supportsReasoning` / `onlyReasoning` 至今确实未被解析（全库 grep 无引用），这不影响档位呈现。

---

## 九、影响文件

- `src/upstream.ts`：`WorkBuddyReasoning` 接口 + `parseReasoning` + `parseUpstreamModel` —— ✅ **已修改**（新增 `SINGULAR_EFFORT_LADDER` 与 `singularEffortLadder`，`parseReasoning` 改为两态）
- `src/adapter.ts`：`workBuddyThinkingLevelMap` —— ⬜ **未修改**（刻意：解析层折叠后自动生效）
- `src/client/WorkBuddyCard.tsx` + `locales.ts` —— ⬜ **未修改**（同上）
- `src/catalog.ts`：fallback 静态目录 —— ⬜ **未修改**（同上）

> 本文件记录的调查结论已由 `4c39645` 落地（随 **2.0.10** 发布），测试新增 6 例覆盖单数折叠、混合形态优先级与线上载荷集成。
