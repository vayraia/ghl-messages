import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces a 1:1 mapping between a GHL location and a WhatsApp channel so a
 * send can be routed by `location_id` unambiguously. Partial unique index:
 * non-null location_ids must be unique, but many rows may have NULL.
 *
 * Note: fails if existing data already has duplicate non-null location_ids;
 * dedupe before running in an environment with data.
 */
export class MetaChannelsLocationUnique1779667200000 implements MigrationInterface {
  name = 'MetaChannelsLocationUnique1779667200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_meta_channels_location_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_meta_channels_location_id" ON "meta_channels" ("location_id") WHERE "location_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_meta_channels_location_id"`);
    await queryRunner.query(
      `CREATE INDEX "idx_meta_channels_location_id" ON "meta_channels" ("location_id")`,
    );
  }
}
