import { PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';
import { PAID_JSON_ENDPOINTS } from '@agenticfi/onchain-router';
import type { CacheMode } from './response-cache.js';

export function parseCacheRequest(
  body: Readonly<Record<string, unknown>>,
  header?: string,
): {
  body: Readonly<Record<string, unknown>>;
  cacheMode: CacheMode;
} {
  for (const field of ['cache', 'no_cache']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean')
      throw new PaymentPolicyRejected(`${field} must be boolean`);
  }
  const directives = new Set(
    (header ?? '').split(',').map((part) => part.trim().toLowerCase().split('=')[0]?.trim()),
  );
  const cacheMode: CacheMode =
    body['cache'] === false || body['no_cache'] === true || directives.has('no-store')
      ? 'bypass'
      : directives.has('no-cache')
        ? 'refresh'
        : 'reuse';
  return {
    body: Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'cache' && key !== 'no_cache'),
    ),
    cacheMode,
  };
}

export const MAX_PROXY_CHAT_BODY_BYTES = 128 * 1024;
export const DEFAULT_PROXY_PORT = 8402;
export const PROXY_HOST = '127.0.0.1' as const;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'api_base',
  'base_url',
  'origin',
  'network',
  'asset',
  'recipient',
  'payTo',
  'pay_to',
  'scheme',
  'maximum',
  'maxAmountRequired',
  'payment',
  'payment_signature',
  'x_payment',
  'wallet',
  'private_key',
  'seed',
  'mnemonic',
  'passphrase',
  'idempotency_key',
]);

export function parseChatBody(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PaymentPolicyRejected('chat request body must be a JSON object');
  const body = value as Record<string, unknown>;
  for (const field of FORBIDDEN_AUTHORITY_FIELDS) {
    if (Object.hasOwn(body, field))
      throw new PaymentPolicyRejected(`chat request contains forbidden authority field: ${field}`);
  }
  if (typeof body['model'] !== 'string' || !MODEL.test(body['model']))
    throw new PaymentPolicyRejected('chat request requires an explicit valid model');
  if (!Array.isArray(body['messages']) || body['messages'].length < 1)
    throw new PaymentPolicyRejected('chat request requires at least one message');
  if (body['messages'].length > 128)
    throw new PaymentPolicyRejected('chat request contains too many messages');
  if (body['stream'] !== undefined && body['stream'] !== false)
    throw new PaymentPolicyRejected('streaming is not supported by the local buyer proxy');
  if (body['stream_options'] !== undefined)
    throw new PaymentPolicyRejected('stream options are not supported by the local buyer proxy');
  return body;
}

export function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) throw new PaymentPolicyRejected('idempotency key is invalid');
  return value;
}

export interface ProxyClientRecipe {
  readonly baseURL: string;
  readonly tokenFile: string;
  readonly endpoints: readonly string[];
  readonly streaming: false;
  readonly idempotencyHeader: 'Idempotency-Key';
}

export function proxyClientRecipe(port: number, tokenFile: string): ProxyClientRecipe {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new PaymentPolicyRejected('proxy port must be between 1 and 65535');
  return {
    baseURL: `http://${PROXY_HOST}:${port}/v1`,
    tokenFile,
    endpoints: ['/v1/models', ...PAID_JSON_ENDPOINTS, '/v1/pricing', '/v1/audio/voices'],
    streaming: false,
    idempotencyHeader: 'Idempotency-Key',
  };
}
