import { mkdirSync, rmSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { AppError } from '@platform/contracts';
import type { ToolkitEntry } from './toolkit.ts';

export interface RunWorkspace {
  dir: string;
  inputDir: string;
  outputDir: string;
  /** Libraries linked into the workspace and importable by sandboxed code. */
  toolkit: ToolkitEntry[];
  dispose: () => void;
}

/**
 * Per-run scratch directory handed to the sandboxed execution.
 *
 * `input/`  — files the user attached, copied in by the backend.
 * `output/` — where the agent is told to write results. Only files found here
 *             can be published as artifacts, and publication copies the bytes
 *             into the managed store, so the result survives the cleanup below.
 */
export function createRunWorkspace(
  workspacesRoot: string,
  runId: string,
  toolkit: ToolkitEntry[] = [],
): RunWorkspace {
  const dir = resolve(workspacesRoot, runId);
  const inputDir = resolve(dir, 'input');
  const outputDir = resolve(dir, 'output');
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  /*
   * Analysis libraries, linked one by one into the workspace's own
   * `node_modules`.
   *
   * Node resolves an import by walking up from the script's directory, so
   * without this the workspace would fall through to the server's own
   * `node_modules` — putting the database driver and the Claude SDK within
   * reach of model-authored code. Linking named packages into the workspace
   * makes the set of importable libraries an explicit, reviewable list
   * (`toolkit.ts`) instead of a side effect of where the directory happens to
   * sit. Symlinks, not copies: a spreadsheet parser is tens of megabytes and
   * this runs once per turn.
   */
  const linked: ToolkitEntry[] = [];
  if (toolkit.length > 0) {
    const modulesDir = resolve(dir, 'node_modules');
    mkdirSync(modulesDir, { recursive: true });
    for (const entry of toolkit) {
      const target = resolve(modulesDir, entry.name);
      try {
        if (!existsSync(target)) symlinkSync(entry.dir, target, 'dir');
        linked.push(entry);
      } catch {
        // A library that cannot be linked is simply not offered to the run.
      }
    }
  }

  return {
    dir,
    inputDir,
    outputDir,
    toolkit: linked,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Rejects any path that would escape the run workspace. */
export function resolveInWorkspace(workspaceDir: string, relative: string): string {
  const abs = resolve(workspaceDir, relative);
  if (abs !== workspaceDir && !abs.startsWith(workspaceDir + sep)) {
    throw new AppError('sandbox_denied', 'Sciezka wychodzi poza workspace uruchomienia.', {
      requested: relative,
    });
  }
  return abs;
}

export function listWorkspaceOutputs(workspaceDir: string): Array<{ path: string; bytes: number }> {
  const out = resolve(workspaceDir, 'output');
  if (!existsSync(out)) return [];
  const acc: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) acc.push({ path: rel, bytes: statSync(abs).size });
    }
  };
  walk(out, '');
  return acc;
}

/**
 * Sandbox configuration passed to the Claude Agent SDK.
 *
 * `filesystem.allowWrite` is limited to the run workspace, network egress is
 * denied outright (`allowedDomains: []` + `strictAllowlist`), and reads of the
 * application's own data directory are denied so a sandboxed command cannot
 * reach the SQLite file and bypass the domain services.
 */
export function sandboxSettings(input: {
  workspaceDir: string;
  dataDir: string;
}): Record<string, unknown> {
  return {
    enabled: true,
    // A missing sandbox dependency must fail loudly rather than silently
    // downgrade to unsandboxed execution.
    failIfUnavailable: true,
    // MUST stay false. This setting is independent of `allowedTools` and, when
    // left at its default of true, auto-approves every sandboxed shell command
    // *before* `canUseTool` is consulted — which silently turns the consent gate
    // into dead code. Observed: a run executed `echo` with no prompt at all.
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    filesystem: {
      allowWrite: [input.workspaceDir],
      denyWrite: [input.dataDir],
      denyRead: [input.dataDir],
    },
  };
}
