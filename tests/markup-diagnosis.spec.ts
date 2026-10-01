import { describe, expect, it } from 'vitest'
import {
  analyzeSessionEvents,
  classifyRecordedText,
  classifyStream,
  explainShape,
  findMarkup,
  FULLWIDTH_BAR,
  MARKUP_TOKEN,
  parseStream,
} from '../src/markup-diagnosis.ts'
import type { RecordedMessage } from '../src/markup-diagnosis.ts'

/**
 * The WorkBuddy upstream sometimes writes its tool call into the assistant TEXT
 * as markup instead of returning a structured `tool_calls` array. These tests
 * lock the DETECTION of that shape, because the whole point of the module is
 * that the claim is checkable: if detection silently stops matching, the
 * diagnostic reports "clean" and the reader is misled by the very tool built to
 * stop them being misled.
 *
 * The most important test here is the one about U+FF5C versus ASCII `|`. The
 * markup uses a FULL-WIDTH vertical line, which is nearly indistinguishable
 * from ASCII in most fonts. A hand-typed literal pipe in the source would make
 * every check here return "no markup" — a false clean bill of health that looks
 * identical to a genuine one.
 */

/** Build one SSE `data:` frame the way the upstream emits it. */
function frame(delta: Record<string, unknown>, finishReason = ''): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

/** A response whose call was written into the text, as captured in the wild. */
function markupBody(): string {
  const text = `<${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR} calls>`
    + `<${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR} invoke name="bash">`
  return frame({ content: '', tool_calls: [] })
    + frame({ content: '<' })
    + frame({ content: text.slice(1) })
    + frame({}, 'stop')
}

/** A healthy response: the call arrives structurally. */
function nativeBody(): string {
  return frame({ content: '', tool_calls: [] })
    + frame({ content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] })
    + frame({ content: '', tool_calls: [{ function: { arguments: '{"command":"ls"}' } }] })
    + frame({}, 'tool_calls')
}

describe('MARKUP_TOKEN', () => {
  it('is built from the FULL-WIDTH bar, not the ASCII pipe', () => {
    // The regression this guards: typing `||DSML||` with ASCII looks right in
    // every diff view and matches nothing the model ever sends.
    expect(MARKUP_TOKEN).toContain(FULLWIDTH_BAR)
    expect(MARKUP_TOKEN).not.toContain('|')
    expect(FULLWIDTH_BAR).toBe('\uff5c')
    expect(MARKUP_TOKEN).toBe('\uff5c\uff5cDSML\uff5c\uff5c')
  })

  it('does not match an ASCII lookalike, so a false clean is impossible', () => {
    const ascii = '||DSML|| calls>'
    expect(classifyStream(frame({ content: ascii })).hasMarkup).toBe(false)
    // …while the real thing on the same frame shape does match.
    expect(classifyStream(frame({ content: MARKUP_TOKEN })).hasMarkup).toBe(true)
  })
})

