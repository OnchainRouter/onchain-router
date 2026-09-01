import { describe, expect, it, vi } from 'vitest';
import { OnchainRouterClient } from './index.js';
describe('buyer wrapper', () => {
  it('preserves one idempotency key through the official payment-enabled fetch', async () => {
    const paymentFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await new OnchainRouterClient({ baseUrl: 'https://router.test', paymentFetch }).chat(
      { model: 'fake-model' },
      'key-1',
    );
    const call = paymentFetch.mock.calls[0];
    expect(call?.[0]).toBe('https://router.test/v1/chat/completions');
    expect(new Headers(call?.[1]?.headers).get('x-idempotency-key')).toBe('key-1');
  });
});
