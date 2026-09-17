import { z } from 'zod';

/**
 * Props of this module's non-tabular OpenUI Lang components.
 *
 * React-free on purpose: a browser-only file could not be imported by the
 * server, and the server needs these same schemas to validate a composition
 * that calls `CaseHeader`, `CaseOfferSources` or `ItemProvenance` before it is
 * ever rendered (`ServerModule.openuiComponents`, wired up alongside the
 * startup validator). Every prop is a reference — an id the component looks
 * up itself — never a business value, so a composition naming one of these
 * components can never carry a stale copy of a price or a quantity.
 */

export const caseHeaderPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type CaseHeaderProps = z.infer<typeof caseHeaderPropsSchema>;

export const caseOfferSourcesPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type CaseOfferSourcesProps = z.infer<typeof caseOfferSourcesPropsSchema>;

export const itemProvenancePropsSchema = z.object({
  itemId: z.string().min(1).max(128).describe('Identyfikator pozycji oferty'),
});
export type ItemProvenanceProps = z.infer<typeof itemProvenancePropsSchema>;
