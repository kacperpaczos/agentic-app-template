import { z } from 'zod';

/**
 * Artifacts are platform-owned. Identity is the `id`; the title is a label and
 * never a key. Content lives in a versioned row plus (optionally) a managed file.
 */
export const artifactKindSchema = z.enum(['report', 'table', 'file', 'chart']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * `snapshot` freezes the payload it was created with — a historical report keeps
 * its numbers forever. `live` stores a query descriptor instead and re-reads the
 * backend on every open.
 */
export const artifactModeSchema = z.enum(['snapshot', 'live']);
export type ArtifactMode = z.infer<typeof artifactModeSchema>;

/**
 * Content of a `live` artifact: *which registered module query to re-run*, and
 * with what input. Never code, never SQL — see {@link ModuleReadOperation}.
 *
 * Stored as the artifact's versioned content, so the descriptor is versioned
 * exactly like a snapshot's frozen payload: `currentVersion` identifies the
 * definition, and the result is whatever that definition returns *now*.
 */
export const liveArtifactSourceSchema = z.object({
  /** Qualified operation name, `<moduleId>.<operation>`. */
  operation: z.string().min(1).max(200),
  /** Input for the operation; validated against the operation's own schema. */
  input: z.looseObject({}).optional(),
});
export type LiveArtifactSource = z.infer<typeof liveArtifactSourceSchema>;

/**
 * What a read of a live artifact resolved to.
 *
 * `state` is explicit so a stale or failed refresh can never be painted as
 * fresh data: the view renders an error, not the last good numbers.
 */
export const liveResolutionSchema = z.object({
  operation: z.string(),
  /** Definition version the result was produced from. */
  definitionVersion: z.number().int().positive(),
  state: z.enum(['fresh', 'failed', 'unavailable', 'forbidden']),
  /** When the query ran. Null when it did not run. */
  resolvedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type LiveResolution = z.infer<typeof liveResolutionSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  conversationId: z.string().nullable(),
  kind: artifactKindSchema,
  mode: artifactModeSchema,
  title: z.string(),
  /** Renderer key; matched against the registered artifact renderers. */
  rendererType: z.string(),
  currentVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArtifactMeta = z.infer<typeof artifactSchema>;

export const artifactVersionSchema = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  /** Frozen payload for `snapshot`; query descriptor for `live`. */
  content: z.unknown(),
  /** Managed file backing this version, if any. */
  fileId: z.string().nullable(),
  createdAt: z.string(),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

export const storedFileSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
  /** Opaque module tag, e.g. which business record the upload belongs to. */
  scopeKind: z.string().nullable(),
  scopeId: z.string().nullable(),
  /**
   * The file this one was produced from, when an agent modified an upload.
   *
   * A modified file is a new row, never an overwrite: the original stays
   * exactly as the user left it and the chain stays inspectable.
   */
  derivedFromFileId: z.string().nullable(),
  /** 1 for an upload; one more than its parent for a produced version. */
  version: z.number().int().positive(),
});
export type StoredFile = z.infer<typeof storedFileSchema>;

export const FILE_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxFilenameLength: 180,
  allowedMediaTypes: [
    'text/csv',
    'text/plain',
    'text/markdown',
    'application/json',
    'application/pdf',
    'image/png',
    'image/jpeg',
    // Spreadsheets. `.xlsx` only: the modern zipped format is what the
    // workspace parser reads and writes. Legacy `.xls` and macro-enabled
    // `.xlsm` are deliberately absent — see `FILE_ANALYSIS` below.
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ] as const,
} as const;

/**
 * What the platform promises about analysing an attached file — and what it
 * does not.
 *
 * Stated as data, and surfaced both in the agent's prompt and in the interface,
 * because the failure mode here is silent: a spreadsheet that opens and looks
 * right while a formula has been flattened into a stale number, or a chart has
 * quietly vanished, is worse than a refusal. Everything below is a limit of the
 * parser in the run workspace, not an opinion.
 */
export const FILE_ANALYSIS = {
  /** Read *and* written by a sandboxed run. */
  spreadsheet: {
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    reads: [
      'wszystkie arkusze skoroszytu, po nazwie i po kolejnosci',
      'typy komorek: liczba, tekst, data, wartosc logiczna, blad, komorka pusta',
      'formuly jako zapis formuly wraz z ostatnia wartoscia zapisana w pliku',
      'scalone komorki i zakres uzyty w arkuszu',
    ],
    /**
     * The honest half. A formula is stored next to the value Excel last wrote;
     * nothing here recalculates it, so a formula whose inputs changed carries a
     * stale result — and it must be reported as "zapisana wartosc", never as
     * "wynik".
     */
    limits: [
      'formuly NIE sa przeliczane — zapis formuly nie jest jej wynikiem',
      'formatowanie warunkowe, wykresy, obrazy i tabele przestawne nie sa zachowywane przy zapisie',
      'formatowanie komorek jest zachowywane tylko w zakresie, ktory czyta parser (format liczb, pogrubienie, obramowanie)',
      'makra nie sa uruchamiane; pliki .xlsm i .xls nie sa przyjmowane',
      'plik zapisany przez agenta jest NOWA wersja — oryginal pozostaje nienaruszony',
    ],
  },
  /** Read by the model itself, with no library in between. */
  image: {
    mediaTypes: ['image/png', 'image/jpeg'],
    reads: ['tresc obrazu odczytywana bezposrednio przez model'],
    limits: [
      'brak OCR poza tym, co model odczyta z obrazu',
      'obraz nie jest modyfikowany przez platforme',
    ],
  },
} as const;