describe('classifyStream', () => {
  it('calls markup-in-content what it is, even though other frames carry tool_calls', () => {
    // The ordering rule: a response can contain BOTH an empty native frame and
    // the markup. Reporting "native" because a `tool_calls` array exists
    // somewhere would hide exactly the defect being looked for.
    const body = frame({ content: '', tool_calls: [{ function: { name: 'bash' } }] }) + frame({ content: MARKUP_TOKEN })
    const verdict = classifyStream(body)
    expect(verdict.shape).toBe('markup-in-content')
    expect(verdict.toolCallFrames).toBe(1)
    expect(verdict.hasMarkup).toBe(true)
  })

  it('calls a structured call native', () => {
    const verdict = classifyStream(nativeBody())
    expect(verdict.shape).toBe('native-tool-call')
    expect(verdict.toolCallFrames).toBe(2)
    expect(verdict.hasMarkup).toBe(false)
    expect(verdict.finishReason).toBe('tool_calls')
  })

  it('separates plain prose from a defect', () => {
    const verdict = classifyStream(frame({ content: '好的，我来说明一下。' }) + frame({}, 'stop'))
    expect(verdict.shape).toBe('text-only')
    expect(verdict.contentFrames).toBe(1)
    expect(verdict.finishReason).toBe('stop')
  })

  it('separates an empty response from prose, so it cannot pass as evidence', () => {
    // A truncated or errored stream must not read as "the model declined to
    // call a tool" — that would be a false negative for the defect.
    expect(classifyStream('').shape).toBe('empty')
    expect(classifyStream(frame({ content: '', tool_calls: [] }, 'stop')).shape).toBe('empty')
  })

  it('counts malformed frames instead of throwing on the stream it must describe', () => {
    const body = 'data: {not json}\n' + frame({ content: 'hi' })
    const verdict = classifyStream(body)
    expect(verdict.unparsableFrames).toBe(1)
    expect(verdict.dataFrames).toBe(2)
    // …and still reaches a verdict from the frames that DID parse.
    expect(verdict.shape).toBe('text-only')
  })

  it('ignores keepalives and [DONE] rather than counting them as frames', () => {
    const body = 'data: [DONE]\n\n' + 'data: \n\n' + frame({ content: 'hi' })
    expect(classifyStream(body).dataFrames).toBe(1)
  })

  it('sums content length so a reader can see how much text leaked', () => {
    const body = frame({ content: 'abc' }) + frame({ content: 'de' })
    const verdict = classifyStream(body)
    expect(verdict.contentChars).toBe(5)
    expect(verdict.contentFrames).toBe(2)
  })

  it('captures the tool name when the call is structured', () => {
    expect(parseStream(nativeBody()).chunks.some(c => c.toolName === 'bash')).toBe(true)
  })

  it('takes the LAST finish_reason, since earlier frames leave it empty', () => {
    const body = frame({ content: 'x' }) + frame({}, 'stop')
    expect(classifyStream(body).finishReason).toBe('stop')
  })
})

describe('findMarkup', () => {
  it('returns null when absent, so callers test one value', () => {
    expect(findMarkup('ordinary assistant prose')).toBeNull()
  })

  it('counts EVERY occurrence, not just the first', () => {
    // The count is quoted to users as a severity number, so an implementation
    // that stopped at the first hit would understate a 5-markup message as 1.
    const text = `${MARKUP_TOKEN} a ${MARKUP_TOKEN} b ${MARKUP_TOKEN}`
    expect(findMarkup(text)?.count).toBe(3)
  })

  it('reports the damaged surroundings verbatim, since the damage is the evidence', () => {
    // A well-formed call would have been routed. What proves it was not is the
    // mismatched brackets the reader can see in the excerpt.
    const text = `前缀 <${MARKUP_TOKEN} validate> ${MARKUP_TOKEN} parameter name="spec">`
    const hit = findMarkup(text)
    expect(hit).not.toBeNull()
    expect(hit?.excerpt).toContain('validate>')
    expect(hit?.at).toBe(text.indexOf(MARKUP_TOKEN))
  })

  it('survives being asked for a zero-radius excerpt at the very start', () => {
    const hit = findMarkup(`${MARKUP_TOKEN} calls>`)
    expect(hit?.at).toBe(0)
  })
})

