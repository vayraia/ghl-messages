process.env.NODE_ENV = 'test';
process.env.WEBHOOK_SECRET = 'e2e-test-secret-value-please-be-long-enough';
process.env.LOG_LEVEL = 'fatal';
process.env.REDIS_URL = 'redis://localhost:6379/0';
process.env.CHAT_API_URL = 'https://chat.example.com';
process.env.GHL_API_KEY = 'e2e-test-ghl-api-key';
process.env.MESSAGE_DEBOUNCE_MS = '10';
