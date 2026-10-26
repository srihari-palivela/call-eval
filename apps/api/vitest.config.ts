import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Tests never call Claude or a real provider: the heuristic judge runs and provider APIs are stubbed.
    env: { LLM_JUDGE: 'off', DEMO_MODE: 'on', API_TOKEN: '', DATABASE_URL: '', PUBLIC_URL: 'https://evals.example.com', APP_SECRET: 'test-secret-for-vitest', LOG_LEVEL: 'error', AUDIO_MODEL_URL: '' },
  },
});
