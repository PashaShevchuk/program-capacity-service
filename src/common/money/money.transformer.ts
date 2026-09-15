import { type ValueTransformer } from 'typeorm';

/**
 * node-postgres returns `bigint` as a string to avoid precision loss.
 * This maps it to a real `bigint` so the domain never handles stringly-typed money.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value?: bigint | null): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value?: string | number | null): bigint | null =>
    value === null || value === undefined ? null : BigInt(value),
};

/** Keeps `numeric` columns (FX rates) as strings; `Decimal` does the arithmetic. */
export const numericStringTransformer: ValueTransformer = {
  to: (value?: string | null): string | null => value ?? null,
  from: (value?: string | null): string | null => value ?? null,
};
