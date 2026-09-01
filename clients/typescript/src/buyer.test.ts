import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import {
  LocalSpendLedger,
  SignerBroker,
  WalletVault,
  createBuyerPolicy,
} from '@agenticfi/onchain-router-buyer-core/admin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnchainRouterBuyer } from './buyer.js';
import { BASE_MAINNET_USDC } from './discovery.js';
import { buyerProfilePaths, writeBuyerSession } from './profile.js';

const ORIGIN = 'https://router.example';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const FACILITATOR = '0x2222222222222222222222222222222222222222';
const PASSPHRASE = 'correct horse battery staple';
const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-sdk-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('high-level TypeScript Buyer Runtime SDK', () => {
  it('executes one official paid lifecycle and exposes only verified durable state', async () => {
    const root = await directory();
    const paths = buyerProfilePaths(root);
    const policy = createBuyerPolicy({
      canonicalOrigin: ORIGIN,
      network: 'eip155:8453',
      asset: BASE_MAINNET_USDC,
      recipients: [RECIPIENT],
      schemes: ['upto'],
      models: ['gemini-2.5-flash'],
      delegations: [{ agentId: 'sdk-test', maximumAtomic: 2_000n }],
      limits: {
        perCallAtomic: 1_000n,
        sessionAtomic: 2_000n,
        hourAtomic: 2_000n,
        dayAtomic: 5_000n,
      },
      sessionDurationMs: 60_000,
      reservationTtlMs: 5_000,
      maximumAuthorizationSeconds: 60,
      maximumOutputTokens: 8_192,
      requirePerCallConfirmation: false,
    });
    const ledger = new LocalSpendLedger(paths.ledgerPath, policy);
    const vault = new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    await vault.create(PASSPHRASE);
    const broker = new SignerBroker({
      socketPath: paths.socketPath,
      vault,
      ledger,
      policy,
      agentId: 'sdk-test',
      idleTimeoutMs: 10_000,
      absoluteTimeoutMs: 60_000,
    });
    const session = await broker.start(PASSPHRASE);
    await writeBuyerSession(root, session);
    const receiptId = randomUUID();
    let calls = 0;
    let catalogRequests = 0;
    let catalogUnavailable = false;
    const quoteBodies: unknown[] = [];
    const forwardedQuoteTokens: Array<string | null> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/v1/models')) {
        catalogRequests += 1;
        if (catalogUnavailable) throw new Error('fixture discovery outage');
        return new Response(
          JSON.stringify({
            object: 'list',
            catalog_version: 'catalog-test',
            categories: [],
            data: [
              {
                id: 'gemini-2.5-flash',
                supported_endpoints: ['/v1/images/generations'],
                image: {
                  default_image_size: '1K',
                  default_aspect_ratio: '1:1',
                  supported_image_sizes: ['1K'],
                  supported_aspect_ratios: ['1:1'],
                  response_formats: ['url'],
                },
              },
            ],
          }),
        );
      }
      if (url.endsWith('/v1/quotes')) {
        if (typeof init?.body !== 'string') throw new Error('expected JSON quote body');
        quoteBodies.push(JSON.parse(init.body) as unknown);
        return new Response(
          JSON.stringify({
            token: 'request-bound.quote',
            maximumAmount: '600',
            expiresAt: Date.now() + 60_000,
            catalogVersion: 'catalog-test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      forwardedQuoteTokens.push(new Headers(init?.headers).get('x-quote-token'));
      calls += 1;
      if (calls === 1)
        return new Response(JSON.stringify({ error: 'payment_required' }), {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'payment-required': encodePaymentRequiredHeader({
              x402Version: 2,
              resource: {
                url,
                description: 'test',
                mimeType: 'application/json',
              },
              accepts: [
                {
                  scheme: 'upto',
                  network: 'eip155:8453',
                  asset: BASE_MAINNET_USDC,
                  amount: '600',
                  payTo: RECIPIENT,
                  maxTimeoutSeconds: 60,
                  extra: { facilitatorAddress: FACILITATOR },
                },
              ],
            }),
          },
        });
      if (calls === 2 || (calls > 3 && url.endsWith('/v1/images/generations')))
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'payment-response': encodePaymentResponseHeader({
                success: true,
                transaction: '0xsettlement',
                network: 'eip155:8453',
                payer: session.address,
                amount: '123',
              }),
              'x-receipt-id': receiptId,
              'x-receipt-token': 'receipt-token-never-exposed',
            },
          },
        );
      return new Response(
        JSON.stringify({
          id: receiptId,
          operationId: receiptId,
          catalogVersion: 'catalog-test',
          model: 'gemini-2.5-flash',
          usage: { inputTokens: '1', outputTokens: '2' },
          settlement: {
            success: true,
            transaction: '0xsettlement',
            network: 'eip155:8453',
            payer: session.address,
          },
          maximumAmount: '600',
          actualAmount: '123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const buyer = await OnchainRouterBuyer.connect({ profileDirectory: root, fetch });
    try {
      const result = await buyer.chat(
        { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }] },
        'sdk-payment-1',
      );
      expect(result).toMatchObject({
        ok: true,
        outcome: 'Completed',
        payment: { authorizedMaximumAtomic: '600', actualAtomic: '123' },
      });
      expect(safeJson(result)).not.toContain('receipt-token-never-exposed');
      expect(buyer.receipt('sdk-payment-1')).toMatchObject({ id: receiptId });
      expect(await buyer.status()).toMatchObject({
        agentId: 'sdk-test',
        spend: { sessionAtomic: '123' },
      });
      calls = 0;
      forwardedQuoteTokens.length = 0;
      const routed = await buyer.routedChat(
        { messages: [{ role: 'user', content: 'write code' }], max_tokens: 100 },
        {
          profile: 'auto',
          models: [
            {
              id: 'gemini-2.5-flash',
              enabled: true,
              category: 'text_generation',
              capabilities: ['text'],
              maximumOutputTokens: 8_192,
              qualityBasisPoints: { general: 8_000, code: 9_000 },
            },
          ],
        },
        'sdk-routed-payment-1',
      );
      expect(routed.routing).toMatchObject({
        selectedModel: 'gemini-2.5-flash',
        selectedMaximumAtomic: '600',
        routeSetMaximumAtomic: '600',
        fallbackAuthorized: false,
      });
      expect(routed.result).toMatchObject({ ok: true, payment: { actualAtomic: '123' } });
      expect(routed.routingReceipt).toMatchObject({
        version: 'onchain-router-routing-receipt-evidence/v1',
        associationStatus: 'verified',
        receiptId,
        model: 'gemini-2.5-flash',
        receiptModel: 'gemini-2.5-flash',
        modelMatches: true,
        quoteCatalogVersion: 'catalog-test',
        receiptCatalogVersion: 'catalog-test',
        catalogVersionsMatch: true,
        payment: {
          network: 'eip155:8453',
          maximumAtomic: '600',
          actualAtomic: '123',
          transaction: '0xsettlement',
        },
      });
      expect(quoteBodies).toEqual([
        {
          kind: 'openai',
          request: {
            messages: [{ role: 'user', content: 'write code' }],
            max_tokens: 100,
            model: 'gemini-2.5-flash',
          },
        },
      ]);
      expect(forwardedQuoteTokens.slice(0, 2)).toEqual([
        'request-bound.quote',
        'request-bound.quote',
      ]);
      calls = 0;
      const imageBody = { model: 'gemini-2.5-flash', prompt: 'fixture' };
      expect((await buyer.images(imageBody, 'sdk-image-recovery')).ok).toBe(true);
      catalogUnavailable = true;
      expect((await buyer.images(imageBody, 'sdk-image-recovery')).ok).toBe(true);
      expect(catalogRequests).toBe(1);
      expect(
        (await buyer.images({ ...imageBody, prompt: 'changed' }, 'sdk-image-recovery')).ok,
      ).toBe(false);
      await expect(buyer.images(imageBody, 'new-image-during-outage')).rejects.toThrow(
        'discovery request failed',
      );
    } finally {
      await buyer.lock();
      await broker.stop();
      ledger.close();
    }
  });
});

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}
