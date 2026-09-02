import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  PAID_JSON_ENDPOINTS,
  MEDIA_ENDPOINTS,
  MAX_MEDIA_JSON_BYTES,
  prepareMediaBody,
  type MediaEndpoint,
  type PaidJsonEndpoint,
} from '@agenticfi/onchain-router';
import {
  BuyerRuntimeError,
  PaymentPolicyRejected,
  type BuyerFailure,
} from '@agenticfi/onchain-router-buyer-core';
import {
  MAX_PROXY_CHAT_BODY_BYTES,
  PROXY_HOST,
  parseChatBody,
  parseCacheRequest,
  parseIdempotencyKey,
} from './contracts.js';
import {
  createBuyerProxyService,
  type BuyerProxyService,
  type ProxyChatResult,
} from './service.js';

const REQUEST_BODY_TIMEOUT_MS = 15_000;
const ALLOWED_REQUEST_HEADERS = 64;

class HttpProblem extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly closeConnection = true,
  ) {
    super(message);
  }
}

export interface CreateBuyerProxyServerOptions {
  readonly token: string;
  readonly service?: BuyerProxyService;
  readonly profileDirectory?: string;
  readonly cacheEnabled?: boolean;
}

export interface StartBuyerProxyOptions extends CreateBuyerProxyServerOptions {
  readonly port: number;
}

export interface StartedBuyerProxy {
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
  required = false,
): string | undefined {
  const count = rawHeaderCount(request, name);
  if (count > 1) throw new HttpProblem(400, 'duplicate_header', `duplicate ${name} header`);
  const value = request.headers[name];
  if (Array.isArray(value))
    throw new HttpProblem(400, 'duplicate_header', `duplicate ${name} header`);
  if (required && !value)
    throw new HttpProblem(400, 'missing_header', `${name} header is required`);
  return value;
}

function isLoopbackRemote(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function expectedHost(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== PROXY_HOST)
    throw new HttpProblem(503, 'proxy_not_ready', 'local buyer proxy is not ready');
  return `${PROXY_HOST}:${address.port}`;
}

function authenticate(request: IncomingMessage, expectedDigest: Buffer): void {
  const authorization = singleHeader(request, 'authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  const actual = tokenDigest(match?.[1] ?? 'invalid');
  if (!match || actual.length !== expectedDigest.length || !timingSafeEqual(actual, expectedDigest))
    throw new HttpProblem(401, 'invalid_local_bearer', 'local bearer authentication failed');
}

function browserBoundary(request: IncomingMessage): void {
  if (
    singleHeader(request, 'origin') !== undefined ||
    singleHeader(request, 'cookie') !== undefined
  )
    throw new HttpProblem(403, 'browser_access_forbidden', 'browser access is not allowed');
}

function validateRequestTarget(request: IncomingMessage, server: Server): string {
  if (!isLoopbackRemote(request.socket.remoteAddress))
    throw new HttpProblem(403, 'loopback_required', 'loopback access is required');
  const host = singleHeader(request, 'host', true);
  if (host !== expectedHost(server))
    throw new HttpProblem(400, 'invalid_host', 'request host does not match the loopback listener');
  const target = request.url;
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('\\'))
    throw new HttpProblem(400, 'invalid_request_target', 'request target is invalid');
  return target;
}

function applyResponseHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-request-id', requestId);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  applyResponseHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader('content-length', Buffer.byteLength(body, 'utf8'));
  for (const [name, headerValue] of Object.entries(headers)) response.setHeader(name, headerValue);
  response.end(body);
}

function errorBody(code: string, message: string, retry: string, reference?: string) {
  return {
    error: { message, type: 'onchain_router_error', param: null, code },
    onchain_router: {
      outcome: code,
      retry,
      ...(reference ? { reference } : {}),
    },
  };
}

function failureStatus(failure: BuyerFailure): number {
  switch (failure.outcome) {
    case 'PaymentPolicyRejected':
    case 'UnsupportedNetwork':
    case 'UnexpectedAsset':
    case 'UnexpectedRecipient':
      return 400;
    case 'AuthorizationAboveLocalCap':
    case 'InsufficientFunds':
    case 'Permit2ApprovalRequired':
    case 'PaymentVerificationRejected':
      return 402;
    case 'ProviderOutcomeUnknown':
    case 'SettlementOutcomeUnknown':
    case 'Permit2ApprovalOutcomeUnknown':
    case 'IdempotencyConflict':
    case 'ReceiptVerificationFailed':
      return 409;
    case 'ResultRecoveryExpired':
      return 410;
    case 'WalletLocked':
      return 423;
    case 'RuntimeUnavailable':
      return 503;
  }
}

