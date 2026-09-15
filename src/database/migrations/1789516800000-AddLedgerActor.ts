import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddLedgerActor1789516800000 implements MigrationInterface {
  name = 'AddLedgerActor1789516800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "capacity_ledger_entries"
        ADD COLUMN "actor_type" varchar(16) NOT NULL DEFAULT 'SYSTEM',
        ADD COLUMN "actor_id" varchar(128),
        ADD COLUMN "actor_label" varchar(320)
    `);

    await queryRunner.query(`
      ALTER TABLE "capacity_ledger_entries"
        ADD CONSTRAINT "ck_ledger_actor_type"
        CHECK ("actor_type" IN ('USER', 'TREASURY', 'SYSTEM'))
    `);

    await queryRunner.query(`
      ALTER TABLE "capacity_ledger_entries"
        ADD CONSTRAINT "ck_ledger_user_actor_identified"
        CHECK ("actor_type" <> 'USER' OR "actor_id" IS NOT NULL)
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_ledger_actor" ON "capacity_ledger_entries" ("actor_type", "actor_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_ledger_actor"`);
    await queryRunner.query(`
      ALTER TABLE "capacity_ledger_entries"
        DROP CONSTRAINT IF EXISTS "ck_ledger_user_actor_identified",
        DROP CONSTRAINT IF EXISTS "ck_ledger_actor_type",
        DROP COLUMN IF EXISTS "actor_label",
        DROP COLUMN IF EXISTS "actor_id",
        DROP COLUMN IF EXISTS "actor_type"
    `);
  }
}
