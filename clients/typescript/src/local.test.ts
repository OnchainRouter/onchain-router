import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalSpendLedger,
  WalletVault,
  createBuyerPolicy,
} from '@agenticfi/onchain-router-buyer-core/admin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_MAINNET_USDC } from './discovery.js';
import { inspectBuyerCatalog, inspectBuyerProfile, readBuyerReceipt } from './local.js';
import { buyerProfilePaths } from './profile.js';

const ORIGIN = 'https://router.example';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const PASSPHRASE = 'correct horse battery staple';
const directories: string[] = [];

async function profile(): Promise<string> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-local-'));
  directories.push(root);
  const paths = buyerProfilePaths(root);
  const policy = createBuyerPolicy({
    canonicalOrigin: ORIGIN,
    network: 'eip155:8453',
    asset: BASE_MAINNET_USDC,
    recipients: [RECIPIENT],
    schemes: ['exact'],
    models: ['gemini-2.5-flash'],
    delegations: [{ agentId: 'mcp', maximumAtomic: 4_000n }],
    limits: {
      perCallAtomic: 1_000n,
      sessionAtomic: 2_000n,
      hourAtomic: 3_000n,
      dayAtomic: 4_000n,
    },
    sessionDurationMs: 60_000,
    reservationTtlMs: 5_000,
    maximumAuthorizationSeconds: 60,
    maximumOutputTokens: 8_192,
    requirePerCallConfirmation: false,
  });
  new LocalSpendLedger(paths.ledgerPath, policy).close();
  await new WalletVault({
    directory: paths.walletDirectory,
    scryptN: 1_024,
    allowWeakTestKdf: true,
  }).create(PASSPHRASE);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('non-secret local buyer inspection', () => {
  it('reports a locked profile, immutable policy, and no signer capability', async () => {
    const root = await profile();
    const status = await inspectBuyerProfile({ profileDirectory: root, includeBalance: false });
    expect(status).toMatchObject({
      initialized: true,
      locked: true,
      agentId: null,
      spend: null,
      balance: null,
      balanceStatus: 'not_requested',
      policy: {
        canonicalOrigin: ORIGIN,
        models: ['gemini-2.5-flash'],
        maximumOutputTokens: 8_192,
        limits: { perCallAtomic: '1000', dayAtomic: '4000' },
        delegations: [{ agentId: 'mcp', maximumAtomic: '4000', revoked: false }],
      },
    });
    expect(status.address).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(JSON.stringify(status)).not.toMatch(/capability|passphrase|privateKey|seedPhrase/i);
    expect(readBuyerReceipt('missing-receipt', { profileDirectory: root })).toBeNull();
  });

  it('returns live model/pricing data only from the policy-bound origin', async () => {
    const root = await profile();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const requestUrl = new URL(url);
      expect(requestUrl.origin).toBe(ORIGIN);
      expect(requestUrl.search).toBe('');
      expect(['/v1/models', '/v1/pricing']).toContain(requestUrl.pathname);
      if (requestUrl.pathname === '/v1/models')
        return new Response(
          JSON.stringify({
            object: 'list',
            catalog_version: 'catalog-1',
            categories: ['text_generation'],
            data: [{ id: 'gemini-2.5-flash', supported_endpoints: ['/v1/chat/completions'] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      return new Response(
        JSON.stringify({
          object: 'pricing_catalog',
          catalog_version: 'catalog-1',
          service_fee_basis_points: 0,
          promotion: 'launch',
          data: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const catalog = await inspectBuyerCatalog({ profileDirectory: root, fetch });
    expect(catalog).toMatchObject({
      models: { catalog_version: 'catalog-1' },
      pricing: { service_fee_basis_points: 0 },
      policy: { canonicalOrigin: ORIGIN, models: ['gemini-2.5-flash'] },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
