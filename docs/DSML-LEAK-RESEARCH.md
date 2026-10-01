# DSML 泄漏（模型把工具调用写进正文）外部调查记录

> 记录日期：2026-10-01
> 状态：**外部已有修复与成熟做法**（本仓库侧只做检测，不做恢复）
> 触发：本会话（DSH 宿主模型）连续 4 条消息把 `<｜DSML｜ validate>` 这类标记写进了可见正文，
> 于是去查「别人是怎么解决的」，以判断这到底是本插件的缺陷、DSH 的缺陷，还是更深一层的模型行为。

---

## 一、结论先行

**这是 DeepSeek 模型族一个有名字的已知缺陷，不是本插件的问题，也不是 DSH 的问题。**

一致的根因口径：**长上下文下，模型漏掉 `<｜DSML｜tool_calls>` 起始包裹**，却仍写出结构完整的
`invoke` 块；而解析器**只以那个起始标记为锚**判定工具调用，于是整块被当成普通正文返回、
不产生任何 `tool_calls`，客户端就卡在那里等一个永远不会到来的调用。

有一条不需要 GPU 的解析器级复现已给出：把同一段 invoke 块**手工补上起始标记**，它立刻
解析成一个合法调用——即「模型少写了一个包裹」，而不是「DSML 坏了」。

对我们的意义：本仓库**不该**去实现一个宽容的 DSML 解析器（下文第五节说明为什么），
但**该**让检测器能真正看见这种形态（第六节，已实现）。

---

## 二、上游各层各自修了什么

