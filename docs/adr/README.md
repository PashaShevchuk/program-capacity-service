# Architecture decisions

Short records of the decisions that shaped this service: what the problem was,
what was chosen, and what that costs.

| # | Decision |
|---|---|
| [0001](0001-money-as-integer-minor-units.md) | Money is integer minor units, never floating point |
| [0002](0002-pessimistic-locking-for-capacity.md) | Capacity changes take a row lock on the program |
| [0003](0003-freeze-fx-rate-at-reservation.md) | The FX rate is frozen when the reservation is made |
| [0004](0004-local-jwt-authentication.md) | Local credentials issue HS256 JWTs |
| [0005](0005-transactional-outbox.md) | Events reach Kafka through a transactional outbox |
| [0006](0006-reconciliation-policy.md) | Reconciliation layers local changes over the snapshot |
