import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { claudeConfigDir } from './auth.ts';
import { realResolveFrom } from '../util/real-path.ts';

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
  /*
   * Wstępne zatwierdzenie **wymaga zadeklarowania, jak narzędzie podaje ścieżkę**.
   *
   * Odwrócenie tej samej komplementarności, o którą chodzi w regule pozytywnej:
   * lista narzędzi też jest zbiorem do wyliczenia, więc nie opieramy się na tym,
   * że ktoś pamiętał o obu listach naraz. Narzędzie dopisane do
   * `AUTO_APPROVED_FILE_TOOLS` bez wpisu w `PATH_ARGUMENTS` nie dostaje `auto`,
   * tylko trafia do zgody użytkownika — bo strażnik ścieżek nie umiałby go
   * sprawdzić, a cicha luka jest gorsza od pytania.
   */
  if ((AUTO_APPROVED_FILE_TOOLS as readonly string[]).includes(toolName)) {
    return PATH_ARGUMENTS[toolName] ? 'auto' : 'consent';
  }
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
/**
 * Argumenty, które są **wzorcem**, a nie ścieżką — i dlatego wymagają własnej reguły.
 *
 * `Glob{pattern:'../../**'}` nie jest ścieżką, więc `PATH_ARGUMENTS` go nie
 * obejmuje, a mimo to wychodzi poza katalog roboczy. Pełnego rozwinięcia wzorca
 * nie da się tu uczciwie odtworzyć (rozwija go narzędzie, nie my), więc reguła
 * jest węższa i mówi dokładnie tyle, ile umie sprawdzić: **wzorzec zawierający
 * człon `..` jest odrzucany**. Wzorzec bez `..` nie może wyjść w górę, a `path`
 * tych narzędzi jest osobno ograniczony do katalogu roboczego.
 *
 * `Grep.pattern` jest wyrażeniem nad **treścią**, nie nad ścieżką, więc go tu nie
 * ma; ograniczany jest jego `glob` i `path`.
 */
const PATTERN_ARGUMENTS: Record<string, readonly string[]> = {
  Glob: ['pattern'],
  Grep: ['glob'],
};

/** Czy wzorzec zawiera człon `..`, czyli próbuje wyjść w górę. */
function patternClimbsUp(pattern: string): boolean {
  return pattern.split(/[/\\]+/).some((part) => part === '..');
}

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
  /*
   * ## Dlaczego to NIE jest `sharedRealResolve(resolve(base, candidate))`
   *
   * Bo `path.resolve()` zwija `..` **leksykalnie**, zanim ktokolwiek dotknie
   * dowiązań — a jądro robi to w odwrotnej kolejności: najpierw podąża za
   * dowiązaniem, potem cofa się o `..`. Te dwie kolejności wskazują różne pliki,
   * i różnica nie jest teoretyczna:
   *
   *     <ws>/node_modules/exceljs/../podrzucony.txt
   *
   * leksykalnie zwija się do `<ws>/node_modules/podrzucony.txt` — wewnątrz
   * katalogu roboczego, więc strażnik przepuszczał. Jądro najpierw rozwijało
   * `node_modules/exceljs`, które jest **dowiązaniem do biblioteki poza
   * workspace** — tworzy je `createRunWorkspace`, więc materiał leży tam od
   * powstania katalogu — i dopiero potem cofało się o `..`. Plik powstawał poza
   * katalogiem roboczym. Bez powłoki i bez zgody użytkownika.
   *
   * Dlatego ścieżka jest przechodzona **komponent po komponencie**, w kolejności
   * jądra: każdy człon jest rozwijany fizycznie, zanim zostanie zinterpretowany
   * następny, a `..` cofa się od ścieżki **już rozwiniętej**.
   *
   * `util/real-path.ts` zostaje tam, gdzie był — jego wywołujący porównują
   * katalogi, nie ścieżki budowane przez model. Ta sama wada dotyczy jednak i
   * jego; zgłoszone w raporcie jako znalezisko poza zakresem tego pakietu.
   */
  return resolvePhysically(base, candidate);
}

