import { z } from 'zod';
import type { CardComponentDescriptor } from '@platform/contracts';

/**
 * Domain-agnostic cards every installation has. A module contributes its own on
 * top; the platform never ships a business card.
 */
export function platformCardComponents(): CardComponentDescriptor[] {
  return [
    {
      id: 'platform.markdown',
      description: 'Blok tekstu w formacie Markdown. Notatki, wyjasnienia, podsumowania opisowe.',
      usage: 'props: { markdown: string }',
      propsSchema: z.object({ markdown: z.string().max(20_000) }),
    },
    {
      id: 'platform.artifact',
      description: 'Podglad zapisanego artefaktu (raport, plik do pobrania) po jego identyfikatorze.',
      usage: 'props: { artifactId: string }',
      propsSchema: z.object({ artifactId: z.string().max(128) }),
    },
    {
      id: 'platform.files',
      description: 'Lista plikow zrodlowych powiazanych z danym zakresem.',
      usage: 'props: { scopeKind: string, scopeId: string }',
      propsSchema: z.object({
        scopeKind: z.string().max(80),
        scopeId: z.string().max(128),
      }),
    },
  ];
}
