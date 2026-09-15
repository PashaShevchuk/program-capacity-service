import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class ReservationTimestampOrdering1789606800000 implements MigrationInterface {
  name = 'ReservationTimestampOrdering1789606800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_reservations"
        ADD CONSTRAINT "ck_invoice_reservations_closed_after_reserved" CHECK (
          ("released_at" IS NULL OR "released_at" >= "reserved_at")
          AND ("cancelled_at" IS NULL OR "cancelled_at" >= "reserved_at")
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_reservations"
        DROP CONSTRAINT IF EXISTS "ck_invoice_reservations_closed_after_reserved"
    `);
  }
}
