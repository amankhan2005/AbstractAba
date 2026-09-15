/**
 * The design-token contract for the API. The single source of truth lives in the
 * shared package (packages/design-tokens, published as @aba1on1/schemas) so the
 * server's theme resolution and the web client's rendering can never disagree.
 * This module re-exports it, keeping every in-module import path stable while
 * eliminating a second copy of the contract.
 */
export * from '@aba1on1/schemas';
