import { describe, expect, it, vi } from 'vitest';
import { OnchainRouterDiscovery, BASE_MAINNET_USDC } from './discovery.js';

const ORIGIN = 'https://router.example';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetcher(asset: string = BASE_MAINNET_USDC) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/v1/models'))
      return response({
        object: 'list',
        catalog_version: 'catalog-v1',
        categories: [],
        data: [
          {
            id: 'gemini-2.5-flash',
            category: 'text_generation',
            supported_endpoints: ['/v1/chat/completions'],
          },
        ],
      });
    if (url.endsWith('/.well-known/x402'))
      return response({
        x402Version: 2,
        resources: [
          {
            path: '/v1/chat/completions',
            model: 'gemini-2.5-flash',
            scheme: 'upto',
            network: 'eip155:8453',
            asset,
            payTo: RECIPIENT,
          },
        ],
      });
    if (url.endsWith('/v1/pricing'))
      return response({
        object: 'pricing_catalog',
        catalog_version: 'catalog-v1',
        service_fee_basis_points: 0,
        promotion: '0% service fee launch promotion',
        data: [],
      });
    if (url.endsWith('/v1/quotes')) {
      expect(init?.method).toBe('POST');
      if (typeof init?.body !== 'string') throw new Error('expected JSON quote body');
      expect(JSON.parse(init.body)).toEqual({
        kind: 'openai',
        request: { model: 'gemini-2.5-flash', messages: [] },
      });
      return response({
        token: 'bound-quote.token',
        maximumAmount: '600',
        expiresAt: 1_900_000_000_000,
        catalogVersion: 'catalog-v1',
      });
    }
    return response({
      object: 'wallet_balance',
      network: 'eip155:8453',
      asset: BASE_MAINNET_USDC,
      currency: 'USDC',
      wallet: RECIPIENT,
      balance_usdc_atomic: '1200000',
      balance_usdc: '1.2',
    });
  }) as unknown as typeof fetch;
}

describe('bounded buyer discovery', () => {
  it('derives one Base USDC policy contract from models and x402 discovery', async () => {
    const fetch = fetcher();
    const discovery = new OnchainRouterDiscovery(ORIGIN, { fetch });
    await expect(discovery.paymentContract()).resolves.toEqual({
      canonicalOrigin: ORIGIN,
      network: 'eip155:8453',
      asset: BASE_MAINNET_USDC,
      recipients: [RECIPIENT],
      models: ['gemini-2.5-flash'],
    });
    await expect(discovery.pricing()).resolves.toMatchObject({ service_fee_basis_points: 0 });
    await expect(discovery.balance(RECIPIENT)).resolves.toMatchObject({
      balance_usdc_atomic: '1200000',
    });
    await expect(
      discovery.quote('openai', { model: 'gemini-2.5-flash', messages: [] }),
    ).resolves.toEqual({
      token: 'bound-quote.token',
      maximumAtomic: 600n,
      expiresAt: 1_900_000_000_000,
      catalogVersion: 'catalog-v1',
    });
  });

  it('fails closed on a discovered non-USDC asset or unsafe origin', async () => {
    await expect(
      new OnchainRouterDiscovery(ORIGIN, {
        fetch: fetcher('0x2222222222222222222222222222222222222222'),
      }).paymentContract(),
    ).rejects.toMatchObject({ code: 'UnexpectedAsset' });
    expect(() => new OnchainRouterDiscovery('http://router.example')).toThrow();
    expect(() => new OnchainRouterDiscovery('https://user:secret@router.example')).toThrow();
  });

  it('rejects a balance response for a different wallet', async () => {
    const discovery = new OnchainRouterDiscovery(ORIGIN, { fetch: fetcher() });
    await expect(
      discovery.balance('0x3333333333333333333333333333333333333333'),
    ).rejects.toMatchObject({ code: 'RuntimeUnavailable' });
  });

  it('rejects an unsafe quote token before it can become a request header', async () => {
    const fetch = vi.fn(async () =>
      response({
        token: 'forged\nheader',
        maximumAmount: '600',
        expiresAt: 1_900_000_000_000,
        catalogVersion: 'catalog-v1',
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      new OnchainRouterDiscovery(ORIGIN, { fetch }).quote('openai', {
        model: 'gemini-2.5-flash',
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'RuntimeUnavailable' });
  });

  it('rejects oversized discovery before parsing', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }),
    ) as unknown as typeof globalThis.fetch;
    await expect(new OnchainRouterDiscovery(ORIGIN, { fetch }).models()).rejects.toMatchObject({
      code: 'RuntimeUnavailable',
    });
  });
});
