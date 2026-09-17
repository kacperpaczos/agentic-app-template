import { z } from 'zod';
import {
  AppError,
  RECORD_ACTION_SOURCE,
  parseFieldInput,
  type DataRecord,
  type ModuleToolDefinition,
  type ReadResultDescriptor,
  type RecordAction,
  type RecordActionFormFieldType,
} from '@platform/contracts';

/**
 * Record actions a read's descriptor declares: the startup check against the
 * module's tools, and building a tool's input from a record and a form.
 *
 * Performing one lives in `services/record-actions.ts`, next to the tool
 * execution it shares with the MCP server.
 */

/**
 * The input key through which a write tool takes its replay guard. A record
 * action always has an `operationId` of its own and hands it to a tool that
 * declares this key, so the tool's guard covers the call too; a module may not
 * map it to anything else.
 */
export const ACTION_OPERATION_ID_KEY = 'operationId';

/** JSON Schema types an input accepts; `any` when it names none (unknown, loose). */
function jsonTypesOf(schema: z.ZodType): Set<string> {
  const types = new Set<string>();
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return new Set(['any']);
  }
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const combined = ['anyOf', 'oneOf', 'allOf'].filter((k) => Array.isArray(n[k]));
    if (n.type === undefined && combined.length === 0) types.add('any');
    for (const t of Array.isArray(n.type) ? n.type : n.type === undefined ? [] : [n.type]) types.add(String(t));
    for (const k of combined) (n[k] as unknown[]).forEach(walk);
  };
  walk(json);
  return types;
}

/** Whether an input of these JSON types can take what a form field of this type produces. */
function acceptsFormValue(types: Set<string>, type: RecordActionFormFieldType): boolean {
  if (types.has('any')) return true;
  if (type === 'text') return types.has('string');
  if (type === 'number') return types.has('number');
  return types.has('integer') || types.has('number');
}

/**
 * Every record action of a read must name a `write` tool of the module that
 * owns the read, map only inputs that tool declares, supply every input it
 * requires, and feed form fields into inputs of a matching type.
 *
 * Refused at startup — naming the module, the read, the action and the
 * offending tool, input or field — because each of these mistakes would
 * otherwise surface only when a user presses the button: an action that
 * cannot work, or one that writes through another module's operation.
 */
export function checkRecordActions(input: {
  moduleId: string;
  operation: string;
  descriptor: ReadResultDescriptor;
  tools: readonly ModuleToolDefinition<never>[];
}): void {
  const { moduleId, operation, descriptor, tools } = input;
  const writeTools = tools.filter((t) => t.effect === 'write').map((t) => t.name);

  for (const action of descriptor.actions ?? []) {
    const where = `Modul ${moduleId}, operacja odczytu ${operation}, akcja ${action.id}`;
    const tool = tools.find((t) => t.name === action.tool);
    if (!tool) {
      throw new Error(
        `${where}: narzedzie ${action.tool} nie jest narzedziem modulu ${moduleId}. ` +
          `Akcja rekordu wskazuje narzedzie zapisu tego samego modulu: ${writeTools.join(', ') || 'brak'}.`,
      );
    }
    if (tool.effect !== 'write') {
      throw new Error(
        `${where}: narzedzie ${action.tool} jest narzedziem odczytu (effect: ${tool.effect}); ` +
          'akcja rekordu musi wskazywac narzedzie zapisu.',
      );
    }

    const shape = tool.inputSchema.shape as Record<string, z.ZodType>;
    const declared = Object.keys(shape);
    for (const entry of action.input) {
      if (entry.key === ACTION_OPERATION_ID_KEY) {
        throw new Error(
          `${where}: wejscia ${ACTION_OPERATION_ID_KEY} nie mapuje sie — platforma przekazuje narzedziu operationId akcji.`,
        );
      }
      const schema = shape[entry.key];
      if (!schema) {
        throw new Error(
          `${where}: wejscie ${entry.key} nie istnieje w schemacie narzedzia ${action.tool}. ` +
            `Dostepne: ${declared.join(', ')}.`,
        );
      }
      const [, kind, name] = RECORD_ACTION_SOURCE.exec(entry.from) ?? [];
      const formField = kind === 'form' ? action.form?.find((f) => f.key === name) : undefined;
      if (formField && !acceptsFormValue(jsonTypesOf(schema), formField.type)) {
        throw new Error(
          `${where}: pole formularza ${formField.key} (${formField.type}) nie pasuje do typu wejscia ` +
            `${entry.key} narzedzia ${action.tool} (${[...jsonTypesOf(schema)].join(' | ')}).`,
        );
      }
    }

    const mapped = new Set(action.input.map((e) => e.key));
    const missing = declared.filter(
      (key) => key !== ACTION_OPERATION_ID_KEY && !mapped.has(key) && !shape[key]!.safeParse(undefined).success,
    );
    if (missing.length > 0) {
      throw new Error(
        `${where}: narzedzie ${action.tool} wymaga wejscia ${missing.join(', ')}, ktorego akcja nie podaje.`,
      );
    }
  }
}

/**
 * Form values as the tool receives them, parsed by each field's declared type.
 * A value for a field the action does not have is refused by name, as is a
 * missing or unreadable one.
 */
export function parseActionValues(action: RecordAction, values: Record<string, string>): Map<string, string | number> {
  const form = action.form ?? [];
  const unknown = Object.keys(values).filter((key) => !form.some((f) => f.key === key));
  if (unknown.length > 0) {
    throw new AppError(
      'validation_failed',
      `Akcja ${action.id} nie ma pol ${unknown.join(', ')}. Pola formularza: ${form.map((f) => f.key).join(', ') || 'brak'}.`,
      { reason: 'invalid_value', unknownFields: unknown },
    );
  }
  return new Map(form.map((f) => [f.key, parseFieldInput(values[f.key] ?? '', f)]));
}

/** The tool's input: each mapped key from the re-read record or from the parsed form. */
export function buildActionInput(
  action: RecordAction,
  record: DataRecord,
  values: ReadonlyMap<string, string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of action.input) {
    const [, kind, name] = RECORD_ACTION_SOURCE.exec(entry.from)!;
    out[entry.key] = kind === 'record' ? record[name!] : values.get(name!);
  }
  return out;
}
