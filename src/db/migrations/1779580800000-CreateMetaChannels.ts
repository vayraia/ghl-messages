import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMetaChannels1779580800000 implements MigrationInterface {
  name = 'CreateMetaChannels1779580800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // gen_random_uuid() lives in pgcrypto on older Postgres; harmless on 13+.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "meta_channels" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_key" text NOT NULL,
        "channel" text NOT NULL DEFAULT 'whatsapp',
        "phone_number_id" text NOT NULL,
        "waba_id" text,
        "display_phone_number" text,
        "access_token_enc" text NOT NULL,
        "graph_api_version" text,
        "location_id" text,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_meta_channels_tenant_key" UNIQUE ("tenant_key"),
        CONSTRAINT "uq_meta_channels_phone_number_id" UNIQUE ("phone_number_id"),
        CONSTRAINT "chk_meta_channels_status" CHECK ("status" IN ('active', 'disabled'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_meta_channels_location_id" ON "meta_channels" ("location_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "meta_channels"`);
  }
}
