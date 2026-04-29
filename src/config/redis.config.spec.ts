import { parseRedisUrl } from './redis.config';

describe('parseRedisUrl', () => {
  it('parses a minimal redis URL', () => {
    expect(parseRedisUrl('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 0,
      username: undefined,
      password: undefined,
      tls: undefined,
      maxRetriesPerRequest: null,
    });
  });

  it('parses user, password, host, port and db', () => {
    expect(parseRedisUrl('redis://default:s3cret@redis.example.com:6380/3')).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      db: 3,
      username: 'default',
      password: 's3cret',
    });
  });

  it('decodes percent-encoded credentials', () => {
    const opts = parseRedisUrl('redis://default:p%40ss%3Aword@redis.example.com:6379');
    expect(opts.password).toBe('p@ss:word');
  });

  it('enables TLS for rediss:// URLs', () => {
    expect(parseRedisUrl('rediss://redis.example.com:6379').tls).toEqual({});
  });

  it('defaults port to 6379 when omitted', () => {
    expect(parseRedisUrl('redis://redis.example.com').port).toBe(6379);
  });

  it('rejects unsupported schemes', () => {
    expect(() => parseRedisUrl('http://redis.example.com')).toThrow(/Unsupported Redis URL scheme/);
  });
});
