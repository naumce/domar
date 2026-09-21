import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('rate limit', () => {
  it('throttles repeated login attempts from the same client', async () => {
    const t = await createTestApp();
    try {
      const payload = { tenantSlug: 'ghost', email: 'ana@test.mk', password: 'wrong-password' };
      let last;
      for (let i = 0; i < 11; i++) {
        last = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload });
      }
      expect(last!.statusCode).toBe(429);
      expect(last!.json().error).toBeDefined();
    } finally {
      await t.close();
    }
  });
});
