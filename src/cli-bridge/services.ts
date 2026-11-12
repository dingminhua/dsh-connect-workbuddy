/**
 * The two host services this bridge uses, typed structurally.
 *
 * WHY NOT IMPORT THE REAL TYPES. `@deepseek-ai/dsh-tools` and the commands
 * service are provided by the Host at runtime, but neither package is a
 * dependency of this plugin, and adding one would make the plugin refuse to
 * install on a Host that does not publish it. The bridge touches a very small
 * surface — `register()` and the shape of what it registers — so declaring that
 * surface here keeps the dependency list untouched while still type-checking
 * every field the Host will actually read.
 *
 * These are deliberately MINIMAL: a field the bridge does not read is not
 * declared, so nothing here can drift into a promise the Host never made.
 *
 * @module dsh-connect-workbuddy/cli-bridge/services
 */

/** The per-call context the Host hands to a tool's `execute`. */
export interface BridgeToolExecution {
  /** Cancels the call; the bridge forwards it to the CLI child process. */
  signal?: AbortSignal
  /**
   * Reserved by the Host. As of 4.15.x it is NOT populated with the session's
   * cwd. Kept as an optional read because a future Host may start filling it.
   */
  cwd?: string
  /**
   * The agent that called the tool.
   *
   * THIS IS WHERE THE SESSION CWD COMES FROM. The Host does not put a `cwd` on
   * the execution object, but it does pass the calling agent, and the agent
   * carries the session header — whose `cwd` the session service guarantees is
   * absolute. Reading it here is what lets a turn default to the directory the
   * human is actually looking at instead of demanding one from the model.
   */
  agent?: BridgeAgentRef
}

/** The slice of a live agent both entrances read. */
export interface BridgeAgentRef {
  /** Equal to the session id; used as the per-session budget key. */
  id?: string
  status?: string
  /**
   * The session this agent is running in, as far as the bridge reads it.
   *
   * `header.cwd` is the session's CREATION metadata — the directory the session was
   * opened with, and never updated since. The live directory is not on the header at
   * all: the Host keeps it as a projection under `workingDirectory`, which is why
   * `sessionDirOf` takes a reader rather than reading a field here. `workingDirectory`
   * on this type is ONLY what tests and the command adapter use to hand the reader a
   * session-shaped object; the bridge never reads it directly.
   */
  session?: { header?: { cwd?: string }; workingDirectory?: string | null }
}

/**
 * The Host's session-projection service, typed structurally (see the file header
 * for why nothing Host-owned is imported here).
 *
 * WHY THIS EXISTS. `agent.session.header.cwd` is the session's CREATION-time
 * directory, not its current one: the Host documents its own session header as
 * "detached, deep-frozen creation metadata (format version, cwd, lineage...)".
 * The live directory lives in a session projection the Host maintains —
 * `key: "workingDirectory"`, `init: header => header.cwd ?? null`, `apply` on every
 * `working-directory/change` event (the Host's `@deepseek-ai/dsh-working-directory`
 * package). A `/cd` — which the Host exposes to the model as the
 * `working_directory` tool — appends one of those events, so afterwards the two
 * values disagree and the header keeps pointing at a directory nobody is looking
 * at any more.
 *
 * Reading the projection instead makes this bridge agree with what the Host
 * itself puts in the model's system prompt ("Current working directory: ...").
 *
 * `snapshot` is SYNCHRONOUS and does no filesystem I/O, which is what lets the
 * directory ladder stay the synchronous first step of `execute`.
 *
 * WHY `snapshot` AND NOT `stateOf`. `stateOf(session, key)` was the read face
 * this bridge started on, and DSH 0.2.2 deprecated it (the rc.2 declarations
 * mark it `@deprecated`, pointing at `snapshot` or a retained unit handle). It
 * still answers correctly, so this is not a break — it is a warning printed
 * once per key per process, i.e. exactly the kind of noise a working install
 * should not produce. `snapshot(session, keys).values[key]` is the same read:
 * synchronous, no I/O, and `undefined` for a key that was never committed,
 * which is the same "nothing recorded" signal `stateOf` gave.
 *
 * `stateOf` is KEPT as the second choice below rather than deleted, because a
 * Host is free to be older than the deprecation, and the cost of asking once
 * about one key is a single synchronous property read per turn.
 */
export interface BridgeProjectionReader {
  /**
   * Whole current client values for the requested keys, or `undefined` when the
   * service cannot answer. Read structurally: the caller validates the value's
   * type instead of trusting a declared one.
   */
  snapshot?(session: unknown, keys?: readonly string[]): { values?: Record<string, unknown> } | undefined
  /**
   * The committed state for one session, or `null`/`undefined` when the key has
   * never been committed for it. Deprecated by the Host since DSH 0.2.2 and
   * only consulted when `snapshot` is absent.
   */
  stateOf?(session: unknown, key: string): unknown
}

/**
 * Read one projection key through whichever face the Host offers.
 *
 * Extracted from the `ctx.inject(['sessionProjections'])` closure so the
 * PREFERENCE is testable: on a current Host `snapshot` must answer and
 * `stateOf` must never be called (it prints a deprecation warning the first
 * time it is), while an older Host that has only `stateOf` must still answer
 * instead of silently reporting "no directory".
 *
 * `undefined` means "the Host recorded nothing", which is the same signal both
 * faces give, and the ladder above treats it as such — it must NOT be confused
 * with a failure, or the header fallback would disappear. A throw is the
 * caller's to catch (the inject closure does).
 */
export function readProjectedState(
  reader: BridgeProjectionReader,
  session: unknown,
  key: string,
): unknown {
  if (typeof reader.snapshot === 'function') {
    return reader.snapshot(session, [key])?.values?.[key]
  }
  return reader.stateOf?.(session, key)
}

/** One tool registration, as the Host's `tools.register` accepts it. */
export interface BridgeToolDefinition {
  name: string
  description: string
  timeoutMs?: number
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, execution: BridgeToolExecution): Promise<unknown>
}

/** The Host's tool registry. */
export interface BridgeToolsService {
  register(definition: BridgeToolDefinition): () => void
}

/** What a slash-command handler is invoked with. */
export interface BridgeCommandInvocation {
  /** The live agent the command runs against; absent on a Host that cannot supply it. */
  agent?: BridgeCommandAgent
  /** Everything the human typed after the command name, verbatim. */
  rawInput?: string
  signal?: AbortSignal
}

/** The slice of a live agent a command reads. */
export interface BridgeCommandAgent extends BridgeAgentRef {
  inject(message: unknown): void
  steer(message: unknown): void
}

/** What a command handler returns to the composer. */
export interface BridgeCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** One slash-command registration. */
export interface BridgeCommandDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: BridgeCommandInvocation): Promise<BridgeCommandResult>
}

/** The Host's command registry. */
export interface BridgeCommandsService {
  register(definition: BridgeCommandDefinition): () => void
}

/** A logging sink; matches `ctx.logger.warn` after the prefix is baked in. */
export type BridgeLog = (message: string) => void
