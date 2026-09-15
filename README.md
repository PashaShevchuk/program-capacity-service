# Program Capacity & Invoice Reservation

A service that tracks how much of a financing program's credit limit is still
available, in real time.

When an invoice is approved for early payment it reserves part of the limit.
When the invoice is repaid, that amount is released. Capacity also moves through
a Kafka feed from an external treasury system, which sends both incremental
events and periodic full-state snapshots. Programs and invoices can be in
different currencies.

---

## Running it

You need Docker and Node 20 or newer (`.nvmrc` pins 22).

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL, Redpanda, topics, Kafka UI
npm ci
npm run migration:run
npm run seed
npm run start:dev
```

The service is then on <http://localhost:3000>, with Swagger at
<http://localhost:3000/docs> and a Kafka UI at <http://localhost:8080>.

To run everything in containers instead:

```bash
docker compose --profile app up --build
```

### Seeded data

| Email | Password | Role | Can do |
|---|---|---|---|
| `admin@demo.local` | `Admin123!` | admin | everything, including creating programs and changing limits |
| `client@demo.local` | `Client123!` | client | reserve, release, read |
| `viewer@demo.local` | `Viewer123!` | viewer | read only |

Two programs are seeded: `PRG-USD-001` with a $10,000,000 limit and
`PRG-EUR-001` with €5,000,000, plus the FX rates they need.

### Trying it out

`requests.http` has a request for every endpoint, ready for the VS Code REST
Client or the JetBrains HTTP client. In short:

```bash
TOKEN=$(curl -s localhost:3000/v1/auth/token \
  -H 'content-type: application/json' \
  -d '{"email":"admin@demo.local","password":"Admin123!"}' | jq -r .accessToken)

curl -s localhost:3000/v1/programs/PRG-USD-001/capacity -H "Authorization: Bearer $TOKEN"

# A EUR invoice against a USD program
curl -s -X POST localhost:3000/v1/programs/PRG-USD-001/reservations \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"invoiceId":"INV-1","amount":{"amount":"1000000.00","currency":"EUR"}}'
```

To see the Kafka side without a treasury system:

```bash
npm run simulate:treasury -- PRG-USD-001
```

That publishes a snapshot, a duplicate of it, an out-of-order snapshot, a
treasury reservation, a malformed message and a limit change, so you can watch
deduplication, the sequence guard and the DLQ all do their job.

---

## API

Everything under `/v1` needs a bearer token. `/healthz`, `/readyz` and
`/metrics` do not.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/token` | — | exchange credentials for a JWT |
| `GET` | `/v1/programs` | any | list programs |
| `POST` | `/v1/programs` | admin | create a program |
| `GET` | `/v1/programs/:ref` | any | one program |
| `GET` | `/v1/programs/:ref/capacity` | any | limit, reserved, available |
| `GET` | `/v1/programs/:ref/capacity/stream` | any | server-sent stream of changes |
| `PATCH` | `/v1/programs/:ref/limit` | admin | change the credit limit |
| `GET` | `/v1/programs/:ref/ledger` | any | audit trail |
| `POST` | `/v1/programs/:ref/reservations` | client, admin | reserve for an approved invoice |
| `GET` | `/v1/programs/:ref/reservations` | any | list reservations |
| `GET` | `/v1/programs/:ref/reservations/:ref` | any | one reservation |
| `POST` | `/v1/programs/:ref/reservations/:ref/release` | client, admin | release after repayment |
| `POST` | `/v1/programs/:ref/reservations/:ref/cancel` | client, admin | withdraw a reservation |

`:ref` accepts either a UUID or a business code, so `PRG-USD-001` and
`INV-2026-000123` work as well as ids.

