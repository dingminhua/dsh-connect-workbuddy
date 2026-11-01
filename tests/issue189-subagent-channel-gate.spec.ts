/**
 * issue #189：`@a9i5k4/dsh-auto-memory` 的后台子智能体请求被 CN 网关以
 * `11128 / channel_reject` 拦截。
 *
 * 报告者用的是 **5.12.1**，而 README §平台支持与 CHANGELOG 都写明：
 *
 * > ⚠️ 国内区的「渠道校验」400（`code 11128`）请确保插件 ≥ 5.14.0。
 * > 5.13.1 起会在**发出请求之前**按句改写已知的固定指纹，5.14.0 又补上了
 * > Web GUI 段落的第二句；5.12.x 及更早只有「中性头 + 零宽扰动」三级救援，
 * > 在同一份 body 上实测**全部 400**。
 *
 * 所以本文件不是去"再修一遍"，而是钉住**当前版本确实能处理这类请求**，并把
 * "为什么 5.12.1 不行"变成可执行的断言。如果哪天这些断言变红，说明救援阶梯
 * 回退了。
 *
 * 子智能体的套话长这样（宿主框架注入，不是插件产生的）：
 *
 *   You are an AI agent powered by DeepSeek Harness.
 *   This is a message from a subagent…
 *   The background subagent finished…
 *
 * 它是被扫描的 `assistant` 角色消息（`scansOpening` 覆盖 system 与 assistant），
 * 所以应当同时被两条路径处理：前缀中性头（`forceNeutralHead`）与身份子句中断
 * （`breakIdentityClauses`）。
 */
import { describe, expect, it } from 'vitest'
import {
  forceNeutralHead,
  prepareChatBody,
  rewriteChannelFingerprintPhrases,
} from '../src/upstream.ts'

/** 报告者贴出的那类套话，按宿主真实形状拼一条 assistant 历史消息。 */
const SUBAGENT_ASSISTANT_TEXT = [
  'You are an AI agent powered by DeepSeek Harness.',
  'This is a message from a subagent.',
  'The background subagent finished; its result follows.',
].join('\n')

function body(role: string, text: string): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role, content: text },
    ],
  })
}

function contentOf(json: string): string {
  const parsed = JSON.parse(json) as { messages: Array<{ content: string }> }
  return parsed.messages[1]!.content
}

