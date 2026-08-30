# 推理强度（Reasoning Effort）调查记录

> 记录日期：2026-08-30
> 状态：**调查完成，未修复**（结论待决策）
> 触发：用户报告 DSH 中「思考开关只有 deepseek 有，其他都没有」；进一步指出 deepseek 实际支持多档位，「只有一个强度是不对的」。

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

`src/upstream.ts` 的 `parseReasoning` **只解析形态 A**：

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

当模型 `reasoning` 为 falsy（当前 deepseek 等）时，DSH 侧（`@deepseek-ai/dsh-llm-pi-ai` 的 `reasoningInfo`）返回**空对象**——不显示任何档位；请求时 `resolveReasoningLevel` 返回 `undefined`，**请求体不含 `reasoning_effort`**。

shim 原样透传（`prepareChatBody` 不处理 effort）。WorkBuddy 上游收到无 `reasoning_effort` 的请求时，**按模型默认 `reasoning.effort` 运行**：

- deepseek → 固定用 **high**，且无法调整
- kimi / minimax / glm-5.1/5.2 / hy3 → 固定用 **medium**，且无法调整

即：这些模型**实际一直在思考，但用户无法选择强度**。这解释了用户「deepseek 有思考但只有 fixed」的观察。

---

## 五、实测 chat 接口：模型实际接受的档位

> 注意：以下是通过向 `/v2/chat/completions` 发带不同 `reasoning_effort` 的请求实测（HTTP 200 = 被接受）。**「被接受」不等同于「档位产生不同行为」**，且此探测会消耗积分，未覆盖全部模型×全部档位组合。

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
- 当前 `workBuddyThinkingLevelMap`（`src/adapter.ts`）：只从 `supportedEfforts` 建档位，且 `canDisableThinking !== true` 时 `off` 置 `null`

---

## 七、待决策（修复方向）

用户要求**只依据上游 `/models` 端点**的信息梳理。基于该端点：

- **严格按上游**：形态 B 模型修复后是「固定档位」（deepseek=high，kimi=medium…），DSH 只显示该档位或标为 fixed，不开放其他档位。
- **结合实测**：deepseek 等实际接受多档位，可补一组档位（需用户确认每个模型真实档位）。

**与用户讨论确认：未决定。** 用户当前明确「只依据上游 /models 端点信息」梳理信息增强。

---

## 八、按纯上游数据的信息增强清单（对应 `parseUpstreamModel`）

| 字段 | 当前 | 修复后 | 影响模型 |
|---|---|---|---|
| `reasoning.effort` | 不解析（丢弃） | 解析并保留 | 11 个形态 B 模型 |
| `supportsReasoning` | 不解析 | 解析 | 全部 16 个 |
| `onlyReasoning` | 不解析 | 解析 | 全部 16 个 |
| `disabledMultimodal` | 不解析（图片已改手动） | 可选解析，不影响图片逻辑 | — |

---

## 九、影响文件（尚未修改）

- `src/upstream.ts`：`WorkBuddyReasoning` 接口 + `parseReasoning` + `parseUpstreamModel`
- `src/adapter.ts`：`workBuddyThinkingLevelMap`（如需把 effort 展开为档位）
- `src/client/WorkBuddyCard.tsx` + `locales.ts`：卡片「推理强度」文本兼容 effort 格式
- `src/catalog.ts`：fallback 静态目录（如需补齐推理信息）

> 本文件只记录调查结论，**未改动任何代码**。
