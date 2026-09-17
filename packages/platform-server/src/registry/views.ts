import {
  readResultDescriptorSchema,
  viewDefinitionSchema,
  type ModuleReadOperation,
  type ReadResultDescriptor,
  type UiTarget,
  type ViewDefinition,
} from '@platform/contracts';

/**
 * Startup checks for what a module declares about its data and its screens.
 *
 * Each one turns a mistake that would otherwise surface as a quietly wrong
 * screen — a column that is always empty, a narrowing on a property the read
 * does not have, a filter suggestion no record can match — into a refusal to
 * start that names the module, the view and the field.
 */

const issuesText = (issues: Array<{ path: PropertyKey[]; message: string }>) =>
  issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');

/** A read's result descriptor must satisfy its schema. */
export function checkReadDescriptor(
  qualifiedName: string,
  op: ModuleReadOperation<never>,
): ReadResultDescriptor | undefined {
  if (!op.result) return undefined;
  const parsed = readResultDescriptorSchema.safeParse(op.result);
  if (!parsed.success) {
    throw new Error(
      `Operacja odczytu ${qualifiedName}: niepoprawny deskryptor wyniku — ${issuesText(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

/** A view definition must satisfy its schema. */
export function checkViewShape(moduleId: string, view: ViewDefinition): ViewDefinition {
  const parsed = viewDefinitionSchema.safeParse(view);
  if (!parsed.success) {
    throw new Error(
      `Modul ${moduleId}: niepoprawna definicja widoku ${String((view as { id?: unknown })?.id)} — ` +
        issuesText(parsed.error.issues),
    );
  }
  return parsed.data;
}

/**
 * The narrowing a view's target allows must be expressible over the view's
 * primary read.
 *
 * **Chosen over a unit test, deliberately.** The rule could be proven for the
 * example module by a test, but a module written later would get no such test.
 * Declaring the primary read on the view lets the platform check every module
 * at startup, without parsing the composition: the target's `collection` must
 * be the descriptor's, each narrowable field a declared field, and each
 * suggested value of an `enum` field one of the codes the descriptor labels.
 */
export function checkViewAgainstTarget(input: {
  moduleId: string;
  view: ViewDefinition;
  target: UiTarget | undefined;
  readOperation: (qualifiedName: string) => ModuleReadOperation<never> | undefined;
}): void {
  const { moduleId, view, target } = input;
  const where = `Modul ${moduleId}, widok ${view.id}`;

  if (view.primaryOperation) {
    const op = input.readOperation(view.primaryOperation);
    if (!op) {
      throw new Error(`${where}: primaryOperation ${view.primaryOperation} nie jest zarejestrowana operacja odczytu.`);
    }
    if (!op.result) {
      throw new Error(
        `${where}: operacja ${view.primaryOperation} nie deklaruje deskryptora wyniku (result), ` +
          'wiec nie moze zasilac widoku.',
      );
    }
  }

  const filter = target?.filter;
  if (!filter) return;

  if (!view.primaryOperation) {
    throw new Error(
      `${where}: cel ${target!.id} deklaruje zawezanie, wiec widok musi wskazac primaryOperation — ` +
        'odczyt, po ktorego polach sie zaweza.',
    );
  }
  const descriptor = input.readOperation(view.primaryOperation)!.result!;

  if ((descriptor.collection ?? null) !== filter.collection) {
    throw new Error(
      `${where}: cel zaweza kolekcje "${filter.collection}", a deskryptor ${view.primaryOperation} ` +
        `deklaruje ${descriptor.collection ? `"${descriptor.collection}"` : 'brak kolekcji'}.`,
    );
  }

  const declared = new Map(descriptor.fields.map((f) => [f.field, f]));
  const undeclared = filter.fields.map((f) => f.field).filter((f) => !declared.has(f));
  if (undeclared.length > 0) {
    throw new Error(
      `${where}: pola zawezania ${undeclared.join(', ')} nie sa zadeklarowane w deskryptorze ` +
        `${view.primaryOperation}. Zadeklarowane: ${[...declared.keys()].join(', ')}.`,
    );
  }

  for (const f of filter.fields) {
    const field = declared.get(f.field)!;
    if (field.type !== 'enum' || !field.values || !f.values) continue;
    const codes = new Set(field.values.map((v) => v.value));
    const stray = f.values.filter((v) => !codes.has(v));
    if (stray.length > 0) {
      throw new Error(
        `${where}: podpowiadane wartosci pola ${f.field} (${stray.join(', ')}) nie sa kodami ` +
          `zadeklarowanymi w deskryptorze (${[...codes].join(', ')}).`,
      );
    }
  }
}
