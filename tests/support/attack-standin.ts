import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ModelAgentLike } from '@platform/server';
import type { ToolCallContext } from '@platform/contracts';

/**
 * Zastępnik modelu **dla prób ataku recenzenta** — osobny plik, żeby nie mieszać
 * się z dowodami autora (`model-standin.ts`).
 *
 * Różni się od zastępnika autora w dwóch miejscach i tylko w nich:
 *
 *  1. **Czyta `hookSpecificOutput.updatedInput`.** Zastępnik autora go ignoruje,
 *     więc całe twierdzenie „narzędzie otwiera dokładnie ten plik, który
 *     sprawdzono" nie jest w repo niczym sprawdzane. Tutaj tryb jest
 *     przełącznikiem (`honorUpdatedInput`), żeby dało się zmierzyć OBIE
 *     interpretacje: SDK, które przepisanie honoruje, i SDK, które go nie
 *     honoruje.
 *  2. **Wykonuje operację naprawdę** dla `Read`, `Write`, `Edit`, `Glob` i
 *     `Grep` — łącznie z prawdziwym rozwinięciem wzorca (`fs.globSync`), bo
 *     inaczej „wzorzec wyszedł poza workspace" byłoby zdaniem o napisie,
 *     a nie o systemie plików.
 *
 * Wszystko poza tym jest tą samą granicą adaptera: `sdkOptions`, `hooks`,
 * `toolContext` i `canUseTool` przychodzą od prawdziwego `AgentRuntime`.
 */

export type AtakKrok =
  /** Tworzy katalog wewnątrz workspace (albo pod ścieżką bezwzględną). */
  | { kind: 'mkdir'; path: string }
  /** Dowiązanie wewnątrz workspace — materiał, który w prawdziwym przebiegu leży tam od startu. */
  | { kind: 'symlink'; from: string; to: string }
  /** Usuwa dowiązanie/plik (do wyścigu). */
  | { kind: 'unlink'; path: string }
  | {
      kind: 'tool';
      name: string;
      input: Record<string, unknown>;
      subagent?: boolean;
      content?: string;
      /**
       * Narzędzie normalizuje ścieżkę **leksykalnie** przed otwarciem
       * (`path.resolve`) — zachowanie powszechne w narzędziach plikowych i
       * niezależne od tego, czy SDK honoruje `updatedInput`.
       */
      normalizeBeforeOpen?: boolean;
      /** Narzędzie rozwija `~` na `$HOME` przed otwarciem (częste zachowanie). */
      tildeBeforeOpen?: boolean;
      /**
       * Wyścig TOCTOU: podmienia dowiązanie **po** powrocie z hooka, a **przed**
       * otwarciem pliku. Dokładnie okno, które ma każdy strażnik sprawdzający
       * ścieżkę poza jądrem.
       */
      swapBeforeOpen?: { link: string; to: string };
    }
  /** Woła bramkę zgody (`canUseTool`) wprost — droga narzędzi spoza `allowedTools`. */
  | { kind: 'gate'; name: string; input: Record<string, unknown> }
  | { kind: 'text'; text: string };

export interface AtakProba {
  name: string;
  /** Czy hook `PreToolUse` odmówił. */
  denied: boolean;
  reason: string | null;
  /** Wejście, które hook kazał podstawić (albo `null`, gdy nie kazał). */
  updatedInput: Record<string, unknown> | null;
  /** Ścieżka/wzorzec, które zastępnik NAPRAWDĘ otworzył. */
  opened: string | null;
  /** Co operacja zwróciła (treść pliku, lista trafień globa, błąd). */
  outcome: string;
  /** Odpowiedź bramki `canUseTool`, gdy próba szła przez nią. */
  gate?: { behavior: string; message?: string; updatedInput?: Record<string, unknown> };
}

export interface AtakUchwyt {
  proby: AtakProba[];
  workspaceDir: string | null;
  dispose: () => void;
}

export const newAtakUchwyt = (): AtakUchwyt => ({ proby: [], workspaceDir: null, dispose: () => {} });

