import { z } from 'zod';
import type { OpenUiComponentDeclaration } from '@platform/contracts';

/**
 * The control module's OpenUI Lang components, declared once for both halves.
 *
 * Same arrangement as the example module's `shared/openui-components.ts`, and
 * for the same reason: the browser renders the component, the server validates
 * every composition that names it, and a name or an argument order that differed
 * between the two would accept a composition the browser cannot render. Having
 * the control module do this too is the point — it is what proves the
 * declaration is a contract of the platform rather than a habit of the example.
 */

export const probeNoteListPropsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Ile notatek pokazac'),
});
export type ProbeNoteListProps = z.infer<typeof probeNoteListPropsSchema>;

export const PROBE_OPENUI_COMPONENTS = {
  ProbeNoteList: {
    name: 'ProbeNoteList',
    description: 'Lista notatek modulu testowego. Dane pobiera backend modulu; komponent nie przyjmuje ich tresci.',
    propsSchema: probeNoteListPropsSchema,
  },
} as const satisfies Record<string, OpenUiComponentDeclaration>;