Errors are [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
`application/problem+json` with a stable `code`:

```json
{
  "type": "https://docs.capacity.example/errors/INSUFFICIENT_CAPACITY",
  "title": "Insufficient capacity",
  "status": 409,
  "detail": "Program PRG-USD-001 has 8915000.00 USD available, which is less than the requested 20000000.00 USD",
  "code": "INSUFFICIENT_CAPACITY",
  "requestId": "062f456b-0da8-452c-af2a-c71bd595e18c",
  "details": { "requestedAmount": "20000000.00", "availableAmount": "8915000.00" }
}
```

---

## How the hard parts work

### Capacity can never be oversold

Two approvals arriving at the same moment must not both see the same
availability and both succeed. Every capacity movement runs in one transaction
that starts by taking a row lock on the program:

```sql
SELECT * FROM programs WHERE code = $1 FOR UPDATE
```

The check and the write then happen while no one else can touch that row. The
update repeats the invariant in its `WHERE` clause as a second line of defence,
and refuses to continue if it affects no rows.

Locking per program is the right granularity: programs are independent of each
other, so this serialises only the approvals for one program. `test/integration/capacity-concurrency.spec.ts`
fires 50 simultaneous reservations at a limit that fits 33 and asserts that
exactly 33 succeed and the reserved total lands on the limit, never past it.

### Money never drifts

Amounts are integer minor units in `bigint` columns, wrapped in a `Money` value
object. No floating point is involved anywhere, and arithmetic between
different currencies throws rather than silently coercing.

Amounts cross the wire as decimal strings (`"10000000.00"`), never as JSON
numbers, so a client's parser cannot round them. An amount with more decimal
places than the currency has is rejected rather than rounded: quietly turning a
client's `10.005` into `10.01` would make our books disagree with theirs.

### The FX rate is frozen at reservation time

A program in USD can hold a reservation for an invoice in EUR. The invoice
amount is converted once, when the reservation is made, and the resulting
program-currency amount is stored on the reservation along with the rate, its
source and its effective date.

Releasing returns **exactly that stored amount**. It does not convert again. If
it did, a rate that moved between approval and repayment would leave the
program permanently short or permanently over — the kind of leak that only
shows up months later in a reconciliation.

Rates come from an `ExchangeRateProvider` port. The bundled adapter reads the
`fx_rates` table, which is the local record of the treasury rate feed and is
populated by the seed. Pointing the service at a live FX provider means binding
a different implementation in `FxModule`; nothing else changes.

### Kafka messages are applied exactly once

Kafka delivers at least once, so the same message will sometimes arrive twice.
Each consumed message is claimed by inserting a row into `processed_messages`
**inside the same transaction** as the change it causes. A redelivery hits the
unique constraint, the transaction rolls back, and capacity is not counted
twice.

Offsets are committed by hand after the message has either been applied or
parked, so a crash mid-processing replays rather than loses.

Failures are separated by kind. A validation or business error will fail the
same way on every attempt, so it goes straight to `<topic>.dlq` with headers
naming the error and the original offset. Anything else is retried with
exponential backoff first. Either way the partition keeps moving.

### Reconciliation does not throw away local work

A snapshot is authoritative as at its `asOf` timestamp, but this service may
have moved on since. It may have accepted reservations treasury has not seen,
and released ones the snapshot still counts as open. Overwriting with the raw
snapshot total would drop the first group and double-count the second.

```
expected = snapshot reserved
         + reservations opened here after asOf and still open
         - reservations the snapshot counts that we have since closed
```

Whatever difference remains between `expected` and the current total is applied
as a `RECONCILIATION_ADJUSTMENT` entry in the ledger, with the snapshot's own
figures in its metadata. A correction is visible, not silent.

Snapshots and events both carry a `sequence` that is monotonic per program.
Kafka only orders within a partition, so anything at or below the sequence
already applied is discarded. The arithmetic lives in a pure function,
`reconcileCapacity`, which is unit-tested on its own.

### Nothing is lost between the database and Kafka

PostgreSQL and Kafka cannot share a transaction. Publishing inline leaves a
window where capacity changed but the event vanished, or the reverse. Instead
the event is written to `outbox_messages` in the same transaction, and a
background publisher claims rows with `FOR UPDATE SKIP LOCKED` and sends them.
Delivery is at least once, and consumers deduplicate on `eventId`.

### Everything that moves is auditable

`capacity_ledger_entries` is append-only. Each row carries the delta, the
balances it produced, who caused it, and the request or message id behind it.
Nothing in the service updates or deletes a row there, so drift between the
running total and the ledger is detectable rather than silent.

---

## Kafka contracts

Consumed:

**`treasury.capacity.events.v1`** — incremental changes

```json
{
  "eventId": "8a7b...",
  "eventType": "CapacityReserved",
  "programCode": "PRG-USD-001",
  "sequence": 1001,
  "occurredAt": "2026-09-15T10:00:00.000Z",
  "payload": {
    "invoiceId": "TR-77",
    "amount": { "amount": "500000.00", "currency": "EUR" },
    "externalReference": "TRS-77"
  }
}
```

`eventType` is one of `CapacityReserved`, `CapacityReleased`
(`payload: { invoiceId, reason? }`) or `ProgramLimitChanged`
(`payload: { totalLimit }`).

**`treasury.capacity.reconciliation.v1`** — full state

```json
{
  "eventId": "c41d...",
  "programCode": "PRG-USD-001",
  "sequence": 1000,
  "occurredAt": "2026-09-15T10:00:00.000Z",
  "asOf": "2026-09-15T09:59:00.000Z",
  "totalLimit": { "amount": "12000000.00", "currency": "USD" },
  "reservedTotal": { "amount": "2000000.00", "currency": "USD" },
  "openReservations": [{ "invoiceId": "TR-A", "amount": { "amount": "1200000.00", "currency": "USD" } }]
}
```

`openReservations` is optional and used only to cross-check `reservedTotal`; a
mismatch is logged and the reported total is used.

Published:

**`program.capacity.changed.v1`**, keyed by program id so one program's events
stay ordered, carrying the new limit, reserved and available amounts, the
program `version` and the reason for the change.

Failed messages go to `<topic>.dlq`.

---

## Tests

```bash
npm run test:unit          # fast, no Docker
npm run test:integration   # starts a PostgreSQL container per suite
npm test                   # both
```

Unit tests cover the parts where the logic lives: money arithmetic and
precision rules, currency conversion and rounding, the reservation state
machine, and the reconciliation arithmetic.

Integration tests cover what unit tests cannot prove, on a real database:

- **concurrency** — 50 simultaneous reservations against a limit that fits 33;
  also interleaved reserves and releases, and one ledger entry per reservation
  with no gaps or repeats in the running balance;
- **HTTP** — authentication, roles, cross-currency reservations, idempotent
  retries, duplicate invoices, insufficient capacity, precision rules, release
  and cancel, limit changes, the audit trail;
- **treasury messages** — snapshots, deduplicated redeliveries, out-of-order
  sequences, local reservations surviving a snapshot, released ones not coming
  back, and malformed payloads failing permanently.

There is no test against a live broker. Handlers are driven through
`KafkaConsumerService.processMessage`, which is the same deduplication and
transaction path `eachMessage` uses, so a broker would add start-up time and
flakiness without covering anything more. The wiring itself is exercised by
`npm run simulate:treasury`.

---

## Operations

- `GET /healthz` — liveness, touches nothing
- `GET /readyz` — readiness, pings the database
- `GET /metrics` — Prometheus: reservation outcomes, available capacity and
  utilisation per program, Kafka message outcomes and processing time
- Logs are JSON with a request id on every line, propagated from
  `x-request-id`; the same id lands on ledger entries, so a capacity movement
  can be traced back to the request that caused it. Authorization headers and
  passwords are redacted.

---

## Layout

```
src/
  common/        Money, domain errors, RFC 7807 filter, logging, pagination
  config/        typed config, validated at boot
  database/      data source, migrations, seeds
  auth/          JWT strategy, guards, roles
  programs/      program entity, capacity repository (locking), controller
  reservations/  reserve / release / cancel
  ledger/        append-only audit trail
  fx/            rate port, database adapter, pure converter
  kafka/         client, consumer, deduplication, DLQ
  treasury/      message contracts and handlers, reconciliation
  outbox/        transactional outbox and its publisher
  health/ metrics/
```

The layering is deliberate but not ceremonial: `Money`, `convertMoney` and
`reconcileCapacity` are plain TypeScript with no framework in sight, which is
why they are the easiest parts to test.

---

## Assumptions and trade-offs

See [ASSUMPTIONS.md](ASSUMPTIONS.md) for the full list, and
[docs/adr](docs/adr) for the reasoning behind the main decisions.