export interface AtakPlan {
  script: AtakKrok[];
  handle: AtakUchwyt;
  /**
   * `true` → zastępnik podstawia `updatedInput` (tak zachowa się SDK, jeśli
   * naprawdę honoruje przepisanie). `false` → otwiera surowy napis modelu,
   * dokładnie jak zastępnik autora.
   */
  honorUpdatedInput?: boolean;
}

/** Sklejenie NAPISÓW, nie `join` — normalizacja zniszczyłaby kształt ataku. */
const expand = (v: unknown, ws: string): unknown =>
  typeof v === 'string' && v.startsWith('$ws/') ? `${ws}/${v.slice('$ws/'.length)}` : v;

export function atakujacyAgent(plans: Map<string, AtakPlan>): ModelAgentLike {
  const play = async (prompt: string, options: any) => {
    const plan = plans.get(prompt);
    if (!plan) throw new Error(`atak: brak scenariusza dla "${prompt}"`);
    const { script, handle } = plan;
    const honor = plan.honorUpdatedInput !== false;
    const hooks = options?.sdkOptions?.hooks ?? {};
    const ctx: ToolCallContext | undefined = options?.toolContext;
    const ws = ctx?.workspaceDir ?? '';
    handle.workspaceDir = ws;

    const firePreToolUse = async (
      payload: Record<string, unknown>,
    ): Promise<{ refusal: string | null; updatedInput: Record<string, unknown> | null }> => {
      let refusal: string | null = null;
      let updatedInput: Record<string, unknown> | null = null;
      for (const group of hooks.PreToolUse ?? []) {
        for (const hook of group.hooks ?? []) {
          const answer = (await hook({ hook_event_name: 'PreToolUse', ...payload })) as
            | {
                hookSpecificOutput?: {
                  permissionDecision?: string;
                  permissionDecisionReason?: string;
                  updatedInput?: Record<string, unknown>;
                };
              }
            | undefined;
          const specific = answer?.hookSpecificOutput;
          if (specific?.permissionDecision === 'deny') {
            refusal = specific.permissionDecisionReason ?? 'odmowa hooka PreToolUse';
          }
          if (specific?.updatedInput) updatedInput = specific.updatedInput;
        }
      }
      return { refusal, updatedInput };
    };

    const steps = async function* (): AsyncGenerator<Record<string, unknown>> {
      let seq = 0;
      for (const step of script) {
        if (step.kind === 'mkdir') {
          mkdirSync(step.path.startsWith('/') ? step.path : join(ws, step.path), { recursive: true });
          continue;
        }
        if (step.kind === 'symlink') {
          const from = String(expand(step.from, ws));
          const target = step.to.startsWith('/') ? step.to : join(ws, String(expand(step.to, ws)));
          mkdirSync(dirname(target), { recursive: true });
          try {
            symlinkSync(from, target);
          } catch {
            /* juz jest */
          }
          continue;
        }
        if (step.kind === 'unlink') {
          const target = step.path.startsWith('/') ? step.path : join(ws, step.path);
          try {
            unlinkSync(target);
          } catch {
            /* nie istnieje — nieistotne dla próby */
          }
          continue;
        }
        if (step.kind === 'gate') {
          const canUseTool = options?.sdkOptions?.canUseTool as
            | ((n: string, i: Record<string, unknown>) => Promise<any>)
            | undefined;
          if (!canUseTool) throw new Error('atak: brak bramki canUseTool');
          const raw = Object.fromEntries(Object.entries(step.input).map(([k, v]) => [k, expand(v, ws)]));
          const decision = await canUseTool(step.name, raw);
          const proba: AtakProba = {
            name: step.name,
            denied: decision?.behavior === 'deny',
            reason: decision?.message ?? null,
            updatedInput: decision?.updatedInput ?? null,
            opened: null,
            outcome: JSON.stringify(decision ?? null),
            gate: decision,
          };
          handle.proby.push(proba);
          if (decision?.behavior === 'allow') {
            const target = String(
              (decision.updatedInput ?? raw).file_path ?? (decision.updatedInput ?? raw).path ?? '',
            );
            proba.opened = target;
            try {
              writeFileSync(target, 'TRESC-PRZEZ-BRAMKE');
              proba.outcome = `zapisano ${target}`;
            } catch (err) {
              proba.outcome = `blad: ${(err as Error).message}`;
            }
          }
          yield { type: 'text-delta', payload: { text: `[bramka:${step.name}] ${proba.outcome} ` } };
          continue;
        }
        if (step.kind === 'text') {
          yield { type: 'text-delta', payload: { text: step.text } };
          continue;
        }

        seq += 1;
        const raw = Object.fromEntries(Object.entries(step.input).map(([k, v]) => [k, expand(v, ws)]));
        const { refusal, updatedInput } = await firePreToolUse({
          tool_use_id: `atak_${seq}`,
          tool_name: step.name,
          tool_input: raw,
          ...(step.subagent ? { agent_id: 'agent_podwykonawca' } : {}),
        });

        const proba: AtakProba = {
          name: step.name,
          denied: refusal !== null,
          reason: refusal,
          updatedInput,
          opened: null,
          outcome: '',
        };
        handle.proby.push(proba);
        if (refusal !== null) {
          yield { type: 'text-delta', payload: { text: `[${step.name}] odmowa ` } };
          continue;
        }

        const effective = honor && updatedInput ? { ...raw, ...updatedInput } : raw;

        /* Wyścig: dowiązanie podmienione PO sprawdzeniu, PRZED otwarciem. */
        if (step.swapBeforeOpen) {
          const link = step.swapBeforeOpen.link.startsWith('/')
            ? step.swapBeforeOpen.link
            : join(ws, step.swapBeforeOpen.link);
          try {
            unlinkSync(link);
          } catch {
            /* brak — trudno */
          }
          mkdirSync(dirname(link), { recursive: true });
          symlinkSync(String(expand(step.swapBeforeOpen.to, ws)), link);
        }

        try {
          if (step.name === 'Glob') {
            const pattern = String(effective.pattern ?? '**/*');
            const cwd = String(effective.path ?? ws);
            proba.opened = `${cwd}::${pattern}`;
            const hits = globSync(pattern, { cwd });
            proba.outcome = JSON.stringify(hits.slice(0, 60));
          } else if (step.name === 'Grep') {
            const cwd = String(effective.path ?? ws);
            const g = String(effective.glob ?? '**/*');
            proba.opened = `${cwd}::${g}`;
            const hits = globSync(g, { cwd });
            const re = new RegExp(String(effective.pattern ?? '.'));
            const found: string[] = [];
            for (const hit of hits) {
              const abs = hit.startsWith('/') ? hit : join(cwd, hit);
              try {
                const body = readFileSync(abs, 'utf8');
                if (re.test(body)) found.push(`${hit}:${body.slice(0, 120)}`);
              } catch {
                /* katalog albo brak dostępu */
              }
            }
            proba.outcome = JSON.stringify(found.slice(0, 8));
          } else {
            let rawTarget = String(effective.file_path ?? effective.path ?? '');
            if (step.tildeBeforeOpen && rawTarget.startsWith('~/')) {
              rawTarget = `${process.env.HOME ?? ''}/${rawTarget.slice(2)}`;
            }
            const target = step.normalizeBeforeOpen ? resolve(rawTarget) : rawTarget;
            proba.opened = target;
            if (step.name === 'Write' || step.name === 'Edit') {
              writeFileSync(target, step.content ?? 'TRESC-ATAKU');
              proba.outcome = `zapisano ${target}`;
            } else {
              proba.outcome = readFileSync(target, 'utf8');
            }
          }
        } catch (err) {
          proba.outcome = `blad: ${(err as Error).message}`;
        }
        yield { type: 'text-delta', payload: { text: `[${step.name}] ${proba.outcome} ` } };
      }
    };

    return { fullStream: steps() };
  };

  const promptOf = (input: unknown): string =>
    typeof input === 'string' ? input : String((input as { message?: unknown })?.message ?? '');

  return {
    stream: (p: unknown, o: unknown) => play(promptOf(p), o),
    resumeStream: (i: { message: string; sessionId: string }, o: unknown) => play(promptOf(i), o),
  } as ModelAgentLike;
}

/** Pomocnik prób: prawdziwa ścieżka, jaką zobaczy jądro. */
export const realnie = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
