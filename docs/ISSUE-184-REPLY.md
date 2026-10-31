# issue #184 回复草稿（可直接粘贴到 GitHub）

> 完整取证见 [`CACHE-HIT-70-RESEARCH.md`](./CACHE-HIT-70-RESEARCH.md)。
> 这份是给报告人看的版本，控制在能读完的长度。

---

感谢反馈。我按你说的数据来源（DSH 用量页）在本机做了全量取证，结论比预期复杂，先说要紧的。

## 一、口径先对齐：70% 这个数是可信的

用量页那个百分比来自 `dsh-client-ui-chat/lib/client.js:7490-7506`：

```js
function cacheHitPercent(usage) {
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage));
}
function billedInputTokens(usage) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
```

两点值得注意：

- **分母是 prompt 侧三桶之和，不含 output**；system prompt 不单独成桶，它落在 uncached 里。
  所以 system 越长，这个数越低。
- **它是整条会话日志的累计加权平均**（源码注释原文 "over the whole durable log"），
  不是当前轮瞬时值。冷启动会被后面的高命中轮次慢慢稀释 —— 「一直在 70 徘徊」字面上
  就是这个统计量的形态。

所以不用怀疑是算错了。

## 二、本机复现不出来：全机 97.5%

解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 逐请求统计，按模型分组：

| 模型 | 请求数 | prompt token | 命中率 |
| --- | --- | --- | --- |
| deepseek-v4.1-flash | 13,282 | 3,157,473,803 | **97.9%** |
| space-bunny | 862 | 132,648,250 | 99.0% |
| hy4-preview | 76 | 3,956,243 | 96.3% |
| hy3 | 27 | 1,011,059 | 89.0% |
| glm-5.3-flash | 18 | 554,017 | 77.1% |
| **minimax-m3.1-flash** | 278 | 25,136,718 | **44.6%** |
| **全机加权** | 14,543 | 3,320,780,090 | **97.5%** |

## 三、查出来的第一条真问题：`minimax-m3.1-flash` 完全不复用缓存

同一凭据、同一份字节连发 6 次，中间不换账号（插件不在路径上，直接用插件自己的
请求路径）：

```
deepseek-v4.1-flash: 97% → 97% → 97% → 97% → 97% → 97%   STABLE
minimax-m3.1-flash :  2% →  2% →  2% →  0% →  0% →  2%   ALTERNATING
```

再用真实对话形状（前缀逐轮增长，23k→26k token，同一凭据 4 轮）：

```
deepseek-v4.1-flash  round2 94.9%  round3 95.4%  round4 95.4%
minimax-m3.1-flash   round2  0.5%  round3  0.8%  round4  0.7%
```

这跟插件无关，是模型/后端事实。形态和 `9router` issue #2929 记录的
「上游多后端推理实例无 session affinity，请求被 round-robin 到不同实例，
各实例只有本地 prompt cache」一致。

**而它会拉低会话级数字**：本机 61 个混用多个模型的会话，命中率分布正好落在
55%–75% 这一带：

```
 24.4%  workbuddy/minimax-m3.1-flash | workbuddy/hy4-preview
 55.3%  modelflare/gpt-6.1-sol | workbuddy/deepseek-v4.1-flash
 68.4%  modelflare/gpt-6.1-sol | minmax/MiniMax-M3.1-Flash | ... | workbuddy/deepseek-v4.1-flash
 74.4%  (6 个模型，含 workbuddy/deepseek-v4.1-flash)
```

反推需要多大的混合比例：deepseek 端值 0.979、minimax 端值 0.446，

```
0.979·w + 0.446·(1−w) = 0.70  ⇒  minimax 占 52.3% 的 prompt 量
```

所以**如果那条 70% 的会话里混入了大量 minimax，一切都对得上**。
这是我目前最怀疑的成因。

## 四、也能造成 70% 的另一种形状：大面积冷启动

同一模型上如果冷请求占 28.5%，平均就是 70.0%（本机 deepseek 实测冷请求只占 1%）。
冷启动的来源之一是**账号池换号** —— 我实测确认缓存是**按账号隔离**的：

```
A warm : prompt=8412 hit=8192 (97.4%)
A same : prompt=8417 hit=8192 (97.3%)
B same : prompt=8417 hit=0    (0.0%)   ← 同一分钟、同一份字节
A ctrl : prompt=8417 hit=8192 (97.3%)   ← A 事后仍命中，排除「前缀未热」
```

所以任何账号切换都要付一次完整冷前缀。不过本机的号池被手排顺序钉住，
换号频率远低于每 3.8 个请求一次（那才是造成 70% 所需的量级）。

## 五、关于「换成反代就没事了」

这个线索有帮助，但它指向的不是「插件改坏了字节」。

