import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per advisor (human) first-reply to a contact message: how long the
 * advisor took from the contact's oldest unanswered inbound to their reply.
 * `outbound_message_id` is unique so a retried BullMQ job never double-inserts.
 */
export class CreateAdvisorResponseTimes1780000000000 implements MigrationInterface {
  name = 'CreateAdvisorResponseTimes1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE "advisor_response_times" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "location_id" text NOT NULL,
        "contact_id" text NOT NULL,
        "user_id" text NOT NULL,
        "channel" text,
        "inbound_message_id" text,
        "outbound_message_id" text NOT NULL,
        "inbound_at" timestamptz NOT NULL,
        "replied_at" timestamptz NOT NULL,
        "response_seconds" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_advisor_response_times_outbound_message_id" ON "advisor_response_times" ("outbound_message_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_advisor_response_times_loc_user_replied" ON "advisor_response_times" ("location_id", "user_id", "replied_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "advisor_response_times"`);
  }
}
