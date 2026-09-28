import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * Libraries a sandboxed run may import when it analyses an attached file.
 *
 * **Why a curated list and not "whatever is installed".** The run's code is
 * written by the model and executed in the sandbox, so what it can `import` is
 * part of the sandbox's boundary. Letting the workspace resolve against the
 * server's own `node_modules` would put the database driver and the Claude SDK
 * one `import` away from model-authored code — pointless risk for a spreadsheet
 * parser. Each entry here is linked into the run workspace individually.
 *
 * **Why the workspace needs them at all.** Network egress is denied, so a run
 * cannot fetch a parser at execution time. Anything the analysis needs has to be
 * present before the run starts.
 *
 * Images are deliberately absent from this list: the model reads an image with
 * its own `Read` tool, which handles PNG and JPEG natively. No library stands
 * between the model and the pixels, and none should.
 */
export interface ToolkitEntry {
  /** Import specifier the sandboxed code uses. */
  name: string;
  /** Real directory of the package, linked into the workspace. */
  dir: string;
  /** One line for the system prompt. */
  purpose: string;
}

const ALLOWED: Array<{ name: string; purpose: string }> = [
  {
    name: 'exceljs',
    purpose:
      'odczyt i zapis XLSX: wiele arkuszy, typy komorek, formuly jako {formula, result}; makra nie sa uruchamiane',
  },
];

/**
 * Resolves the allowed libraries against the package that actually declares
 * them, so this keeps working from a bundled `dist/server.js` where the working
 * directory is not the package root.
 */
export function analysisToolkit(): ToolkitEntry[] {
  const require_ = createRequire(resolve(import.meta.dirname, '../../package.json'));
  const entries: ToolkitEntry[] = [];
  for (const lib of ALLOWED) {
    try {
      // Resolve the manifest, not the entry point: a package whose `main`
      // points into a subdirectory would otherwise give the wrong root.
      entries.push({ ...lib, dir: dirname(require_.resolve(`${lib.name}/package.json`)) });
    } catch {
      /*
       * A missing library is reported by its absence from the prompt rather
       * than by a crash at boot. The run then simply has no spreadsheet parser,
       * and says so, instead of failing to start the whole application.
       */
    }
  }
  return entries;
}