- 反代只原样转发，**不建账号池**。所以它天然没有「换号 → 冷前缀」这个开销。
- 插件在 `keepPromptLast` 关闭时，对 body 的所有改写（`developer`→`system`、
  system 头补齐、渠道指纹中和、`tool_choice` 展平）都是**逐消息确定性变换**，
  构造上保前缀。我构造了一份同时含全部改写触点的 body（banned 的 system 开头、
  `developer` 角色、assistant 回显 banned 文案、对象形 `tool_choice`），
  在 1–10 轮的 8 个深度上实测，7/7 个相邻对前缀保留 **100.00%**。

所以「反代没事」更可能是「反代不做账号轮换」，而不是「插件污染了 prompt」。

## 五之二、补充取证：还有一个比开关更大的原因

我在自己机器上又追了一层，查到的**最大单一成因不是插件改字节，而是工具注册表在会话中途增删工具**。
会话里 `system/message` 每次变更都是一整段前缀失效，实测某会话的 7 个版本：

| turn | system 长度 | 同期工具事件 | 该 turn 命中率 |
| --- | --- | --- | --- |
| 1 | 13,512 | 首次挂载 | 88.3% |
| 5 | **39,092** | +8 个工具（`purge_apply` / `team_task_*` 等） | 85.3% |
| 6 | 13,562 | +`create_worktree` / `session_search` 等 | **0.0%** |
| 8 | 10,204 | −2 个工具 | **0.0%** |
| 9 | 10,011 | +`bsk_*` 全套 + `mcp` 全套 | **0.0%** |
| 10 | 13,834 | +`acp_*` / `compress` / `render_ui` 等 | **0.0%** |
| 12–37 | **未再变化** | 无 | **96–99.5%** |

system 一变就归零，turn 12 之后 system 不再变，命中率立刻稳定在 96% 以上。
驱动者是 `developer/message`（`source.kind: tool-registry`）——**任何按需装配工具的插件
（MCP、浏览器、搜索、子代理）装载或卸载时都会触发**，不限于某一个插件。

所以如果你的会话是「一开始只装了少量工具、中途逐个开起来」的形态，命中率会长时间被压在低位，
这与你说的「换反代就没事」也吻合：反代通常不会在会话中途改你的 system 段。

## 六、一个确实存在的 bug，但它的量级不够

`keepPromptLast`（那个「记录你真正输入的话，而不是注入的上下文」开关）有 bug：
它只把**尾部**注入块搬到提问前，历史里的不搬，于是每轮边界前缀都会断。
实测（真实 `prepareChatBody` + 真实消息形状）：

```
关闭:  request 2 OK 100.0%   request 3 OK 100.0%   request 4 OK 100.0%
开启:  request 2 BREAK 98.6%  request 3 BREAK 98.8%  request 4 BREAK 98.9%
```

**但真实代价只有 −1.74 个点**（20 轮 × 4 step = 79 个请求：
98.26% vs 100.00%）。原因是真实宿主并不每个 step 都注入 —— 我扫了两个真实会话，
`386` 个 step 只有 `12` 条注入（0.03 条/step），注入集中在每轮第 1 步。

所以：**这个 bug 该修，但它不是 70% 的答案。** 关掉开关只能拿回 1.74 个点，
不会有可见变化。

（顺带说明：这个开关默认关闭，且只在插件挂载时读一次。如果你改完配置没重启宿主，
它其实还没生效。）

## 七、想请你确认三件事

1. 那条 70% 的会话里，**有没有用过子代理**？如果有，`dsh-subagent-default-model`
   的候选模型里是否含 `minimax-m3.1-flash`（或别的 `minimax` 系）？
2. 那张截图能不能展开一下模型列表，或者直接说清楚会话里跑过哪些模型？
3. 如果方便，把该会话的 `session.v4.jsonl.zstd` 脱敏后附上（只含 usage 计数器即可，
   不含 prompt 正文）。我可以给出可直接运行的脚本定位到具体请求。

第 1 条如果命中了，这份 issue 就能定性了 —— 而且修法不在于改插件，而在于
**别把不复用缓存的模型放进子代理随机池**。

## 八、我能提供的

完整取证文档（含 11 个可复现脚本、全部原始数字、已排除方向的逐条依据）：
`docs/CACHE-HIT-70-RESEARCH.md`。

如果你确认成因与我推测的一致，我可以接着做：

- 给 `keepPromptLast` 补一条**前缀单调性属性测试**（现有 13 个用例全是单请求快照
  断言，没有一个测跨请求前缀稳定性——这是它能 13/13 全绿却带着 bug 上线的原因），
- 修重排逻辑（所有注入块按同一规则归位 + 幂等守卫）。

但这两项都不解决你的 70%。
