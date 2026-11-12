# Prompt cache: why a turn can cost the whole context

DSH ships the model a session surface whose node 0 is the system prompt. The
gateway's prefix cache is a byte match, so the moment that node changes — a
plugin installed, an MCP server added, a skill edited — the cache misses from
the first changed token onwards and the **entire context** is billed at the
uncached price. On a long session that is tens of credits in one turn, and it
looks like an ordinary turn in every log line except two counters: a large
`inputTokens` and a near-zero `cacheReadTokens`.

## What the adapter does about it

`dsh-llm-pi-ai` reads `compat.supportsMidConvoSystemMessages` off the model
descriptor and turns it into the request's `systemPromptUpdate: 'in-history'`.
The agent loop then appends a changed prompt **after** the cached history
instead of rewriting the leading system node, so the prefix through that history
stays reusable and only the appended prompt is new. `src/adapter.ts` declares
the flag for every catalog model.

## The two causes, and which one is avoidable

| Cause | What happened | Can a route avoid it |
| --- | --- | --- |
| `prompt-changed` | a `system/message` landed just before the request | **yes**, by declaring `in-history` — *provided the gateway obeys a `system` message that arrives AFTER the history*. Measured on the CN gateway; unverified elsewhere, which is why only that route declares it. A gateway that reads only the head would keep obeying the OLD prompt, so this is a capability to verify per upstream, not a switch to flip globally. |
| `cache-expired` | nothing changed; the provider aged the prefix out | no — the upstream clears unused prefixes within hours to days |

## Measuring it

```console
node scripts/audit-prompt-cache.mjs --dsh-home "<your DSH home>" \
  --credits-per-k 0.06005 --offpeak-factor 0.5
```

The script is offline and read-only; it decodes the session logs under
`<dsh-home>/sessions` and prints every turn that paid for its whole context,
worst first. Pass `--credits-per-k` only with a rate you trust — the price
differs by model and by day, so the script refuses to invent one and reports
tokens until you supply it.

## What the split actually looks like

The two causes are not equally common, and the ratio is a property of how you
work, not of the plugin. Two real machines, same script:

| | re-bills | `prompt-changed` | `cache-expired` |
| --- | --- | --- | --- |
| the PR that added this script | 23 | 6.1M tokens | 3.8M tokens |
| another install, 20,685 requests | 1,248 | 2.4M tokens (**1.1%**) | 219.9M tokens |

The second install changes plugins and skills rarely, so almost every re-bill it
suffers is `cache-expired` — the kind no configuration avoids. Run the script on
your own logs before assuming the first row. A single machine's ratio should
never be quoted as "the cost of this bug".

## Verifying the gateway reads a mid-history system message

Declaring `in-history` is only safe if the gateway treats the *latest* system
message at any position as the effective prompt. `scripts/probe-mid-convo-system.mjs`
answers that directly: it places a second system message after the history and
reads back which secret word the model obeys, together with the cache counters
for the same shape sent twice.

```console
node scripts/probe-mid-convo-system.mjs
```

A reply of `ZULU` (the second head) with a high warm-cache hit is the safe
case; a reply of `ALPHA` means the gateway reads only the head.