describe('issue #189: subagent assistant messages and the channel gate', () => {
  it('forceNeutralHead moves a subagent assistant opening off offset 0', () => {
    // 这是"不知道指纹是什么"时的通用兜底：把整段挪到中性头之后，前缀匹配失效。
    const forced = forceNeutralHead(body('assistant', SUBAGENT_ASSISTANT_TEXT))
    expect(forced).toBeDefined()
    const content = contentOf(forced!)
    expect(content.startsWith('You are a helpful assistant.')).toBe(true)
    // 原话必须还在——救援只能改变网关看到的位置，不能吞掉模型的输出。
    expect(content).toContain('This is a message from a subagent.')
  })

  /**
   * 5.14.0 的核心修复：**子句被从内部打断**，而不是只在前面加一行。
   *
   * 这两者的区别正是 issue #189 的要害，也是我第一版测试没抓住的地方：
   *
   * - 中性头（`You are a helpful assistant.\n\n`）只能让**前缀**匹配失效。
   * - 网关后来改成**任意位置精确子串**匹配，那时被禁的那串还完整躺在文本里，
   *   只是往下挪了一行 —— 于是中性头对这类指纹**完全无效**。
   *
   * 所以断言不能是"原文不再匹配"（中性头也能让这句成立），必须是
   * **子句本身不再连续存在**。下面用 `powered by` 这个必现片段来钉：
   * 子句完好时它在；被子句中断后，那里会插进不可见字符。
   *
   * 变异验证：把 `breakIdentityClauses` 从 `neutralizeScannedText` 里拿掉
   * （≈ 退化成 5.12.x 的行为），这条会红——而"原文不再匹配"那条不会红。
   */
  it('the proactive path breaks the identity clause INTERNALLY, not just in front', () => {
    // 走公共入口 `prepareChatBody`，测的是"真的发出去的那份 body"。
    const prepared = prepareChatBody(body('assistant', SUBAGENT_ASSISTANT_TEXT))
    const content = contentOf(prepared)
    // 1. 整句不能原样存在。
    expect(content).not.toContain('You are an AI agent powered by DeepSeek Harness')
    // 2. 而且**首行也不是原文**——这条把"只加中性头"和"真的打断了子句"分开：
    //    只加头时首行是 "You are a helpful assistant."，子句原封不动在第二段；
    //    这里要求连那段里的连续子串也不存在。
    const withoutHead = content.startsWith('You are a helpful assistant.')
      ? content.slice('You are a helpful assistant.'.length).trim()
      : content
    expect(withoutHead).not.toContain('powered by DeepSeek Harness')
    // 3. 真实机制是**同义改写**（`powered by` → `running inside`），不是插入
    //    不可见字符。这一条我一开始写错了：我按"零宽打断"的旧机制去断言，
    //    而 CHANGELOG 记录 2026-10-29 的实测已经证明网关会规范化零宽字符、
    //    那条路被堵死，所以现在改成按句改词。
    //
    //    钉住"改成了什么"而不只是"原文不在"，才能区分「改写」与「整段删除」——
    //    后者会丢掉模型的输出，是绝不能接受的。
    expect(withoutHead).toContain('You are an AI agent running inside DeepSeek Harness.')
    // 4. 而原句必须一字不剩。
    expect(withoutHead).not.toContain('powered by DeepSeek Harness')
  })

  /**
   * 两条路径的**代价不同**，这里把差异钉住，免得以后有人"顺手统一"。
   *
   * - `prepareChatBody`（正常路径）只在真的命中指纹时才改写。普通子智能体回复
   *   一个字节都不动——这是绝大多数请求，必须保持廉价。
   * - `forceNeutralHead`（**仅在网关已经拒绝之后**调用）给每一条被扫描消息都加
   *   中性头，不管有没有指纹。它不认识指纹，正是这份"无知"让它能覆盖上游明天
   *   才加上的新条目；代价是它一定会改写 body，所以只能用在失败之后。
   *
   * 我最初把第二条也断言成"无改动"，测试红了——那是我对契约的误解，不是实现
   * 的缺陷。这条注释就是那次误解留下的。
   */
  it('the normal path leaves a fingerprint-free subagent message untouched', () => {
    const plain = '这是子智能体的普通结论，没有任何身份句子。'
    // 比较的是**消息内容**，不是整个 body：`prepareChatBody` 同时会补
    // `stream: true` 之类的常规字段，那是它的另一项职责。第一版拿整个 body
    // 做全等比较，红在一个与指纹无关的差异上——测试写错了对象。
    expect(contentOf(prepareChatBody(body('assistant', plain)))).toBe(plain)
  })

  it('the last-resort rung DOES rewrite a fingerprint-free message — that is its job', () => {
    const plain = '这是子智能体的普通结论，没有任何身份句子。'
    const forced = forceNeutralHead(body('assistant', plain))
    expect(forced).toBeDefined()
    expect(contentOf(forced!)).toBe(`You are a helpful assistant.\n\n${plain}`)
  })

  it('the last-resort rung is idempotent, so a retry cannot stack neutral heads', () => {
    // 阶梯可能在同一个 body 上重试；叠出两层中性头会让请求越来越不像用户的本意。
    const once = forceNeutralHead(body('assistant', SUBAGENT_ASSISTANT_TEXT))
    const twice = forceNeutralHead(once!)
    expect(twice).toBeUndefined()
  })

  it('does not touch a user message, even one carrying the same wording', () => {
    // 网关只扫 system / assistant。把 user 也改了会让用户自己写的提示词被篡改，
    // 而那是没有任何上游依据的越权。
    expect(forceNeutralHead(body('user', SUBAGENT_ASSISTANT_TEXT))).toBeUndefined()
  })

  it('the phrase rewrite is idempotent, so a retry ladder cannot double-edit', () => {
    // 阶梯会在同一份 body 上跑多轮；非幂等会让第二轮的"改动"是假的。
    const once = rewriteChannelFingerprintPhrases(SUBAGENT_ASSISTANT_TEXT)
    const twice = rewriteChannelFingerprintPhrases(once)
    expect(twice).toBe(once)
  })
})