/**
 * Rozwiązuje ścieżkę tak, jak zrobi to jądro: dowiązania przed `..`.
 *
 * Idzie komponent po komponencie od katalogu bazowego (albo od korzenia, gdy
 * ścieżka jest bezwzględna). Każdy istniejący człon jest rozwijany przez
 * `realpathSync`, więc dowiązanie jest rozwinięte **zanim** kolejny `..` je
 * przeskoczy. Człon, którego jeszcze nie ma, kończy rozwijanie fizyczne —
 * poniżej nieistniejącej ścieżki nie ma czego rozwijać, więc reszta jest
 * doklejana, a `..` traktowane leksykalnie, co jest wtedy równoważne.
 */
export function resolvePhysically(base: string, candidate: string): string {
  /*
   * Jedno przejście, w jednym miejscu (`util/real-path.ts`).
   *
   * Przez jedną rundę stało tutaj drugie, bo naprawiałem wadę tam, gdzie
   * patrzyłem. Dwie podobne funkcje rozwiązujące ścieżki to dokładnie ten układ,
   * w którym wadę naprawia się w jednej i zostawia w drugiej — co w tym
   * repozytorium właśnie się zdarzyło i kosztowało osobną rundę.
   */
  return realResolveFrom(base, candidate);
}

/**
 * Czy narzędzie zadeklarowało, **jak podaje ścieżkę**.
 *
 * Wystawione, bo to jest niezmiennik, którego pilnuje regresja: narzędzie na
 * liście wstępnie zatwierdzonych bez wpisu w `PATH_ARGUMENTS` jest luką —
 * strażnik ścieżek nie umie go sprawdzić, a `decideTool` odmawia mu wtedy
 * `auto`. Asercja nad tą funkcją oblewa **w chwili dopisania** takiego
 * narzędzia, czyli tam, gdzie popełnia się błąd.
 */
export function declaresPathArguments(toolName: string): boolean {
  return PATH_ARGUMENTS[toolName] !== undefined;
}

/** True when `candidate` is `dir` itself or sits inside it. */
function isInside(candidate: string, dir: string): boolean {
  const c = normalizeSlashes(candidate);
  const d = normalizeSlashes(dir).replace(/\/+$/, '');
  return c === d || c.startsWith(`${d}/`);
}

const normalizeSlashes = (p: string): string => p.replace(/\\/g, '/');

/**
 * Zwraca wejście narzędzia z **rozwiązanymi** ścieżkami, albo `null`.
 *
 * Powód jest ten sam, dla którego dwie rundy temu odrzuciłem dopisanie narzędzi
 * publikacji do `PATH_ARGUMENTS`: *sprawdzana byłaby inna ścieżka niż ta, którą
 * narzędzie otwiera*. Znałem tę zasadę i nie zastosowałem jej tutaj — strażnik
 * rozwiązywał ścieżkę u siebie, a narzędzie dostawało **surowy napis** i
 * rozwiązywało go po swojemu. Przepisanie wejścia likwiduje rozjazd u źródła:
 * narzędzie otwiera dokładnie ten plik, który został sprawdzony.
 *
 * SDK na to pozwala — `PreToolUseHookSpecificOutput.updatedInput` oraz
 * `canUseTool → { behavior: 'allow', updatedInput }` są w typach 0.3.270.
 */
export function resolvedPathInput(
  toolName: string,
  toolInput: unknown,
  resolvePath: (p: string) => string,
): Record<string, unknown> | null {
  const args = PATH_ARGUMENTS[toolName];
  if (!args) return null;
  const input = { ...((toolInput ?? {}) as Record<string, unknown>) };
  let changed = false;
  for (const key of args) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const abs = resolvePath(raw);
    if (abs !== raw) {
      input[key] = abs;
      changed = true;
    }
  }
  return changed ? input : null;
}