| 层 | 做法 | 状态 |
|---|---|---|
| 服务端解析器（Python） | 孤儿 invoke 恢复：正文里见到完整 invoke 块也进入工具态，内部合成缺失的包裹 | [#55954](https://github.com/vllm-project/vllm/pull/55954) 已合并 |
| 参数层 | 参数缺闭合标签时，遇到下一个参数就隐式闭合（避免吞掉后续参数） | [#54838](https://github.com/vllm-project/vllm/pull/54838) 已合并 |
| 流式参数污染 | 贪婪正则把 `</｜DSML｜parameter` 残片吞进参数值 → 改 tempered greedy / 前缀裁剪 | [#53228](https://github.com/vllm-project/vllm/pull/53228)、[#53405](https://github.com/vllm-project/vllm/pull/53405)，均已关闭未合并 |
| 畸形包裹 | 包裹不是缺失而是**写错**（如 `tool_calls` → `toolcalls`） | [#51914](https://github.com/vllm-project/vllm/issues/51914)、[#52645](https://github.com/vllm-project/vllm/pull/52645) 仍开着 |
| Rust 前端 | Python 修了、Rust 没修，同样把 DSML 当正文返回 | [#58057](https://github.com/vllm-project/vllm/pull/58057) 仍开着 |
| 客户端 / 检测 | 匹配器**同时接受两种竖线写法** `<||DSML||…>` 与 `<｜DSML｜…>` | [DeepSeek-V4-Pro 讨论 #209](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/209) |

另外 [#49117](https://github.com/vllm-project/vllm/pull/49117) 是最早、最完整的孤儿 invoke 恢复实现
（137 个测试、含跨方言包裹与声明的工具名校验），但**关闭未合并**（`needs-rebase`）。

---

## 三、最有价值的一课：第一次修错了

早期实现采用「一见到 invoke 前缀就进入工具态」的**急切恢复**（[#55954](https://github.com/vllm-project/vllm/pull/55954)），
在生产上炸出三类事故（[#56667](https://github.com/vllm-project/vllm/pull/56667) 总结）：

1. **截断 / 幽灵调用** —— 生成在参数或闭合标签之前就被 token 上限截断时，产出**空参数的调用** `{}`。
2. **叙述劫持（Narration Hijacking）** —— 正文里**只是在讨论或引用** `<｜DSML｜invoke name="…">`
   的内容，被拦截成一次真正的工具调用。
3. **未声明工具被提升** —— 不在本次请求 `tools` 里的名字、以及 `tool_choice: "none"` 的请求，
   也被提升为可执行调用。

**第 2 类正是本会话的处境**：我们连续几条消息在**引用**这个标记来解释它，任何急切恢复都会
把它们劫持成真实的工具调用——而工具调用会真的执行、真的花钱。

修正后收敛成同一套做法（多个独立贡献者给出相同结论）：

- **只在 `</invoke>` 闭合时才提交**（close-before-commit），未闭合就回滚成正文；
- **用本次请求声明的工具名校验**，名字不在声明里就不认；
- **请求没有声明任何工具（或 `tool_choice: none`）时完全不做恢复**；
- **任何可疑都回滚**（截断、名字不匹配、必填参数缺失）；
- 流式另加**先缓冲 + EOS 安全阀**，避免在误判的流结束时静默吞掉正文。

一位在自维护 fork 上跑生产的报告者说，加上「闭合才提交 / 必填参数校验 / 无工具不恢复」这三道闸
之后，**泄漏没有再复发**。

---

## 四、诊断方法学（先定位边界，不要先换量化）

同一句「agent 什么也没做」背后可能是五个不同边界出问题：模型生成 → 服务端解析 → 量化/运行时 →
agent 客户端 → 历史重放。方法是用**开关当探针**，一次只动一个：

| 开关 | 保持不变 | 结果变化说明什么 |
|---|---|---|
| 非流式 → 流式 | 权重、提示词、工具、解析器、客户端 | 分块缓冲 / 流式适配 |
| `tool_choice` required → auto | 其余全部 | 工具选择或 auto 解析路径 |
| 短上下文 → 长上下文 | 同一任务与 schema | 分隔符遗漏 / 上下文敏感的生成 |
| 并发 1 → 生产负载 | 同一批请求 | 共享状态、调度、负载敏感解析 |
| 官方权重 → 量化候选 | tokenizer、运行时、解析器、采样 | 该权重的加载或生成差异 |
| 最小循环 → 完整 agent | 同一服务端与请求语义 | 客户端归一化、权限、历史重放 |

**明确警告**：不要把「写一个宽容的 DSML 解析器」当作修复——那只是探针。真问题是某一层把结构
丢了，宽容解析会把问题藏起来。

---

## 五、为什么本仓库不实现「恢复」

本插件处在代理位置：WorkBuddy 上游返回 `delta.content` / `delta.tool_calls`，我们转发给 DSH。
在这里「恢复」等于把**正文**猜成**调用**，而要猜对，就必须同时具备上游那三样东西：
本次请求声明了哪些工具、必填参数是什么、以及是否真的闭合。缺任何一样，都会落到第三节那三类
事故里——最坏的结果是**把用户正文里的一段技术讨论执行成一次真实调用**。

而且本插件服务的就是 DeepSeek 模型（WorkBuddy 提供 `deepseek-v4.1-flash` 等），所以这不是
别人的问题：本仓库自己的会话记录里就已经捕获到 12 次真实泄漏。

因此本仓库的定位是**诊断，不是修复**：把「模型真的把调用写进正文了吗」变成可复核的事实陈述，
交给上游去修。这也是 `src/markup-diagnosis.ts` 与 `scripts/verify-dsml.mjs` 的既有分工。

---

## 六、检测器修正：竖线个数不是 token 的一部分

原检测器只认双竖线 `｜｜DSML｜｜`，而**真实泄漏两种写法混用**。一次真实捕获的
正文块里，五种标记形态当场出现了两种竖线（原样抄录，未做规整）：

```text
<｜DSML｜ validate>                                    ← 单竖线，开头的工具名被写坏
<｜DSML｜ parameter name="spec">…</｜DSML｜ parameter>  ← 单竖线
</｜DSML｜ invoke>                                      ← 单竖线
</｜｜DSML｜｜ calls>                                    ← 双竖线
```

同一个块里既有单竖线也有双竖线，说明**竖线个数不是 token 的一部分**：它是写法变量，
不是身份。只用双竖线匹配，会对一个真的泄漏了四次的会话给出「一切正常」的报告——
而「检查永远不命中」看起来和「检查通过」一模一样，这正是 `FULLWIDTH_BAR` 的注释在上一层
已经警告过的坑。

修正（`src/markup-diagnosis.ts`）：

- 新增 `BARS = ｜｜?`（1–2 个全角竖线）与 `MARKUP_RE`，`findMarkup` / `hasMarkup` / `count`
  全部改为按它匹配；`MARKUP_TOKEN` 保留为**双竖线的参考写法**，供文档与调用方引用，
  不再作为唯一匹配口径。
- `CALL_ATTEMPT` 除 `invoke name="…"`（捕获工具名，供 `sampleTool` 用）外，
  再接受 **`parameter name=`** 子句：真实捕获的那次泄漏，开头被写坏成 `<｜DSML｜ validate>`
  （工具名占了 `invoke name="…"` 的位置），但每一个参数子句都是完整的——只看 `invoke name=`
  会漏掉它。
- 因此「在**行内反引号**里引用标记」也算 `mention`：参数子句既可能是调用，也可能是在**解释**
  语法，而解释性的引用会写在反引号里。

效果（`scripts/verify-dsml.mjs`，同一份会话记录）：

| | 修正前 | 修正后 |
|---|---|---|
| 判定为「正文里发出」 | 6 次 / 2 个会话 | **12 次 / 4 个会话** |
| 其中本会话 | **0 次**（完全看不见） | **5 次** |
| 单独计为「只是在讨论/引用」 | 0 次 | 13 次 |

新增 9 条守卫（含用真实捕获形态构造的用例），三次变异验证（退回双竖线、去掉 `parameter`
子句、取消反引号识别）均会变红。

---

## 七、对上层的建议

1. **不要再把「模型把工具调用写进正文」当成已修复后回归** —— 上游解析器修的是**服务端**那一侧；
   托管路径（DeepSeek API + 宿主）上，触发条件是**长上下文**，我们能动的杠杆只有**缩短上下文**
   （开新会话）与**不依赖工具调用通道做装饰性渲染**。
2. **若将来要在本插件里做恢复，必须照抄第三节那三道闸**：闭合才提交、按声明的工具名校验、
   无声明工具不恢复。缺任何一道，最坏的结果是把用户正文执行成一次真实调用。
3. **检测器要同时接受两种竖线**（已按第六节实现）。这与社区在客户端侧的做法一致。

---

## 八、引用

- [vLLM #48931](https://github.com/vllm-project/vllm/issues/48931) —— 根因、解析器级复现、建议修法
- [vLLM #55954](https://github.com/vllm-project/vllm/pull/55954) —— 已合并的孤儿 invoke 恢复
- [vLLM #56667](https://github.com/vllm-project/vllm/pull/56667) —— 急切恢复的三类生产事故与正确做法
- [vLLM #54838](https://github.com/vllm-project/vllm/pull/54838) —— 已合并：参数隐式闭合
- [vLLM #49117](https://github.com/vllm-project/vllm/pull/49117) —— 最早的完整恢复实现（关闭未合并）
- [vLLM #51914](https://github.com/vllm-project/vllm/issues/51914) / [#52645](https://github.com/vllm-project/vllm/pull/52645) —— 畸形包裹变体
- [vLLM #58057](https://github.com/vllm-project/vllm/pull/58057) —— Rust 前端缺同样恢复
- [DeepSeek-V4-Pro 讨论 #209](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/209) —— 客户端两种竖线兼容
- [边界诊断方法学](https://www.aifreeapi.com/en/posts/deepseek-v4-tool-calling-local-agent-troubleshooting) —— 五个边界、探针矩阵、「别把宽容解析器当修复」
- [NVIDIA 论坛：DSML closers 泄漏进回答](https://forums.developer.nvidia.com/t/deepseek-v4-flash-0731-dsml-tool-call-closers-leak-into-the-answer-after-latest-spark-vllm-b12x/381835)
- [r/LocalLLaMA：工具协议在多次调用后开始崩坏](https://www.reddit.com/r/LocalLLaMA/comments/1vtu779/i_really_want_deepseek_v4_to_work_as_a_local/)