function writeBuyerResult(
  response: ServerResponse,
  result: ProxyChatResult,
  requestId: string,
): void {
  const commonHeaders = {
    'x-onchain-router-idempotency-key': result.idempotencyKey,
    'x-onchain-router-outcome': result.outcome,
  };
  if (result.outcome === 'CachedResponse') {
    writeJson(response, 200, result.body, requestId, {
      ...commonHeaders,
      'x-onchain-router-cache': 'HIT',
      'x-onchain-router-charge-atomic': result.chargedAtomic,
      'x-onchain-router-source-receipt-id': result.cache.sourceReceiptId,
      'x-onchain-router-cache-age-ms': String(result.cache.ageMs),
      'x-onchain-router-cache-expires-at': String(result.cache.expiresAt),
    });
    return;
  }
  response.setHeader('x-onchain-router-cache', result.cacheStatus ?? 'BYPASS');
  if (!result.ok) {
    writeJson(
      response,
      failureStatus(result),
      errorBody(result.outcome, result.message, result.retry, result.reference),
      requestId,
      {
        ...commonHeaders,
        'x-onchain-router-retry': result.retry,
        'x-should-retry': 'false',
      },
    );
    return;
  }
  writeJson(response, 200, result.body, requestId, {
    ...commonHeaders,
    'x-receipt-id': result.receipt.id,
    'x-payment-network': result.payment.network,
    'x-payment-maximum-atomic': result.payment.authorizedMaximumAtomic,
    'x-payment-actual-atomic': result.payment.actualAtomic,
    'x-payment-transaction': result.payment.transaction,
  });
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_PROXY_CHAT_BODY_BYTES,
): Promise<unknown> {
  if (singleHeader(request, 'content-encoding') !== undefined)
    throw new HttpProblem(
      415,
      'content_encoding_forbidden',
      'encoded request bodies are not allowed',
    );
  const contentType = singleHeader(request, 'content-type', true)
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw new HttpProblem(415, 'unsupported_media_type', 'content-type must be application/json');
  if (singleHeader(request, 'transfer-encoding') && singleHeader(request, 'content-length'))
    throw new HttpProblem(400, 'ambiguous_body_length', 'request body length is ambiguous', true);
  const declared = singleHeader(request, 'content-length');
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximumBytes))
  )
    throw new HttpProblem(
      413,
      'request_too_large',
      'chat request exceeds the local body-size limit',
      true,
    );

  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        request.pause();
        finish(
          new HttpProblem(
            413,
            'request_too_large',
            'chat request exceeds the local body-size limit',
            true,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (total === 0) {
        finish(new HttpProblem(400, 'empty_body', 'chat request body is empty'));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown);
      } catch {
        finish(new HttpProblem(400, 'invalid_json', 'chat request body is malformed'));
      }
    };
    const onAborted = () => finish(new HttpProblem(400, 'request_aborted', 'request was aborted'));
    const onError = () =>
      finish(new HttpProblem(400, 'request_failed', 'request body could not be read'));
    const timer = setTimeout(
      () => finish(new HttpProblem(408, 'request_timeout', 'request body timed out', true)),
      REQUEST_BODY_TIMEOUT_MS,
    );
    timer.unref();
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
  });
}

function idempotencyHeader(request: IncomingMessage): string | undefined {
  const standard = singleHeader(request, 'idempotency-key');
  const serverCompatible = singleHeader(request, 'x-idempotency-key');
  if (standard && serverCompatible)
    throw new HttpProblem(400, 'ambiguous_idempotency_key', 'provide only one idempotency header');
  try {
    return parseIdempotencyKey(standard ?? serverCompatible);
  } catch (error) {
    if (error instanceof BuyerRuntimeError)
      throw new HttpProblem(400, 'invalid_idempotency_key', error.message);
    throw error;
  }
}

function asBuyerFailure(error: BuyerRuntimeError, idempotencyKey: string): BuyerFailure {
  return {
    ok: false,
    outcome: error.code,
    retry: error.retry,
    idempotencyKey,
    message: error.message,
    ...(error.reference ? { reference: error.reference } : {}),
  };
}

