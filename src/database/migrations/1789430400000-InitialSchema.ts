import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Initial schema, written by hand so the money rules are easy to review.
 *
 * Amounts are `bigint` minor units, never floats.
 *
 * The database enforces `reserved_minor >= 0` but not `reserved_minor <=
 * total_limit_minor`: treasury can report an overcommitted program, and
 * refusing that snapshot would leave us out of sync with it for good.
 *
 * `created_at` and `reserved_at` are `timestamptz(3)` because cursor paging
 * reads them into a JavaScript Date, which cannot hold microseconds.
 */
export class InitialSchema1789430400000 implements MigrationInterface {
  name = 'InitialSchema1789430400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- users --------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(320) NOT NULL,
        "password_hash" varchar(100) NOT NULL,
        "name" varchar(200) NOT NULL,
        "roles" jsonb NOT NULL DEFAULT '["client"]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_users" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_email" ON "users" (lower("email"))`);

    // --- programs -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "programs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" varchar(64) NOT NULL,
        "name" varchar(200) NOT NULL,
        "currency" char(3) NOT NULL,
        "total_limit_minor" bigint NOT NULL,
        "reserved_minor" bigint NOT NULL DEFAULT 0,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "version" integer NOT NULL DEFAULT 0,
        "last_treasury_sequence" bigint,
        "last_reconciled_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_programs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_programs_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
        CONSTRAINT "ck_programs_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
        CONSTRAINT "ck_programs_limit_non_negative" CHECK ("total_limit_minor" >= 0),
        CONSTRAINT "ck_programs_reserved_non_negative" CHECK ("reserved_minor" >= 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_programs_code" ON "programs" ("code")`);

    // --- invoice reservations ----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "invoice_reservations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "program_id" uuid NOT NULL,
        "invoice_id" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'RESERVED',
        "invoice_amount_minor" bigint NOT NULL,
        "invoice_currency" char(3) NOT NULL,
        "reserved_amount_minor" bigint NOT NULL,
        "program_currency" char(3) NOT NULL,
        "fx_rate" numeric(24,12) NOT NULL,
        "fx_rate_source" varchar(64) NOT NULL,
        "fx_rate_at" timestamptz NOT NULL,
        "source" varchar(16) NOT NULL DEFAULT 'API',
        "idempotency_key" varchar(128),
        "request_fingerprint" varchar(64),
        "external_reference" varchar(128),
        "reserved_at" timestamptz(3) NOT NULL,
        "released_at" timestamptz,
        "cancelled_at" timestamptz,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_invoice_reservations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_invoice_reservations_program" FOREIGN KEY ("program_id")
          REFERENCES "programs" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_invoice_reservations_status"
          CHECK ("status" IN ('RESERVED', 'RELEASED', 'CANCELLED')),
        CONSTRAINT "ck_invoice_reservations_source" CHECK ("source" IN ('API', 'TREASURY')),
        CONSTRAINT "ck_invoice_reservations_amount_positive" CHECK ("invoice_amount_minor" > 0),
        CONSTRAINT "ck_invoice_reservations_reserved_positive" CHECK ("reserved_amount_minor" > 0),
        CONSTRAINT "ck_invoice_reservations_fx_rate_positive" CHECK ("fx_rate" > 0),
        CONSTRAINT "ck_invoice_reservations_closed_has_timestamp" CHECK (
          ("status" = 'RESERVED' AND "released_at" IS NULL AND "cancelled_at" IS NULL)
          OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "cancelled_at" IS NULL)
          OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "released_at" IS NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_invoice_reservations_program_invoice"
        ON "invoice_reservations" ("program_id", "invoice_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_invoice_reservations_idempotency_key"
        ON "invoice_reservations" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_invoice_reservations_program_status"
        ON "invoice_reservations" ("program_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_invoice_reservations_program_keyset"
        ON "invoice_reservations" ("program_id", "reserved_at" DESC, "id" DESC)
    `);

    // --- capacity ledger ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "capacity_ledger_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "program_id" uuid NOT NULL,
        "reservation_id" uuid,
        "entry_type" varchar(32) NOT NULL,
        "source" varchar(32) NOT NULL,
        "currency" char(3) NOT NULL,
        "reserved_delta_minor" bigint NOT NULL DEFAULT 0,
        "limit_delta_minor" bigint NOT NULL DEFAULT 0,
        "reserved_after_minor" bigint NOT NULL,
        "limit_after_minor" bigint NOT NULL,
        "reason" varchar(500),
        "correlation_id" varchar(128),
        "occurred_at" timestamptz NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "pk_capacity_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "fk_ledger_program" FOREIGN KEY ("program_id")
          REFERENCES "programs" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_ledger_reservation" FOREIGN KEY ("reservation_id")
          REFERENCES "invoice_reservations" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_ledger_entry_type" CHECK ("entry_type" IN
          ('RESERVE', 'RELEASE', 'CANCEL', 'LIMIT_CHANGE', 'RECONCILIATION_ADJUSTMENT')),
        CONSTRAINT "ck_ledger_source" CHECK ("source" IN
          ('API', 'TREASURY_EVENT', 'TREASURY_RECONCILIATION', 'SYSTEM'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_ledger_program_keyset"
        ON "capacity_ledger_entries" ("program_id", "created_at" DESC, "id" DESC)
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_reservation" ON "capacity_ledger_entries" ("reservation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_correlation_id" ON "capacity_ledger_entries" ("correlation_id")`,
    );

    // --- fx rates -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "fx_rates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "base_currency" char(3) NOT NULL,
        "quote_currency" char(3) NOT NULL,
        "rate" numeric(24,12) NOT NULL,
        "as_of" timestamptz NOT NULL,
        "source" varchar(64) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_fx_rates" PRIMARY KEY ("id"),
        CONSTRAINT "ck_fx_rates_rate_positive" CHECK ("rate" > 0),
        CONSTRAINT "ck_fx_rates_distinct_currencies" CHECK ("base_currency" <> "quote_currency")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_fx_rates_pair_as_of"
        ON "fx_rates" ("base_currency", "quote_currency", "as_of")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_fx_rates_pair_lookup"
        ON "fx_rates" ("base_currency", "quote_currency", "as_of" DESC)
    `);

    // --- kafka inbox --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "processed_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "message_key" varchar(300) NOT NULL,
        "topic" varchar(200) NOT NULL,
        "partition" integer NOT NULL,
        "kafka_offset" varchar(32) NOT NULL,
        "event_type" varchar(100),
        "processed_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_processed_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_processed_messages_key" ON "processed_messages" ("message_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_processed_messages_processed_at" ON "processed_messages" ("processed_at")`,
    );

    // --- transactional outbox ----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "outbox_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "topic" varchar(200) NOT NULL,
        "message_key" varchar(200) NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" varchar(1000),
        "published_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_outbox_messages" PRIMARY KEY ("id"),
        CONSTRAINT "ck_outbox_status" CHECK ("status" IN ('PENDING', 'PUBLISHED', 'FAILED'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_outbox_event_id" ON "outbox_messages" ("event_id")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_outbox_pending" ON "outbox_messages" ("created_at")
        WHERE "status" = 'PENDING'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "processed_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "fx_rates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "capacity_ledger_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "programs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
