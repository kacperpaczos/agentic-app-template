import { z } from 'zod';
import { readWindowInput } from '@platform/contracts';
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
  /**
   * The version being replaced. Required on both doors.
   *
   * It used to be optional here, and `ProcurementService` filled the gap with
   * the row's current version — a comparison of a value with itself. So the
   * HTTP door accepted a write that named no version and overwrote whatever
   * had happened since the caller read the row, while the agent's door (which
   * extends this schema) demanded one. One rule, one place: a write that does
   * not say what it is replacing is refused before it reaches the service.
   */
  expectedVersion: z.number().int().nonnegative(),
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
  ...readWindowInput,
  /** The window inside one offer; separate, so an item past the limit stays reachable. */
  itemsLimit: readWindowInput.limit.describe('Ile pozycji zwrocic w kazdej ofercie'),
  itemsOffset: readWindowInput.offset.describe('Od ktorej pozycji zaczac w kazdej ofercie'),
});

/**
 * `operationId` is required, and is the only one of the write inputs here for
 * which that is true.
 *
 * Saving a comparison creates a durable artifact. A repeat with no key is
 * indistinguishable from a first call, so it makes a second artifact — which is
 * what a reconnected agent's retry did. Setting a quantity or a weight lands on
 * an absolute value and a repeat changes nothing; creating a record does not
 * have that property, so the caller has to name the operation.
 */
export const saveComparisonInput = z.object({
  caseId: z.string().min(1),
  title: z.string().max(200).optional(),
  operationId: z.string().min(8).max(200),
});
