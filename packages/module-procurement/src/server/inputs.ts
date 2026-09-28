import { z } from 'zod';
import { unitSchema } from '../shared/index.ts';

/**
 * Input schemas shared by the MCP tools and the HTTP routes.
 *
 * Schemas describe *shape*; they deliberately do not encode business rules.
 * "A price cannot be negative" lives in `ProcurementService`, so both entry
 * points fail the same way with the same error code — see the contract test
 * "narzedzie MCP i endpoint HTTP prowadza do tej samej reguly".
 */
export const updateOfferItemInput = z.object({
  itemId: z.string().min(1),
  quantity: z.number().finite().optional(),
  unitPrice: z.number().finite().nullable().optional(),
  unit: unitSchema.optional(),
  note: z.string().max(500).nullable().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  operationId: z.string().min(8).max(200).optional(),
});
export type UpdateOfferItemInput = z.infer<typeof updateOfferItemInput>;

export const caseIdInput = z.object({ caseId: z.string().min(1) });

export const criteriaWeightsInput = z.object({
  caseId: z.string().min(1),
  weights: z
    .array(
      z.object({
        key: z.enum(['total_cost', 'delivery_days', 'validity_days', 'completeness']),
        weight: z.number().int().min(0).max(100),
      }),
    )
    .min(1),
});

/** `.optional()` rather than `.default()`: a defaulted MCP field reads as required. */
export const searchInput = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(50).optional(),
});

export const listOffersInput = z.object({
  caseId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

export const saveComparisonInput = z.object({
  caseId: z.string().min(1),
  title: z.string().max(200).optional(),
  operationId: z.string().min(8).max(200).optional(),
});