function handler(server: Server, options: CreateBuyerProxyServerOptions) {
  const service =
    options.service ??
    createBuyerProxyService({
      ...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
      ...(options.cacheEnabled === undefined ? {} : { cacheEnabled: options.cacheEnabled }),
    });
  server.once('close', () => service.close?.());
  const expectedDigest = tokenDigest(options.token);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    let closeConnection = false;
    let idempotencyKey: string = randomUUID();
    const cancellation = new AbortController();
    const onAborted = () => cancellation.abort('HTTP client disconnected');
    request.once('aborted', onAborted);
    response.once('close', () => {
      if (!response.writableEnded) cancellation.abort('HTTP client disconnected');
    });
    try {
      const target = validateRequestTarget(request, server);
      browserBoundary(request);
      authenticate(request, expectedDigest);
      if (request.method === 'OPTIONS')
        throw new HttpProblem(405, 'method_not_allowed', 'method is not allowed');
      if (target === '/v1/models') {
        if (request.method !== 'GET')
          throw new HttpProblem(405, 'method_not_allowed', 'method is not allowed');
        writeJson(response, 200, await service.models(cancellation.signal), requestId);
        return;
      }
      if (target === '/v1/pricing' || target === '/v1/audio/voices') {
        if (request.method !== 'GET')
          throw new HttpProblem(405, 'method_not_allowed', 'method is not allowed');
        if (!service.discovery)
          throw new HttpProblem(503, 'discovery_unavailable', 'discovery is unavailable');
        writeJson(response, 200, await service.discovery(target, cancellation.signal), requestId);
        return;
      }
      if (!PAID_JSON_ENDPOINTS.includes(target as PaidJsonEndpoint))
        throw new HttpProblem(404, 'not_found', 'endpoint was not found');
      if (request.method !== 'POST')
        throw new HttpProblem(405, 'method_not_allowed', 'method is not allowed');
      const suppliedKey = idempotencyHeader(request);
      idempotencyKey = suppliedKey ?? idempotencyKey;
      if (target !== '/v1/chat/completions') {
        const raw = await readJsonBody(
          request,
          target === '/v1/audio/transcriptions' ? MAX_MEDIA_JSON_BYTES : MAX_PROXY_CHAT_BODY_BYTES,
        );
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new PaymentPolicyRejected('request body must be a JSON object');
        const body = raw as Record<string, unknown>;
        if (MEDIA_ENDPOINTS.includes(target as MediaEndpoint))
          prepareMediaBody(target as MediaEndpoint, body);
        else parseChatBody(body);
        if (!service.execute)
          throw new HttpProblem(503, 'adapter_unavailable', 'capability adapter is unavailable');
        writeBuyerResult(
          response,
          await service.execute(
            target as PaidJsonEndpoint,
            body,
            idempotencyKey,
            cancellation.signal,
          ),
          requestId,
        );
        return;
      }
      const cacheHeader = singleHeader(request, 'cache-control');
      let body: Readonly<Record<string, unknown>>;
      let cacheMode: ReturnType<typeof parseCacheRequest>['cacheMode'];
      try {
        ({ body, cacheMode } = parseCacheRequest(
          parseChatBody(await readJsonBody(request)),
          cacheHeader,
        ));
      } catch (error) {
        if (error instanceof BuyerRuntimeError)
          throw new HttpProblem(400, 'invalid_chat_request', error.message);
        throw error;
      }
      const result = await service.chat(body, idempotencyKey, cancellation.signal, {
        cacheMode,
        callerSuppliedIdempotencyKey: suppliedKey !== undefined,
      });
      writeBuyerResult(response, result, requestId);
    } catch (error) {
      if (error instanceof HttpProblem) {
        closeConnection = error.closeConnection;
        writeJson(
          response,
          error.status,
          errorBody(error.code, error.message, 'do_not_retry'),
          requestId,
          {
            ...(error.status === 401
              ? { 'www-authenticate': 'Bearer realm="onchain-router-proxy"' }
              : {}),
            ...(closeConnection ? { connection: 'close' } : {}),
            'x-should-retry': 'false',
          },
        );
      } else if (error instanceof BuyerRuntimeError) {
        writeBuyerResult(response, asBuyerFailure(error, idempotencyKey), requestId);
      } else {
        writeJson(
          response,
          500,
          errorBody(
            'ProxyInternalError',
            'local buyer proxy encountered an internal error',
            'human_review',
          ),
          requestId,
          { 'x-onchain-router-retry': 'human_review', 'x-should-retry': 'false' },
        );
      }
    } finally {
      request.off('aborted', onAborted);
      if (closeConnection) {
        response.once('finish', () => request.socket.destroy());
      }
    }
  };
}

function rejectMalformedClient(_error: Error, socket: Socket): void {
  if (socket.writable)
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

export function createBuyerProxyServer(options: CreateBuyerProxyServerOptions): Server {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.token))
    throw new PaymentPolicyRejected('proxy bearer must contain 256 bits of base64url entropy');
  const server = createServer();
  server.maxHeadersCount = ALLOWED_REQUEST_HEADERS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  const handle = handler(server, options);
  server.on('request', (request, response) => {
    void handle(request, response);
  });
  server.on('checkContinue', (_request, response) => {
    writeJson(
      response,
      417,
      errorBody('expectation_failed', 'request expectations are not supported', 'do_not_retry'),
      randomUUID(),
      { connection: 'close', 'x-should-retry': 'false' },
    );
  });
  server.on('clientError', rejectMalformedClient);
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

export async function startBuyerProxy(options: StartBuyerProxyOptions): Promise<StartedBuyerProxy> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
    throw new PaymentPolicyRejected('proxy port is invalid');
  const server = createBuyerProxyServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, PROXY_HOST);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== PROXY_HOST) {
    server.close();
    throw new PaymentPolicyRejected('proxy failed to bind exclusively to IPv4 loopback');
  }
  return {
    server,
    origin: `http://${PROXY_HOST}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
