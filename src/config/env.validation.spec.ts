import { envValidationSchema } from './env.validation';

// Minimal set of always-required vars (everything else has a default or is
// gated behind META_OUTBOUND_ENABLED).
const base = {
  WEBHOOK_SECRET: 'a'.repeat(16),
  META_APP_SECRET: 'b'.repeat(16),
  META_VERIFY_TOKEN: 'c'.repeat(8),
  REDIS_URL: 'redis://localhost:6379/0',
  CHAT_API_URL: 'https://chat.example.com',
  JOBS_URL: 'https://jobs.example.com',
};

describe('envValidationSchema — META_OUTBOUND_ENABLED gating', () => {
  it('boots without DATABASE_URL / META_TOKEN_ENC_KEY when the flag is off (default)', () => {
    const { error, value } = envValidationSchema.validate(base, { allowUnknown: true });
    expect(error).toBeUndefined();
    expect(value.META_OUTBOUND_ENABLED).toBe(false);
  });

  it('requires DATABASE_URL and META_TOKEN_ENC_KEY when the flag is on', () => {
    const { error } = envValidationSchema.validate(
      { ...base, META_OUTBOUND_ENABLED: true },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    const missing = error!.details.map((d) => d.context?.key);
    expect(missing).toContain('DATABASE_URL');
    expect(missing).toContain('META_TOKEN_ENC_KEY');
  });

  it('passes when the flag is on and both are provided', () => {
    const { error } = envValidationSchema.validate(
      {
        ...base,
        META_OUTBOUND_ENABLED: true,
        DATABASE_URL: 'postgres://localhost:5432/db',
        META_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
      },
      { allowUnknown: true },
    );
    expect(error).toBeUndefined();
  });
});
