import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * First advisor reply to a contact's unanswered message, with the elapsed time.
 * The schema is NOT created by this repo: it lives in the `ai` repo as
 * `migrations/053_advisor_response_times.sql`, applied by hand with `psql`
 * (`synchronize` is always off). The decorators mirror that file.
 */
@Entity({ name: 'advisor_response_times' })
@Index('idx_advisor_response_times_loc_user_replied', ['locationId', 'userId', 'repliedAt'])
export class AdvisorResponseTime {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'location_id', type: 'text' })
  locationId!: string;

  @Column({ name: 'contact_id', type: 'text' })
  contactId!: string;

  @Column({ name: 'user_id', type: 'text' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  channel!: string | null;

  @Column({ name: 'inbound_message_id', type: 'text', nullable: true })
  inboundMessageId!: string | null;

  @Index('uq_advisor_response_times_outbound_message_id', { unique: true })
  @Column({ name: 'outbound_message_id', type: 'text' })
  outboundMessageId!: string;

  @Column({ name: 'inbound_at', type: 'timestamptz' })
  inboundAt!: Date;

  @Column({ name: 'replied_at', type: 'timestamptz' })
  repliedAt!: Date;

  @Column({ name: 'response_seconds', type: 'int' })
  responseSeconds!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