/**
 * Refuses a file tool that reaches **outside the run workspace** — in either
 * direction, read or write.
 *
 * ## Why this exists beside `protectedPathRefusal`, and why it is not a longer list
 *
 * The other rule names directories that must be unreachable. It closed four real
 * routes to the credential file, and it could not have closed the fifth: a real
 * model was given `Read` and handed back a canary from a directory nobody had
 * thought to list, then used `Write` to create a file on a path the shell had
 * been refused a second earlier. Twelve packages of tests never saw it.
 *
 * The shell is in a sandbox. **The SDK's own file tools are not** — the only
 * thing bounding them was a list of three directories, and a list of forbidden
 * places can never be complete. The set of places that must be unreachable has
 * to be enumerated; the set of places that may be reached is *one directory*,
 * and its complement needs no enumeration at all. So this rule is stated
 * positively: everything outside the run workspace is refused, and the question
 * "did we remember this directory?" stops being askable.
 *
 * This is the fourth time this repository has reached the same conclusion — the
 * path flags of the state scripts, the destructive operations, the script
 * directory scan, and now the file tools. Each time a guard counting from the
 * *argument* had a way around it, and each time what closed the class was a
 * guard counting from the *operation*, or a positive rule.
 *
 * ## What it deliberately does not allow
 *
 * The toolkit libraries are symlinked into the workspace's own `node_modules`,
 * and their real paths lie outside it — so reading a library's source through
 * `Read` is refused by this rule. That is a real behaviour change and it is the
 * intended one: it is exactly what the SDK's own
 * `permissions.blockReadsOutsideWorkingDirectories` does, model-authored code
 * imports those libraries rather than reading them, and an exception would put
 * a second list next to the one this rule exists to abolish.
 */
export function workspaceConfinementRefusal(
  toolName: string,
  toolInput: unknown,
  workspaceDir: string,
  resolvePath: (p: string) => string = (p) => realResolve(workspaceDir, p),
): string | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;

  /* Wzorce: własna, węższa reguła — patrz `PATTERN_ARGUMENTS`. */
  for (const key of PATTERN_ARGUMENTS[toolName] ?? []) {
    const raw = input[key];
    if (typeof raw === 'string' && patternClimbsUp(raw)) {
      return (
        `Wzorzec narzedzia ${toolName} wychodzi poza katalog roboczy tego uruchomienia ` +
        '(zawiera czlon ".."). Zostal odrzucony.'
      );
    }
  }

  const args = PATH_ARGUMENTS[toolName];
  if (!args) return null;
  const root = realResolve(workspaceDir, '.');
  for (const key of args) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const abs = resolvePath(raw);
    if (!isInside(abs, root)) {
      return (
        `Narzedzie ${toolName} moze siegac wylacznie katalogu roboczego tego uruchomienia. ` +
        'Sciezka wskazuje poza niego i zostala odrzucona, niezaleznie od zgody uzytkownika.'
      );
    }
  }
  return null;
}

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
  /**
   * Subtrees carved **out** of the guards above.
   *
   * There is exactly one, and leaving it out was a shipped regression: the run
   * workspace is `<dataDir>/workspaces/<runId>`, so it sits *inside* the
   * protected data directory. Without this exemption the data-directory guard
   * refused every legitimate file-tool call the agent made in its own
   * workspace — reading its own input, writing its own output — and no test
   * noticed, because until the reverse control demanded it, no test had the
   * agent touch a file inside the workspace at all.
   *
   * The exemption is safe precisely because paths are resolved for real before
   * this comparison: a symlink inside the workspace pointing at the credential
   * directory resolves *out* of the workspace, so it is not exempt and the
   * guards still fire.
   */
  exempt: readonly string[] = [],
): string | null {
  const args = PATH_ARGUMENTS[toolName];
  if (!args) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of args) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const abs = resolvePath(raw);
    if (exempt.some((dir) => dir && isInside(abs, dir))) continue;
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
