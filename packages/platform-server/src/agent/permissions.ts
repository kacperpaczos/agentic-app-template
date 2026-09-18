/**
 * The permission matrix for the Claude Agent SDK's **built-in** tools.
 *
 * Three categories, and the third is the one that was missing: a tool may be
 * automatically allowed, may require the user's decision, or may be *forbidden*
 * — never offered to the model at all. Without the third category every tool the
 * platform did not pre-approve ended up in the same place, the consent prompt,
 * so "the user could say yes" was the only thing standing between a sandboxed
 * run and the open internet: `WebFetch` and `WebSearch` execute inside the SDK
 * process, **not** inside the shell sandbox, so `network.allowedDomains: []`
 * does not constrain them at all.
 *
 * ## The order the SDK actually applies, and why the categories map onto it
 *
 * Three SDK mechanisms decide whether a tool call happens, and they do not fire
 * in the order the names suggest:
 *
 *  1. `disallowedTools` — a deny rule. The SDK's own documentation of the option
 *     states it removes the tool from the model's context and that it "cannot be
 *     used, even if it would otherwise be allowed", which is why {@link FORBIDDEN}
 *     goes here and not into the gate: a rule the model never sees cannot be
 *     talked around, and it also covers harness-internal calls that never go
 *     through a name lookup.
 *  2. `allowedTools` — an *allow rule*. A bare tool name here auto-approves the
 *     call **before** `canUseTool` is consulted; the SDK reports this as
 *     `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Listing `Bash` there would therefore
 *     have made the consent gate dead code, which is why {@link CONSENT_REQUIRED}
 *     is deliberately absent from the list.
 *  3. `canUseTool` — the interactive gate, reached only by a call that rules 1
 *     and 2 did not already decide.
 *
 * `sandbox.autoAllowBashIfSandboxed` is a fourth mechanism and is independent of
 * all three: left at its default of `true` it auto-approves sandboxed shell
 * commands ahead of `canUseTool`. It is pinned to `false` in `sandbox.ts`.
 *
 * **What this file does not prove.** That the SDK really applies 1–3 in this
 * order is a statement about someone else's code: the ordering can only be
 * observed on a real model turn, and this repository's regression does not spend
 * one. The matrix is therefore written as *defence in depth* — the gate refuses
 * a forbidden tool on its own (see `AgentRuntime.#makeCanUseTool`), so the
 * application's policy holds even if a future SDK version stopped honouring
 * `disallowedTools`. See `docs/ACCEPTANCE.md`, L11.12.
 */

/**
 * Read and write inside the run workspace, pre-approved.
 *
 * The sandbox — not this list — is what confines them: `filesystem.allowWrite`
 * is the workspace and `denyRead` covers the application's data directory.
 */
export const AUTO_APPROVED_FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

/**
 * Reaches the shell, so it reaches the user first.
 *
 * Present for documentation and for the tests: the mechanism that sends `Bash`
 * to the gate is its *absence* from `allowedTools`, which is exactly the kind of
 * fact that is silently undone by an edit somewhere else.
 */
export const CONSENT_REQUIRED_TOOLS = ['Bash'] as const;

/**
 * Never offered, never asked about.
 *
 * Both reach the network from inside the SDK process, where the shell sandbox's
 * `allowedDomains: []` has no effect. A platform whose whole isolation story is
 * "the run has no network" cannot leave the decision to a prompt.
 */
export const FORBIDDEN_TOOLS = ['WebFetch', 'WebSearch'] as const;

export type ToolDecision = 'auto' | 'consent' | 'forbidden';

/**
 * The matrix as one object, so a reader (and a test) sees all three categories
 * together instead of inferring the third from the absence of the other two.
 */
export const TOOL_PERMISSION_MATRIX = {
  auto: AUTO_APPROVED_FILE_TOOLS,
  consent: CONSENT_REQUIRED_TOOLS,
  forbidden: FORBIDDEN_TOOLS,
} as const;

/**
 * What the platform does with a tool call, by name.
 *
 * `mcpToolNames` are the application's own tools: they are the backend's
 * operations, already bounded by the domain services and the owner, so they are
 * automatic. Anything unrecognised is `consent` — the default is the cautious
 * one, so a tool added by a future SDK version reaches the user rather than
 * running unannounced.
 */
export function decideTool(toolName: string, mcpToolNames: readonly string[]): ToolDecision {
  if ((FORBIDDEN_TOOLS as readonly string[]).includes(toolName)) return 'forbidden';
  if (mcpToolNames.includes(toolName)) return 'auto';
  if ((AUTO_APPROVED_FILE_TOOLS as readonly string[]).includes(toolName)) return 'auto';
  return 'consent';
}

/** Message the gate refuses a forbidden tool with. Stated as policy, not as an error. */
export const forbiddenToolMessage = (toolName: string): string =>
  `Narzedzie ${toolName} jest zabronione w tej aplikacji (dostep do sieci poza sandboxem). ` +
  'Uzytkownik nie jest o nie pytany.';
