# 3. The FX rate is frozen when the reservation is made

Accepted.

## Context

A program is denominated in one currency and its invoices may be in others. A
EUR invoice on a USD program consumes some amount of USD capacity, which means
a conversion.

The obvious implementation converts on the way in and converts again on the way
out. That is wrong. Rates move. If EUR/USD is 1.085 at approval and 1.10 at
repayment, releasing at the new rate returns more capacity than was taken, and
the program has quietly grown. The reverse leaves it permanently short. Neither
shows up immediately; both surface much later as an unexplainable discrepancy.

## Decision

Convert once, at reservation time. Store on the reservation:

- the invoice amount in its own currency,
- the amount charged against capacity, in the program's currency,
- the rate used, its source and its effective timestamp.

Release and cancel return the stored program-currency amount. They never
convert.

Rates are served through an `ExchangeRateProvider` port. The bundled adapter
reads `fx_rates`, a local record of the treasury rate feed, and looks rates up
point-in-time so an old reservation stays reproducible. A missing pair is an
error, not a fallback.

## Consequences

Capacity is exact regardless of what rates do afterwards, and every reservation
carries the evidence of how its number was reached.

The stored amount can diverge from what the invoice is worth today. That is
correct for capacity accounting — the program committed a specific amount — but
it means a revaluation report would need to convert separately rather than read
these figures.

Swapping in a live FX provider is one binding in `FxModule`.
