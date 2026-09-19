import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { claudeConfigDir } from './auth.ts';

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

/* ------------------------- protected directories --------------------------- */

/**
 * File tools whose arguments name a path, by the argument that does.
 *
 * Listed rather than guessed: a rule that scanned *every* string of the input
 * for a directory name would refuse a call that merely mentioned the path in a
 * search pattern, and would still miss a tool whose path argument is spelled
 * differently. `Grep` and `Glob` search a directory, so `path` is where they
 * are pointed; the editors take `file_path`.
 *
 * ## Why the application's own publishing tools are deliberately absent
 *
 * `artifact_publish_file` and `files_publish_version` also take a `path`, and a
 * symlink under `output/` once let one of them publish the credential file as a
 * downloadable artifact. They are still **not** listed here, and the reason is
 * that adding them would be weaker *and* misleading:
 *
 *  - **`resolveInWorkspace` is strictly stronger.** It confines them to the run
 *    workspace — it refuses *everything* outside it, not merely the two guarded
 *    directories — and since it resolves real paths, the symlink route is closed
 *    at the point where the file is actually opened.
 *  - **The path checked here would not be the path used.** Both handlers force
 *    the `output/` prefix (`input.path.startsWith('output/') ? … : 'output/' + …`)
 *    before resolving. A hook reading the raw `path` would therefore evaluate a
 *    *different* string than the one the tool opens — a check that is green for
 *    the wrong reason, which is worse than no check at all.
 *  - **An absolute path is already inert.** That same forced prefix turns
 *    `/home/…/.claude/.credentials.json` into `<workspace>/output//home/…`, which
 *    exists nowhere; the call fails as `not_found` without reading anything.
 *
 * This list is for tools that legitimately address absolute paths anywhere on
 * the disk — the SDK's own file tools. A tool confined to one directory is
 * guarded by the confinement, at the chokepoint, not by a second list that would
 * have to be kept in step with the first.
 */
const PATH_ARGUMENTS: Record<string, readonly string[]> = {
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob: ['path'],
  Grep: ['path'],
};

/**
 * Directories and files a run may never open, given the application's data directory.
 *
 * One list, built in one place, because it is used by three mechanisms and a
 * copy that drifted would silently open a hole in whichever one kept the old
 * list. `claudeConfigDir()` is read per call, not at import: a test that
 * redirects `CLAUDE_CONFIG_DIR` must redirect the protection with it.
 *
 * `<configDir>.json` is protected as well as the directory. `~/.claude.json`
 * sits **beside** `~/.claude`, not inside it, so a rule about the directory
 * misses it entirely. It holds no token — its field names were checked — but it
 * does hold account and project data, which is the same class of thing the
 * session probe goes out of its way never to copy.
 */
export function protectedDirsFor(
  dataDir: string,
  configDir: string = claudeConfigDir(),
): Array<{ dir: string; what: string }> {
  return [
    { dir: dataDir, what: 'danych aplikacji' },
    { dir: configDir, what: 'poswiadczen Claude' },
    { dir: `${configDir}.json`, what: 'konfiguracji Claude' },
  ];
}

/**
 * Resolves a path the way the filesystem would, symbolic links included.
 *
 * `path.resolve` alone answers a question about *text*: it flattens `..` and
 * makes the path absolute, and that is all. A symlink planted inside the run
 * workspace and pointing at the credential directory therefore resolves to a
 * path under the workspace and walks straight through a prefix comparison —
 * the check says "this is inside the workspace" and the open() says otherwise.
 *
 * `realpathSync` answers the question about the filesystem, but throws on a
 * path that does not exist yet, which is the normal case for `Write`. So the
 * nearest existing ancestor is resolved and the remainder appended: an existing
 * symlink anywhere along the path is followed, and a not-yet-created leaf is
 * still judged by where it would really land.
 */
export function realResolve(base: string, candidate: string): string {
  let abs = resolve(base, candidate);
  let rest = '';
  for (let i = 0; i < 64; i += 1) {
    try {
      return rest ? resolve(realpathSync(abs), rest) : realpathSync(abs);
    } catch {
      const parent = dirname(abs);
      if (parent === abs) return resolve(base, candidate);
      rest = rest ? `${basename(abs)}/${rest}` : basename(abs);
      abs = parent;
    }
  }
  return resolve(base, candidate);
}

/** True when `candidate` is `dir` itself or sits inside it. */
function isInside(candidate: string, dir: string): boolean {
  const c = normalizeSlashes(candidate);
  const d = normalizeSlashes(dir).replace(/\/+$/, '');
  return c === d || c.startsWith(`${d}/`);
}

const normalizeSlashes = (p: string): string => p.replace(/\\/g, '/');

/**
 * Refuses a file tool aimed at a directory the application protects.
 *
 * Two directories qualify and for the same reason: reaching either one would
 * let a run go around the platform instead of through it. The application's
 * data directory holds the SQLite file, so reading it bypasses the domain
 * services and every owner check in them. The Claude configuration directory
 * holds `.credentials.json`, so reading it hands the run the subscription's
 * access token — which it could then write into an answer, a file in its
 * workspace or a published artifact. L8.7 says credentials stay out of
 * artifacts and logs; this is the rule that makes that true of the agent as
 * well as of the application's own code.
 *
 * Returns the refusal reason, or `null` when the call is not aimed at one of
 * them. Deliberately not a boolean: the reason is shown to the user and given
 * to the model, so it belongs with the decision.
 *
 * Paths are compared after resolution by the caller, so `../../../.claude` is
 * the same string as an absolute one. A relative path that stays inside the
 * run workspace can never resolve into either directory.
 */
export function protectedPathRefusal(
  toolName: string,
  toolInput: unknown,
  protectedDirs: ReadonlyArray<{ dir: string; what: string }>,
  resolvePath: (p: string) => string = (p) => p,
): string | null {
  const args = PATH_ARGUMENTS[toolName];
  if (!args) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of args) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const abs = resolvePath(raw);
    for (const guard of protectedDirs) {
      if (!guard.dir) continue;
      if (isInside(abs, guard.dir)) {
        return (
          `Narzedzie ${toolName} nie ma dostepu do katalogu ${guard.what}. ` +
          'Ta sciezka jest zablokowana przez aplikacje, niezaleznie od zgody uzytkownika.'
        );
      }
    }
  }
  return null;
}
