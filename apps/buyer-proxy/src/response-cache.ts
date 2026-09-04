import { createHash } from 'node:crypto';
import type { BuyerResult } from '@onchainrouter/buyer-core';

export const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
export const RESPONSE_CACHE_MAX_ENTRIES = 200;
export const RESPONSE_CACHE_MAX_ITEM_BYTES = 1024 * 1024;
export const RESPONSE_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export type CacheMode = 'reuse' | 'refresh' | 'bypass';

/** A local reuse event, deliberately not a BuyerSuccess or a new payment proof. */
export interface CachedResponse {
  readonly ok: true;
  readonly outcome: 'CachedResponse';
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly chargedAtomic: '0';
  readonly cache: {
    readonly sourceReceiptId: string;
    readonly ageMs: number;
    readonly expiresAt: number;
  };
}

interface Entry {
  readonly json: string;
  readonly sourceReceiptId: string;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly createdMonotonic: number;
  readonly expiresMonotonic: number;
  readonly bytes: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Conservative eligibility: no tool invocations, external media, or streaming side effects. */
export function cacheableRequest(body: Readonly<Record<string, unknown>>): boolean {
  const fields = new Set([
    'model',
    'messages',
    'stream',
    'max_tokens',
    'max_output_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
    'seed',
    'stop',
    'n',
    'response_format',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'user',
    'request_id',
  ]);
  if (Object.keys(body).some((field) => !fields.has(field))) return false;
  if (
    (body['stream'] !== undefined && body['stream'] !== false) ||
    [
      'tools',
      'tool_choice',
      'functions',
      'function_call',
      'modalities',
      'audio',
      'web_search_options',
    ].some((field) => body[field] !== undefined)
  )
    return false;
  return (
    Array.isArray(body['messages']) &&
    body['messages'].length > 0 &&
    body['messages'].every(
      (message: unknown) =>
        record(message) &&
        Object.keys(message).every((field) => ['role', 'content', 'name'].includes(field)) &&
        ['system', 'developer', 'user', 'assistant'].includes(String(message['role'])) &&
        typeof message['content'] === 'string' &&
        message['tool_calls'] === undefined &&
        message['function_call'] === undefined,
    )
  );
}

function cacheableResponse(body: unknown): boolean {
  return (
    record(body) &&
    body['object'] === 'chat.completion' &&
    Array.isArray(body['choices']) &&
    body['choices'].length > 0 &&
    body['choices'].every(
      (choice: unknown) =>
        record(choice) &&
        choice['finish_reason'] === 'stop' &&
        record(choice['message']) &&
        choice['message']['role'] === 'assistant' &&
        typeof choice['message']['content'] === 'string' &&
        choice['message']['content'].length > 0 &&
        choice['message']['tool_calls'] === undefined &&
        choice['message']['function_call'] === undefined &&
        choice['message']['audio'] === undefined &&
        choice['message']['refusal'] == null,
    )
  );
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('cache key depth exceeded');
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('non-JSON cache input');
  return encoded;
}

/** Preserve all request fields and exact text; never normalize timestamps or user identity. */
export function responseCacheKey(
  scope: Readonly<Record<string, unknown>>,
  body: unknown,
): string | null {
  try {
    return createHash('sha256').update(canonical({ scope, body })).digest('hex');
  } catch {
    // Unsupported/deep input goes through the normal runtime, never through an approximate key.
    return null;
  }
}

/** Bounded process memory only. This is never an idempotency or financial authority. */
export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  public get(key: string): CachedResponse | undefined {
    this.expire();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      ok: true,
      outcome: 'CachedResponse',
      idempotencyKey: entry.idempotencyKey,
      body: JSON.parse(entry.json) as unknown,
      chargedAtomic: '0',
      cache: {
        sourceReceiptId: entry.sourceReceiptId,
        ageMs: Math.max(0, Math.floor(performance.now() - entry.createdMonotonic)),
        expiresAt: entry.expiresAt,
      },
    };
  }

  public put(key: string, result: BuyerResult, sessionExpiresAt: number): void {
    if (
      this.closed ||
      !Number.isSafeInteger(sessionExpiresAt) ||
      !result.ok ||
      !cacheableResponse(result.body)
    )
      return;
    const createdAt = Date.now();
    const createdMonotonic = performance.now();
    const expiresAt = Math.min(createdAt + RESPONSE_CACHE_TTL_MS, sessionExpiresAt);
    if (expiresAt <= createdAt) return;
    const json = JSON.stringify(result.body);
    const bodyBytes = Buffer.byteLength(json, 'utf8');
    if (bodyBytes > RESPONSE_CACHE_MAX_ITEM_BYTES) return;
    const bytes =
      bodyBytes + Buffer.byteLength(key + result.receipt.id + result.idempotencyKey, 'utf8');
    if (bytes > RESPONSE_CACHE_MAX_BYTES) return;
    this.expire();
    this.remove(key);
    while (
      this.entries.size >= RESPONSE_CACHE_MAX_ENTRIES ||
      this.bytes + bytes > RESPONSE_CACHE_MAX_BYTES
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, {
      json,
      sourceReceiptId: result.receipt.id,
      idempotencyKey: result.idempotencyKey,
      createdAt,
      expiresAt,
      createdMonotonic,
      expiresMonotonic: createdMonotonic + (expiresAt - createdAt),
      bytes,
    });
    this.bytes += bytes;
    this.scheduleExpiry();
  }

  public clear(): void {
    this.entries.clear();
    this.bytes = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  public close(): void {
    this.closed = true;
    this.clear();
  }

  public invalidate(key: string): void {
    this.remove(key);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  private expire(): void {
    const now = Date.now();
    const monotonic = performance.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now || entry.createdAt > now || entry.expiresMonotonic <= monotonic)
        this.remove(key);
    }
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.size === 0) return;
    const next = Math.min(...Array.from(this.entries.values(), (entry) => entry.expiresMonotonic));
    this.timer = setTimeout(
      () => {
        this.expire();
        this.scheduleExpiry();
      },
      Math.max(1, next - performance.now()),
    );
    this.timer.unref();
  }
}