describe('classifyRecordedText', () => {
  const attempt = (name: string) =>
    `<${MARKUP_TOKEN} calls>\n<${MARKUP_TOKEN} invoke name="${name}">\n<${MARKUP_TOKEN} parameter name="command">ls</${MARKUP_TOKEN} parameter>\n</${MARKUP_TOKEN} invoke>\n</${MARKUP_TOKEN} calls>`

  it('calls an unfenced call attempt an emission', () => {
    // The defect: the model finished prose and then appended a call the
    // platform never routed. Observed at the END of a message, not in a fence.
    const text = `Let me inspect the existing icon usage.\n\n${attempt('bash')}`
    expect(classifyRecordedText(text)).toBe('emission')
  })

  it('calls a fenced call attempt a mention, not an occurrence', () => {
    // An assistant EXPLAINING the defect shows it inside a code fence. Counting
    // that as "it happened again" is how a diagnostic inflates its own number:
    // on this project's sessions it turned 6 real emissions into 20.
    const text = `你贴出的内容里有一个工具调用格式错误：\n\n\`\`\`\n${attempt('read')}\n\`\`\``
    expect(classifyRecordedText(text)).toBe('mention')
  })

  it('ignores a bare token with no invoke clause', () => {
    // Prose like "the marker looks like ｜｜DSML｜｜" is neither an emission nor a
    // quotation of a call — it must not land in either bucket.
    expect(classifyRecordedText('标记形如 `' + MARKUP_TOKEN + '` 这样的东西')).toBe('none')
    expect(classifyRecordedText(`${MARKUP_TOKEN} calls>`)).toBe('none')
  })

  it('ignores ordinary prose entirely', () => {
    expect(classifyRecordedText('没有任何标记的普通回答')).toBe('none')
  })

  it('treats a fence that CLOSES before the attempt as closed', () => {
    // Two fence markers = one finished block, so the attempt after it is real.
    const text = `示例：\n\n\`\`\`\n${MARKUP_TOKEN} calls>\n\`\`\`\n\n继续。\n\n${attempt('bash')}`
    expect(classifyRecordedText(text)).toBe('emission')
  })
})

describe('analyzeSessionEvents', () => {
  const attempt = (name: string) =>
    `<${MARKUP_TOKEN} calls>\n<${MARKUP_TOKEN} invoke name="${name}">\n</${MARKUP_TOKEN} invoke>\n</${MARKUP_TOKEN} calls>`
  const msg = (over: Partial<RecordedMessage>): RecordedMessage =>
    ({ blockTypes: ['text'], text: 'ok', ...over })

  it('counts call attempts the host never routed', () => {
    const report = analyzeSessionEvents([
      msg({ text: `prose then ${attempt('bash')}` }),
      msg({ text: 'clean' }),
      msg({ text: `${attempt('read')}` }),
    ])
    expect(report.emissions).toBe(2)
    expect(report.sample?.text).toContain(MARKUP_TOKEN)
    expect(report.sampleTool).toBe('bash')
  })

  it('keeps quotations out of the count', () => {
    // The correction that matters: a message quoting the markup must not make
    // the defect look more frequent than it is.
    const report = analyzeSessionEvents([
      msg({ text: `${attempt('bash')}` }),
      msg({ text: `\`\`\`\n${attempt('read')}\n\`\`\`` }),
      msg({ text: `\`\`\`\n${attempt('read')}\n\`\`\`` }),
    ])
    expect(report.emissions).toBe(1)
    expect(report.mentions).toBe(2)
  })

  it('reports how many emissions ALSO carried a real tool-call block', () => {
    // This pair answers "was it already fixed?": an emission with zero
    // tool-call blocks was rendered as prose by definition, because there was
    // no structured call for the host to route.
    const report = analyzeSessionEvents([
      msg({ blockTypes: ['text'], text: `${attempt('bash')}` }),               // leaked
      msg({ blockTypes: ['text', 'tool-call'], text: `${attempt('bash')}` }),  // markup + real call
    ])
    expect(report.emissions).toBe(2)
    expect(report.emissionsWithStructuredCall).toBe(1)
  })

  it('reports a clean transcript as clean', () => {
    const report = analyzeSessionEvents([msg({ text: 'ordinary' }), msg({ text: 'answer' })])
    expect(report.emissions).toBe(0)
    expect(report.emissionsWithStructuredCall).toBe(0)
    expect(report.mentions).toBe(0)
    expect(report.sample).toBeNull()
    expect(report.sampleTool).toBeUndefined()
  })

  it('handles an empty transcript', () => {
    expect(analyzeSessionEvents([])).toEqual({
      emissions: 0,
      emissionsWithStructuredCall: 0,
      mentions: 0,
      sampleTool: undefined,
      sample: null,
    })
  })
})

