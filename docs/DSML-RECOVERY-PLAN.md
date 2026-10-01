# DSML 恢复：把泄漏的标记转回真正的 `tool_calls`

> 状态：**已实现**（3.3.0；两处设计决定见第十一节，实现中发现的偏差见第十二节）
> 前置：`docs/DSML-LEAK-RESEARCH.md`（外部调查记录，结论与上游各层的修法）
> 参考实现：[`hawklithm/workbuddy2api`](https://github.com/hawklithm/workbuddy2api)（MIT，Copyright (c) 2026 Mayer），`src/codebuddy_proxy/dsml_parser.py`（983 行）

---

## 一、要做什么，以及这推翻了什么

**做**：在本插件 shim 的响应路径上，识别上游写进 `delta.content` 的 DSML 工具调用标记，把它**转成 OpenAI 兼容的 `delta.tool_calls`**（并把这部分标记从可见正文里剔除），而不是像今天这样原样透传。

**不做**：
- 不改模型、不改服务端。本插件处在代理位置，能动的只有「拿到字节之后、交给客户端之前」这一段。
- 不做「看到形态就猜」。任何一道闸不过，一律**回滚成正文**（第四节）。

**这推翻了本仓库两天前的口径**。`docs/DSML-LEAK-RESEARCH.md` 第五节写的是「本仓库不该实现恢复，只做诊断」，并给了三条理由（缺声明工具、缺必填参数、是否真闭合都无从判断）。现在的结论是：**那三样东西我们其实都有**（见第四节），所以「只诊断」不再是唯一正确解。该文档第五节必须同步改写，否则代码与文档互相打脸。

**为什么优先「转换」而不是「丢弃 + 重发」**（用户先后给过两个方向，这里给结论）：

| | 转换 | 丢弃 + 重发 |
|---|---|---|
| 计费 | **零**（把已经拿到的字节重新解释一遍） | 整轮重新生成，真实花钱 |
| 延迟 | 无额外往返 | 多一整个上游往返 |
| 成功率 | 闭合即可确定性成功 | 可能反复失败（基线 0.8%，但一旦进入「自我纠正循环」会连续复发） |
| 失败形态 | 不可恢复的那一类仍会露成正文 | 恰好覆盖「整轮都是垃圾」 |

结论：**转换做主线**；「丢弃 + 重发」只在第五节那个特定条件下作为兜底，不作为主路径。

---

## 二、参考实现的事实核对（实测，不是转述）

`hawklithm/workbuddy2api` 已 clone 到本地逐行读过。它不是玩具：983 行状态机 + 272 行忽略区域测试 + 混合格式测试 + 残留缓冲测试，`LICENSE` 为 MIT（Copyright (c) 2026 Mayer）。

### 2.1 它做对了的四件事（值得照抄）

| 它的模块 | 解决什么 | 我们的对应难题 |
|---|---|---|
| `find_tool_markup_tag_outside_ignored()` + `is_inside_markdown_fence()` + `last_unclosed_code_span()` + `skip_xml_ignored_section()` | 围栏 / 行内代码段 / CDATA / 注释里的标记是**在讨论**，不是在调用 | 本会话就是反面教材：我们连续几条消息在引用这个标记来解释它 |
| `find_matching_tool_markup_close()` + `add_chunk` 的「找不到闭标签就先不 commit」 | **闭合才提交** | 四道闸的第 1 道 |
| `normalize_fullwidth_ascii()` / `DSML_VARIANTS` | 全角竖线、单/双竖线变体 | 与 `src/markup-diagnosis.ts` 已修的 `BARS = ｜｜?` 同一个教训 |
| `repair_missing_tool_calls_wrapper()` | **缺起始包裹**（上游 issue 的根因，也正是我们捕获的形态） | 本项目自己捕获的 12 次泄漏里，开头的 `invoke name="…"` 被写坏 |

它还有一处**判例级**的正确决定：`add_chunk` 的收尾注释明确写了「不再『只要存在 `<` 就整段扣留』」——因为架构文档里出现 `<tool_call><invoke>` 这样的**示例**时，旧逻辑会把其后全部内容永久扣留并在流结束时丢失。它改成只扣留「可能是标签开头的尾巴」，并用 `_is_tool_call_start()` 排除 `a < b`、`<50%` 这类普通文本。这个坑我们必须继承它的修法，不能退回旧写法。

### 2.2 它有三个必须修的缺陷（**不能盲抄**）

1. **`find_invoke_blocks` 定义了两次**（第 590 行与第 627 行）。Python 里后者覆盖前者，所以线上跑的是第二个，但第一个是死代码——移植时只能带一个，并补注释说明取舍。
2. **流式注入与自己的解析器输出形状不一致**。`parse_single_xml_tool_call()` 产出 `{id, type, function: {name, arguments}}`（`arguments` 是 JSON 字符串）；而 `__main__.py:1317` 注入时写的是 `tc["name"]` 与 `tc["input"]`。这两个键**不存在**于解析器的输出里。也就是说它的流式 DSML 分支在 HEAD 上是不自洽的（非流式分支用的是 `tc.get("function",{}).get("name")`，形状对了）。我们移植时必须**统一成一种形状**，不能让这个不一致跟着进来。
3. **完全没有「名字必须在本次请求声明的工具里」这道闸**。全仓 grep `tool_names|declared|request_tools|allowed_tools` 在解析器里 0 命中；`parse_all_tool_calls()` 也不接受 `tools` 参数。它唯一一处 `params` 判断（第 531 行）是参数重名，与工具名无关。**这正是四道闸里的第 2、3 道，它没有。**（这也回答了那个会话被打断时正在查的问题。）

### 2.3 它没有的东西，我们有

第 2.2 节的第 3 项不构成阻断：**声明了哪些工具，我们在请求路径上已经解析过了**——`prepareChatBody()`（`src/upstream.ts:385`）对请求体做过 `JSON.parse`，且 `normalizeToolChoice()`（`src/upstream.ts:411`）在 `tool_choice: none` 时**直接 `delete obj['tools']`**。所以「本次请求声明了哪些工具」是**可读的既成事实**，不需要额外往返或 API。

---

## 三、设计总览

```
客户端(DSH) ──POST /v1/chat/completions──▶ shim
                                           │
                     prepareChatBody(raw) ─┤ ① 解析声明工具（新：declaredTools）
                                           │
                          chatStream() ────┤ ② 上游 SSE（账号池换号逻辑不变）
                                           │
        ┌──────────────────────────────────┘
        ▼
   ③ SSE 逐帧改写（新）：delta.content → DsmlStreamBuffer.add()
        ├─ 拿到完整 invoke 块 → 四道闸校验 → 通过：写 delta.tool_calls + finish_reason
        │                                   不通过：原样作为正文吐出
        └─ 流结束 → flush() 残渣作为正文吐出 → data: [DONE]
```

三个设计原则：

1. **只改 `delta.content`，不改帧序**。帧是按顺序透传的，改写是原地替换；只有流末尾的 `flush()` 会追加一帧。这保证「两段回答拼接」这类已有缺陷（`src/shim.ts:350` 那段注释专门警告过）不会被引入。
2. **粘性原生工具调用**：一旦某个 chunk 出现原生 `delta.tool_calls`，**整条响应禁用 DSML 恢复**（照抄参考实现的 `not native_tool_calls` 判据）。否则同一次回答会有两条调用通道竞争。
3. **解析与改写分离**：新模块 `src/dsml-recovery.ts` 是纯函数（无 I/O、无网络、无日志），便于单测与变异测试；shim 只负责接线。

---

## 四、四道闸的落点

| # | 闸 | 判据 | 数据来源 | 落在哪 |
|---|---|---|---|---|
| 1 | **闭合才提交** | 找到与开标签匹配的闭标签才产出调用；否则继续等，流结束仍未闭合 → 回滚成正文 | 状态机自身 | `DsmlStreamBuffer.add()` / `flush()` |
| 2 | **名字必须在声明里** | 解析出的 `invoke name="X"` 必须 ∈ 本次请求的 `tools[].function.name`；`tool_choice` 是函数名时只允许那一个 | `prepared` 请求体 | `parseToolCalls(text, { declaredNames, toolChoice })` |
| 3 | **无声明工具就完全不做** | 请求没有 `tools`（或 `tool_choice: none`，此时 `normalizeToolChoice` 已删掉 `tools`）→ **根本不创建 buffer**，响应原样透传 | 同上 | `src/shim.ts` 响应路径入口 |
| 4 | **任何可疑都回滚** | 必填参数缺失 / 名字不符 / 未闭合 / JSON 解析失败 / 帧不可解析 → 整个块作为正文吐出，不改写 | 解析器 + 请求体 `required` | `parseToolCalls()` 返回空 → 调用方走正文分支 |

**第 4 道闸的措辞要严格**：回滚意味着**不剔除标记**（正文里该看见的照旧看见），而不是「静默吞掉」。理由是「检查永远不命中」与「检查通过」在界面上长得一样——`docs/DSML-LEAK-RESEARCH.md` 第六节已经为这个坑付过一次代价。

---

## 五、已裁定：不可恢复形态的处理

真实捕获的形态里，**开头被写坏成 `<｜DSML｜ validate>`**（工具名占了 `invoke name="…"` 的位置，没有 `invoke name=` 子句）的那一类，即使做完缺包裹修复，也**拿不到工具名**。它落在第 2 道闸外，只能回滚成正文。

三个选项当初摆出来过：

| 选项 | 行为 | 代价 |
|---|---|---|
| **A** | 露成正文（今天的现状），并把这次恢复失败记一条日志 | 用户仍会看到标记，但内容零丢失；且不花钱 |
| B | 剔除标记、只显示干净的正文 | 会**凭空少掉一段**内容，用户无法察觉；违背第四节第 4 道的措辞 |
| C | 丢弃整轮 + 重发同一 payload | 覆盖「整轮除了垃圾什么都没有」最有效，但**真实花钱、真实等待、可能反复** |

**裁定：默认 A；仅当「整轮响应去除标记后正文为空」时升级为 C，且只重发一次。** 判据是可复核的既成事实（无正文可损失），而不是主观猜测。B 不采用。这也正是 `project-epb/SILI-agent` 那个提交真正要解决的场景。

实现要点（避免这个兜底变成新缺陷）：

- **判定在流结束后做，但扣留必须从第一帧开始。** 「整轮无正文」是流结束时才知道的事实；要让它还能重发，就必须在**第一个可提交内容出现之前**不向客户端写任何携带 `content` 或 `tool_calls` 的帧（`role`、`usage` 这类无内容的帧不受影响，照常透传）。一旦出现可提交正文，立即按 A 放行并恢复正常流式输出，此后**本响应不再有重发可能**——这正是为了不与第二节注释里那条「两段回答拼接」的既有禁令冲突。
- 「先泄漏、正文稍后才到」因此是安全的：正文一到就放行，扣留窗口自动关闭，不会被误判成垃圾；反之，真正的「整轮只有垃圾」其扣留窗口持续到流结束，这时才升级为 C。
- 重发**只允许一次**；复用同一个已经过 `prepareChatBody` 的 payload；沿用既有的账号池语义（先同账号重试一次，失败才走 `failoverAccount`），不新增第二条独立重试链路。第二次仍然只有垃圾 → 按 A 露成正文，绝不循环。

---

## 六、移植清单（函数级）

目标文件：**新增 `src/dsml-recovery.ts`**（纯模块，随包发布）。

命名与风格按本仓库约定：camelCase、显式返回类型、不引入运行时依赖（工具 id 用 `node:crypto` 的 `randomUUID()`）。

| 参考实现 | 目标名 | 变更 |
|---|---|---|
| `ToolMarkupTag` / `XMLElementBlock` / `ParsedToolCall` | `interface MarkupTag` / `ParsedInvoke` / `RecoveredToolCall` | 去掉 `dataclass`；`RecoveredToolCall` 统一为 `{ id, name, arguments: string }`（**修掉 2.2 缺陷 2**） |
| `FULLWIDTH` 归一化 + `DSML_VARIANTS` | 复用 `src/markup-diagnosis.ts` 的 `FULLWIDTH_BAR` / `BARS` | 单一真相源：把 `BARS`/标记正则提到本模块，`markup-diagnosis.ts` 改为 import（诊断侧仍需独立可用） |
| `skip_xml_ignored_section` | `skipIgnoredSection` | 原样语义 |
| `markdown_code_span_end` / `last_unclosed_code_span` / `is_inside_markdown_fence` | `codeSpanEnd` / `lastUnclosedCodeSpan` / `insideMarkdownFence` | 原样语义（这是防劫持的核心） |
| `normalize_fullwidth_ascii` | `normalizeFullwidth` | 原样语义 |
| `has_dsml_prefix_at` / `consume_dsml_prefix` | `hasMarkupPrefixAt` / `consumeMarkupPrefix` | 原样语义 |
| `match_tool_markup_name` / `scan_tool_markup_tag_at` / `find_tool_markup_tag_outside_ignored` | `matchTagName` / `scanTagAt` / `findTagOutsideIgnored` | 原样语义 |
| `find_matching_tool_markup_close` | `findMatchingClose` | 原样语义（第 1 道闸的实现） |
| `parse_xml_attributes` / `parse_invoke_parameters` | `parseAttributes` / `parseInvokeParameters` | 保留递归；**新增**：返回 `params` 的同时报告「哪些参数出现」，供必填校验 |
| `parse_single_xml_tool_call` | `parseSingleInvoke` | **新增第 2 道闸**：名字不在 `declaredNames` 里 → 返回 `undefined`。**新增第 4 道闸**：`required` 里的参数缺失 → 返回 `undefined` |
| `find_invoke_blocks`（**两份**） | `findInvokes` | **只带一份**（修掉 2.2 缺陷 1） |
| `parse_xml_tool_calls` / `repair_missing_tool_calls_wrapper` | `parseInvokes` / `repairMissingWrapper` | 保留 |
| `parse_tool_calls(text, auto_repair)` | `parseToolCalls(text, options)` | 签名扩为 `{ declaredNames: ReadonlySet<string>, required?: ReadonlyMap<string, string[]>, toolChoice?: string }`；**第 2/3 道闸在这里收口** |
| `remove_tool_call_markup` | `removeMarkup` | 保留（只在提交成功后被调用，不从正文里「顺手」删标记） |
| `ToolCallStreamBuffer`（别名 `DSMLStreamBuffer`） | `class DsmlStreamBuffer` | 保留 `add()` / `flush()` 语义与「只扣留可能的标签开头」策略；`add()` 返回 `{ text, calls? }` |
| `should_emit_tool_calls()` / `get_detected_calls()` | 并入 `add()` 的返回值 | 去掉可变查询状态（更易测） |

**不移植**：`UnifiedToolCallBuffer` 别名、`import html`（未用）、`__main__.py` 的协议适配层（我们对外只有 OpenAI Chat 一种）。

---

## 七、改动点（文件级）

| 文件 | 改动 | 为什么在这里 |
|---|---|---|
| `src/dsml-recovery.ts` | **新增**（第六节全部） | 纯模块，可单测、可变异 |
| `src/upstream.ts` | 新增导出 `declaredTools(bodyJson): { names: string[], required: Map<string,string[]>, choice: string \| undefined } \| undefined` | 唯一已经在解析请求体的地方（`prepareChatBody:385`），别处再 parse 一次就是两份真相 |
| `src/shim.ts` | ① 在 `chatCompletions` 里对 `prepared` 取一次 `declaredTools`，**为空则不启用恢复**；② 把 `body.pipe(res)`（452 行）替换为「SSE 逐帧改写 + 末尾 flush」，并实现第五节的**扣留窗口**（第一个带 `content`/`tool_calls` 的帧之前不写内容帧）；③ **保留** 445–447 的 `[DONE]` 嗅探与 448–451 的错误路径（`data: [DONE]\n\n` 合成） | 响应路径是唯一的字节交汇点；把改写放在 `pipe` 处，恰好不触碰账号池换号循环（它只覆盖 `!result.ok`） |
| `src/index.ts` | 若需要，加一条日志/遥测接线（见第九节） | 宿主是唯一有 logger 的地方 |
| `src/markup-diagnosis.ts` | 标记正则改为从 `src/dsml-recovery.ts` import | 避免「诊断认单竖线、恢复只认双竖线」这类口径分裂 |
| `scripts/verify-dsml.mjs` | **必须改**：静态检查里 `stillPassThrough = /body\.pipe\(res\)/`（176 行）会在实现后**反转**，脚本会宣称「响应路径仍是原样透传」；`--live` 分支（252 行）走的是 `client.chatStream`，**绕过 shim**，因此它测不到新模块 | 这个脚本是「可复核的事实陈述」的载体，不改它就会在实现后给出错误陈述 |
| `tests/` | 新增 `tests/dsml-recovery.spec.ts` + `tests/shim-recovery.spec.ts`（矩阵见第八节） | 现有 `tests/shim.spec.ts` 的 harness（`makeShim` + `request`）可直接复用 |
| `THIRD_PARTY_NOTICES.md` | 在「参考项目清单」里加一行 `hawklithm/workbuddy2api`（MIT，Copyright (c) 2026 Mayer），说明**本次是代码移植**（不是以往那种「思路参照」） | 现有表格已有一个 `workbuddy2api`（Sliverkiss），是**不同仓库**，不能混为一行 |
| `docs/DSML-LEAK-RESEARCH.md` | 第五节「为什么本仓库不实现恢复」**改写**为「恢复的前提与三道闸」，并链到本文 | 口径已变 |
| `CHANGELOG.md` | 新增条目（放在下一个未发布段落，或 3.3.0） | 现状是 3.2.0 已发布 |

**行号会漂移**，实现时以符号名定位为准。

---

## 八、测试矩阵

### 8.1 纯模块（`tests/dsml-recovery.spec.ts`）

| 组 | 用例 | 期望 |
|---|---|---|
| 基本转换 | 完整 `<tool_calls><invoke name="X">…</invoke></tool_calls>`，X 已声明 | 产出 1 个调用，正文里标记被剔除 |
| 缺包裹 | 只有 `<invoke name="X">…</invoke>`（**本项目真实形态**） | 自动修复后产出调用 |
| 单/双竖线 | `｜DSML｜` 与 `｜｜DSML｜｜` 混用于一个块 | 都识别 |
| **闸 1** | 只有开标签、没有闭标签（流中途截断） | 不产出调用；`flush()` 把**原文**吐出 |
| **闸 2** | `name="notDeclared"` | 不产出调用；原文保留 |
| **闸 2'** | `tool_choice` 指定了另一个函数名 | 只允许那一个 |
| **闸 3** | 调用方未启用（无声明工具） | 每次 `add()` 原样返回，buffer 不持有内容 |
| **闸 4** | `arguments` 不是合法 JSON / 必填参数缺失 | 不产出调用；原文保留 |
| 防劫持 | 标记写在 ``` 围栏内 | 不产出调用 |
| 防劫持 | 标记写在行内反引号内 | 不产出调用 |
| 防劫持 | 标记写在 `<!-- -->` / CDATA 内 | 不产出调用 |
| 饥饿防护 | 正文含架构示例 `<tool_call><invoke>` 后跟大段普通文本 | 普通文本**照常输出**，不被永久扣留（参考实现的注释级修复） |
| 假开头 | 正文含 `a < b`、`<50%` | 不被当作标签开头扣留 |
| 跨 chunk | 标记**逐字节**切分在多个 `add()` 之间 | 与整段一次输入结果一致（对照式断言） |
| 残渣 | 流结束时 buffer 里是未闭合的开头 | `flush()` 原样吐出，不吞正文 |
| 形状一致 | — | 返回的调用必须是 `{id,name,arguments}`（**钉死 2.2 缺陷 2 不会回归**） |

### 8.2 接线（`tests/shim-recovery.spec.ts`，复用 `makeShim`）

| 用例 | 期望 |
|---|---|
| 上游把标记写进 `delta.content`，请求声明了工具 | 客户端看到的 SSE 里该帧变成 `delta.tool_calls`，`finish_reason = "tool_calls"`，正文无标记 |
| 同一响应上游**也**发了原生 `delta.tool_calls` | 原生调用原样透传，DSML 恢复**全程禁用**（粘性） |
| 请求没有 `tools` | 标记原样透传（闸 3） |
| `tool_choice: "none"` | `normalizeToolChoice` 已删 `tools` → 原样透传；**断言它确实走的是闸 3 而不是闸 2** |
| 帧被 TCP 切分（一次 `write` 半个 `data:` 行） | 输出帧完整且顺序不变 |
| 上游流中途断开 | 既有行为保留：`data: [DONE]\n\n` 被合成，且残渣先吐出（**回归既有断言**） |
| 未闭合块 + 流正常结束 | 标记作为正文出现，`[DONE]` 正常 |
| 多块（一次响应里两段泄漏） | 两段都恢复，正文顺序不变 |

### 8.3 变异测试（沿用本项目既有做法）

三次变异必须变红：
1. 去掉第 2 道闸（不校验声明工具）→ 闸 2 用例红；
2. 去掉围栏/代码段忽略 → 防劫禁用例红；
3. 把「闭合才提交」改成「见前缀即提交」→ 闸 1 与截断用例红。

### 8.4 端到端

- `scripts/verify-dsml.mjs`：静态检查改为断言**响应路径已被接管**（而不是反向断言 `body.pipe`）；`--live` 增加 `--through-shim` 选项，让真上游响应**经过 shim** 再判定，这样才测到新模块（现有 `--live` 直连 `client.chatStream`，会给出「转换未生效」的假阴性）。
- 真机：`pnpm run check` 全绿后，在本机 DSH 里跑一轮带工具的对话，确认标记不再出现在卡片/消息里。

---

## 九、可观测性与回退

- **不做设置项开关（已裁定）**。理由：它只在「这次回答本来已经坏了」的形态上触发；加开关要多一个 schema 字段、卡片 UI、双语文案与文档，而它防的风险（劫持）已经由四道闸承担。若将来反悔，落点明确：`src/index.ts:460` 的 `Config` 加一个布尔字段，shim 侧在创建 buffer 前读一次。
- **触发时记一条日志**（复用宿主 logger）：恢复了几次、落在哪个闸上（`no-declared-tools` / `name-not-declared` / `unclosed` / `bad-arguments`）。这条日志是「检查真的在命中」的证据，避免重演第六节「永远不命中 = 看起来通过」。
- **回退方式**：新模块与 shim 改动是**两个独立提交**（先 `feat(dsml): 引入解析与流式缓冲`，再 `feat(shim): 响应路径接入恢复`）。第二笔 idea 出问题时 `git revert` 即可回到今天的透传行为，不动第一笔的单测资产。

---

## 十、落地顺序

1. `tests/dsml-recovery.spec.ts` 先写（含变异），`src/dsml-recovery.ts` 让它变绿——**此时仓库行为零变化**。
2. `declaredTools()` + 单测（纯函数）。
3. 接进 `src/shim.ts`，补 8.2 接线用例，跑 `pnpm run check`。
4. 改 `scripts/verify-dsml.mjs`（静态断言反转 + `--through-shim`）。
5. 文档三件套：`DSML-LEAK-RESEARCH.md` 第五节、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`。
6. 真机验证，然后才谈发布。

---

## 十一、已裁定的两处决定

| # | 决定 | 结论 | 落点 |
|---|---|---|---|
| 1 | 不可恢复形态怎么处理 | **默认 A（露成正文 + 记日志）；整轮无正文时重发一次** | 第五节 |
| 2 | 是否加设置项开关 | **不加，始终开启** | 第九节 |

其余（移植清单、四道闸、测试矩阵、文档改动）都已按本仓库现状对齐，可以照此执行。

### 测试矩阵的补充（由决定 1 带来）

| 用例 | 期望 |
|---|---|
| 整轮只有泄漏块、无任何正文 | 重发**恰好一次**，第二次仍如此则回滚成正文（不得无限重发） |
| 泄漏块之后又来正常正文 | **不触发重发**：正文一到即放行，标记按 A 露成正文 |
| 泄漏块之前已写出过 `content` 帧 | **不重发**，按 A 处理（避免两段回答拼接） |
| `role` / 无内容帧先到 | 照常透传，不影响扣留窗口的判定 |

---

## 十二、实现记录：落地时发现的偏差

方案与实现不一致的地方，一律以**实现**为准，并记在这里——否则这份文档会变成另一种「看起来通过了」的检查。

### 12.1 参考实现里两处它自己也没处理的洞

都是**逐字节输入**的用例逼出来的，参考实现同样存在：

1. **标记与标签名之间的空格**。真实捕获的形态是 `<｜DSML｜ validate>`（空格来自「工具名被写在 `invoke name="…"` 的位置」）。参考实现的 `match_tool_markup_name` 消费完前缀后**直接**读名字，遇到空格就返回空名字——于是一个真实泄漏的标签根本不被识别，检测器会把它当普通正文，**「整轮只有标记 → 重发」这条规则对它永远不会触发**。已修（`readName` 跳过前缀后的空白）。
2. **只到一半的标记**。输入逐字节到达时，`<｜` 这一瞬间既不是完整标签、也不匹配任何「标签开头」判据，于是开头的 `<｜` 被当正文吐出去，**此后这个块永远无法恢复**（它的开标签已经被劈成两半）。已修（`isPartialMarker`：任何标记的严格前缀都算「可能正在生成的标签开头」）。

两处都补了用例：空格那条在「真实捕获形态」用例里，半成品标记那条在「逐字节等于一次输入」用例里。

### 12.2 方案里没写到、但必须做的一个判断

方案第五节说「整轮去除标记后正文为空」时重发，但没说**怎么判空**。第一版按「已知的标记关键词」判断，结果对真实形态给出 `hasProse = true`：

- 真实块里的 `<｜DSML｜ validate>` 用的是**被写坏的、非关键词的名字**，关键词名单把它漏掉，剩下的 `validate` 被当成正文；
- 于是**重发规则对它要治的那一次泄漏恰恰不会触发**。这正是本项目已经付过两次学费的那种坑：检查永远不命中，看起来和检查通过一模一样。

修正：`stripMarkup` 把**任何带标记的标签**都算作标记（只有「是否连内容一起删」才看关键词名单）。围栏与反引号里的引用仍算正文——写下来的**讨论**通常会被包起来，泄漏不会。

### 12.3 扣留窗口的精确形态

方案里「扣留窗口」只是一句话，实现需要两个**互不替代**的事实（`RecoveryStream`）：

- `windowOpened`：**第一个带内容的帧**到达时置位。之前的帧（首帧的 `delta.role`、心跳）不含回答内容，照常透传——它们不会造成「两段回答拼接」。
- `windowClosed`：一旦真正的正文或调用被交付就置位，**此后本响应不再扣留**、也不再可能重发。

顺带修掉一个初版缺陷：`finish_reason` 帧在扣留期间要与「尚未吐出的内容帧」保持先后——内容帧是**插在**它们之前，而不是追加在它们之后。方案没提这件事，但它决定客户端是否在一个已结束的调用之后又收到内容。

### 12.3a 终结帧之前必须先把缓冲区倒空

上面那条只覆盖「窗口还开着」的情形。窗口关闭之后，`finish_reason` 帧会立刻转发，而缓冲区里可能仍压着一段尾巴（例如流在 `<｜DSM` 这种**半个标记**处结束），于是那段文本落在**自己的终结符之后**——一个在 `finish_reason` 处停止累积正文的客户端会**静默丢掉**这段内容。

修法：任何带非空 `finish_reason` 的帧在转发**之前**先 `drainBuffer()`（把缓冲区里压着的内容按序吐出）。用例 `flushes text the buffer still held BEFORE a finish_reason frame` 钉住它：去掉这一行必红。

### 12.4 实际落地的范围

| 项 | 结果 |
|---|---|
| `src/dsml-recovery.ts` | 新增（约 940 行，含论证注释），四道闸 + 流式缓冲 |
| `src/upstream.ts` | 新增 `declaredTools()`（闸 2/3 的数据来源） |
| `src/shim.ts` | 新增 `RecoveryStream`；响应路径由 `body.pipe(res)` 改为逐帧改写 + 末帧 flush；整轮只有标记时重发一次（复用账号池换号语义与 `triedAccountIds` 刹车） |
| `src/markup-diagnosis.ts` | 标记常量与正则改为从 `src/dsml-recovery.ts` **单一来源**转发（诊断仍不随包发布） |
| `scripts/verify-dsml.mjs` | 静态探针由「是否仍是 `body.pipe(res)`」改为「是否已被接管」；新增 `--through-shim` |
| 测试 | 模块 27 例、接线 12 例、`declaredTools` 5 例；全量 **813 例**通过 |

### 12.5 变异验证（§8.3 的实际执行结果）

逐个把闸拆掉，确认**必定变红**（这是「用例真的在钉它」的唯一证据）：

| 变异 | 结果 |
|---|---|
| 去掉闸 2（不校验声明工具名） | 3 例红 |
| 去掉闸 3（空声明也照做） | 1 例红（**首版不变红**，见下） |
| 去掉忽略区域（围栏/代码段内的标记被劫持） | 23 例红 |
| 削弱闸 1（无闭标签也算闭合） | 2 例红 |
| 去掉闸 4（不校验必填参数） | 1 例红 |
| shim：重发不看「是否已交付」 | 1 例红 |
| shim：扣留窗口不关闭（帧被丢弃） | 2 例红 |
| shim：忽视闸 3 | 2 例红 |

**闸 3 的首版用例是假的**：它只喂一个完整块，而闸 2（名字不在声明里）恰好也能拦住同一件事，所以拆掉闸 3 后它照样通过。改成**把块拆成两半喂进去**才真的钉住了闸 3——没有它，缓冲区会扣住前半截等一个永远不来的闭标签；有它，字节必须立刻原样通过。

### 12.6 两处「文档比代码先过时」的修正

实现让两份**取证文档**里的机制描述变成了假话，都已按日期加复核注，而不是悄悄改掉历史结论：

- `docs/CACHE_EVIDENCE.md`：原文写「插件是否重编码 SSE：❌ 无，字节直通（`body.pipe(res)`）」。结论（缓存字段不会丢）仍成立，但理由要从「没有翻译层」换成「逐帧原位替换、不重建帧」。
- `scripts/probe-cache-convention.mjs`：文件头同样以「字节直通」为前提论证「不可能犯 trae 那个 bug」。
