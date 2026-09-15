# 1. Money is integer minor units, never floating point

Accepted.

## Context

The service adds and subtracts money constantly: every reservation and release
changes a running total that a program's whole credit limit depends on. Binary
floating point cannot represent decimal fractions exactly, so sums built from
`number` drift. A program with a $10,000,000 limit and hundreds of thousands of
movements will eventually disagree with its own ledger.

JSON numbers are the same hazard on the wire: a client parsing `10000000.005`
gets whatever its runtime rounds to.

## Decision

Amounts are held as an integer count of the currency's minor units in a
`bigint`, wrapped in a `Money` value object that also carries the currency.
`bigint` rather than `number` because a large limit in a zero-exponent currency
approaches `Number.MAX_SAFE_INTEGER`.

Arithmetic between different currencies throws. Crossing currencies is the FX
layer's job, and it records the rate it used.

On the wire, amounts are `{ "amount": "10000000.00", "currency": "USD" }` —
decimal strings, never JSON numbers. An amount with more decimal places than
the currency supports is rejected rather than rounded.

## Consequences

Every addition and subtraction is exact, and a currency mismatch is a type-level
mistake rather than a silent coercion.

The cost is ceremony: `Money.fromDecimal` at every boundary, a TypeORM
transformer on every money column, and clients cannot treat amounts as numbers
without converting. That last point is a feature.