describe('explainShape', () => {
  it('names the defect plainly and quotes the markup count', () => {
    const verdict = classifyStream(frame({ content: `${MARKUP_TOKEN} a ${MARKUP_TOKEN}` }))
    const said = explainShape(verdict)
    expect(said).toContain('2 处标记')
    expect(said).toContain('正文')
  })

  it('refuses to call a non-reproduction evidence', () => {
    // A clean run must not read as "the defect is gone" — the model oscillates,
    // so one clean response is not proof of anything.
    expect(explainShape(classifyStream(nativeBody()))).toContain('没有复现')
    expect(explainShape(classifyStream(''))).toContain('不能作为证据')
    expect(explainShape(classifyStream(frame({ content: 'hi' })))).toContain('不能作为证据')
  })

  it('always returns a sentence, for every shape', () => {
    for (const body of [markupBody(), nativeBody(), frame({ content: 'x' }), '']) {
      expect(explainShape(classifyStream(body)).length).toBeGreaterThan(0)
    }
  })
})

describe('bar tolerance: the marker is spelled with one or two bars', () => {
  /**
   * The exact five marker shapes from ONE real captured emission.
   *
   * Transcribed from this project's own session log (a `｜DSML｜ validate` block):
   * the bars are doubled only on the final closer, so a detector keyed on the
   * doubled spelling reported nothing for a session that had leaked four times.
   */
  const REAL_EMISSION = [
    `prefix line`,
    `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} validate>`,
    `<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter name="spec">{"title":"x"}</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} parameter>`,
    `</${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR} invoke>`,
    `</${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR} calls>`,
  ].join('\n')

  it('finds a single-bar marker', () => {
    // The canonical spelling upstream uses: vLLM's own reproduction of this
    // defect writes `<｜DSML｜invoke name="terminal"><｜DSML｜parameter …>`.
    expect(findMarkup(`<${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}invoke name="bash">`)).not.toBeNull()
  })

  it('finds a doubled-bar marker', () => {
    expect(findMarkup(`<${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR} calls>`)).not.toBeNull()
  })

  it('counts every occurrence in a mixed-spelling block', () => {
    const hit = findMarkup(REAL_EMISSION)
    // Five markers, three of them single-bar. A doubled-only matcher sees ONE.
    expect(hit?.count).toBe(5)
  })

  it('reports the offset of the first marker, in any spelling', () => {
    const hit = findMarkup(REAL_EMISSION)
    // The offset points at the MARKER (the first bar), not at the `<` that opens
    // the tag — that is what "where the markup sits" means to a reader of the
    // excerpt.
    const tagAt = REAL_EMISSION.indexOf('<')
    expect(hit?.at).toBe(tagAt + 1)
  })

  it('classifies the real emission as an emission, not a mention', () => {
    expect(classifyRecordedText(REAL_EMISSION)).toBe('emission')
  })

  it('still classifies a fenced quotation as a mention', () => {
    const quoted = 'Here is how it looks:\n\n```\n' + REAL_EMISSION + '\n```\n'
    expect(classifyRecordedText(quoted)).toBe('mention')
  })

  it('classifies an inline-backtick quotation as a mention', () => {
    // Prose explaining the grammar writes the tag in backticks. Counting that as
    // an occurrence would inflate the number by exactly the messages that are
    // trying to describe the defect — and the parameter clause is now one of the
    // call-attempt shapes, so this case had to be handled with it.
    const prose = 'The opener is `<' + FULLWIDTH_BAR + 'DSML' + FULLWIDTH_BAR
      + ' parameter name="spec">` in that block.'
    expect(classifyRecordedText(prose)).toBe('mention')
  })

  it('counts a session that leaked with single bars', () => {
    // The regression this whole change exists for: a session with four real
    // emissions reported ZERO because every one of them used single bars.
    const report = analyzeSessionEvents([
      { blockTypes: ['text'], text: REAL_EMISSION, provider: 'p', model: 'm', seq: 1 },
      { blockTypes: ['text'], text: REAL_EMISSION, provider: 'p', model: 'm', seq: 2 },
    ])
    expect(report.emissions).toBe(2)
    expect(report.emissionsWithStructuredCall).toBe(0)
  })

  it('does not count ordinary prose that merely mentions the word', () => {
    // No marker, no defect — the token is the only thing that counts.
    expect(findMarkup('DSML is a markup format used by DeepSeek.')).toBeNull()
    expect(classifyRecordedText('DSML is a markup format.')).toBe('none')
  })
})
