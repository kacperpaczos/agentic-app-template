/**
 * @platform/contracts
 *
 * Domain-agnostic contracts shared by the platform core, business modules and
 * the composition roots. This package must never know a single business noun
 * (supplier, offer, price ...). Everything here is generic plumbing.
 */
export * from './ids.ts';
export * from './errors.ts';
export * from './canvas.ts';
export * from './conversation.ts';
export * from './artifacts.ts';
export * from './agent.ts';
export * from './module.ts';
export * from './agui.ts';
export * from './ui.ts';
export * from './views.ts';
export * from './view-state.ts';
export * from './records.ts';
