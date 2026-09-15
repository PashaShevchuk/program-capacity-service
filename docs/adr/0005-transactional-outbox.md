# 5. Events reach Kafka through a transactional outbox

Accepted.

## Context

When capacity changes, downstream systems need to know. PostgreSQL and Kafka
cannot take part in one transaction, so producing inline is unsafe in both
directions: the database commits and the broker call fails, leaving consumers
permanently behind; or the broker accepts and the transaction rolls back,
announcing a change that never happened.

## Decision

Write the event into `outbox_messages` in the same transaction as the change. A
background publisher claims pending rows with `FOR UPDATE SKIP LOCKED`, sends
them, and marks them published. Rows that keep failing stop after a configured
number of attempts and are marked `FAILED` rather than dropped.

The event carries an `eventId`, so consumers deduplicate the same way this
service does with treasury messages.

## Consequences

An event is published if and only if its change committed. Delivery is at least
once, which consumers must handle — that is the normal contract.

`SKIP LOCKED` means several instances can poll the same table without sending
anything twice.

The cost is latency: an event is visible after the next poll rather than
immediately, and there is a table to keep an eye on. At this volume a one-second
poll is fine; if it stopped being fine, the next step is reading the WAL
instead of polling.

Failed rows need an operator today. A replay endpoint would be worth adding.
