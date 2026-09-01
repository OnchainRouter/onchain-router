import { randomUUID } from 'node:crypto';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { SettleResponse } from '@x402/core/types';
import {
  asBuyerRuntimeError,
  BuyerRuntimeError,
  IdempotencyConflict,
  InsufficientFunds,
  PaymentVerificationRejected,
  ProviderOutcomeUnknown,
  ReceiptVerificationFailed,
  ResultRecoveryExpired,
  RuntimeUnavailable,
  SettlementOutcomeUnknown,
} from './errors.js';
import { canonicalHash, canonicalJson } from './canonical.js';
import type { LocalSpendLedger } from './ledger.js';
import { validatePaymentRequirement } from './policy.js';
import { verifyReceipt } from './receipt.js';
import type {
  BuyerFailure,
  BuyerRequest,
  BuyerResult,
  EffectiveBuyerPolicy,
  PaymentAuthorizer,
  PaymentConfirmation,
  ValidatedPaymentRequirement,
  VerifiedReceipt,
} from './types.js';

export interface BuyerRuntimeOptions {
  readonly ledger: LocalSpendLedger;
  readonly authorizer: PaymentAuthorizer;
  readonly fetch?: typeof fetch;
  readonly receiptAttempts?: number;
  readonly confirmPayment?: (confirmation: PaymentConfirmation) => Promise<boolean>;
}

interface ParsedResponse {
  readonly body: unknown;
  readonly errorCode: string | null;
  readonly traceId: string | null;
}

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = new Set([
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'x-quote-token',
]);

function requestHeaders(input?: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalized = name.toLowerCase();
    if (!FORWARDED_HEADERS.has(normalized))
      throw new BuyerRuntimeError(
        'PaymentPolicyRejected',
        'do_not_retry',
        `request header is not permitted: ${normalized}`,
      );
    headers.set(normalized, value);
  }
  return headers;
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maximumBytes))
    throw new RuntimeUnavailable('response exceeds the local size limit');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RuntimeUnavailable('response exceeds the local size limit');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safeErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return /^[A-Za-z0-9_.-]{1,160}$/.test(error) ? error : null;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(code) ? code : null;
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  let body: unknown = null;
  if (response.status !== 204) {
    const bytes = await readBounded(response, MAX_RESULT_BYTES);
    if (contentType.includes('json')) {
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        body = null;
      }
    } else {
      body = { contentType, bytes };
    }
  }
  return {
    body,
    errorCode: safeErrorCode(body),
    traceId: response.headers.get('x-trace-id') ?? response.headers.get('x-request-id'),
  };
}

function failure(error: BuyerRuntimeError, idempotencyKey: string): BuyerFailure {
  return {
    ok: false,
    outcome: error.code,
    retry: error.retry,
    idempotencyKey,
    message: error.message,
    ...(error.reference ? { reference: error.reference } : {}),
  };
}

function mapKnownFailure(status: number, parsed: ParsedResponse): BuyerRuntimeError {
  const code = parsed.errorCode ?? 'unknown';
  if (['insufficient_funds', 'insufficient_balance', 'payer_insufficient_balance'].includes(code))
    return new InsufficientFunds(code, parsed.traceId ?? undefined);
  if (status === 409) {
    if (code === 'response_recovery_expired')
      return new ResultRecoveryExpired(code, parsed.traceId ?? undefined);
    return new IdempotencyConflict(code, parsed.traceId ?? undefined);
  }
  if (status === 402) return new PaymentVerificationRejected(code, parsed.traceId ?? undefined);
  if (code === 'provider_outcome_unknown')
    return new ProviderOutcomeUnknown(code, parsed.traceId ?? undefined);
  if (code === 'settlement_or_receipt_unknown')
    return new SettlementOutcomeUnknown(code, parsed.traceId ?? undefined);
  if (status === 502) return new PaymentVerificationRejected(code, parsed.traceId ?? undefined);
  if (status >= 500) return new RuntimeUnavailable(code, parsed.traceId ?? undefined);
  return new PaymentVerificationRejected(code, parsed.traceId ?? undefined);
}

export class BuyerRuntime {
  private readonly fetch: typeof fetch;
  private readonly receiptAttempts: number;

  public constructor(private readonly options: BuyerRuntimeOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.receiptAttempts = options.receiptAttempts ?? 3;
    if (
      !Number.isInteger(this.receiptAttempts) ||
      this.receiptAttempts < 1 ||
      this.receiptAttempts > 5
    )
      throw new ReceiptVerificationFailed('receipt attempt count must be between one and five');
  }

  public async execute(request: BuyerRequest): Promise<BuyerResult> {
    const idempotencyKey = request.idempotencyKey ?? randomUUID();
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey))
        throw new IdempotencyConflict('idempotency key is invalid');
      if (
        typeof request.body !== 'object' ||
        request.body === null ||
        (request.body as { model?: unknown }).model !== request.model
      )
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'request model must exactly match body.model',
        );
      const policy = this.options.ledger.currentPolicy();
      if (!policy.models.includes(request.model))
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'model is outside the approved policy',
        );
      for (const field of ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const) {
        const value = (request.body as Record<string, unknown>)[field];
        if (
          value !== undefined &&
          (!Number.isSafeInteger(value) ||
            Number(value) <= 0 ||
            Number(value) > policy.maximumOutputTokens)
        )
          throw new BuyerRuntimeError(
            'PaymentPolicyRejected',
            'do_not_retry',
            `${field} exceeds the local output-token policy`,
          );
      }
      const requestUrl = new URL(request.url).toString();
      if (new URL(requestUrl).origin !== policy.canonicalOrigin)
        throw new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'request origin is outside the approved policy',
        );
      const serializedBody = canonicalJson(request.body);
      const requestHash = canonicalHash({
        method: 'POST',
        url: requestUrl,
        body: request.body,
        model: request.model,
      });
      const headers = requestHeaders(request.headers);
      headers.set('content-type', 'application/json');
      headers.set('x-idempotency-key', idempotencyKey);
      headers.delete('payment-signature');
      headers.delete('x-payment');

      const initial = await this.fetch(requestUrl, {
        method: 'POST',
        headers,
        body: serializedBody,
        redirect: 'error',
      });
      if (initial.status !== 402)
        return await this.handleNonChallenge(
          initial,
          idempotencyKey,
          requestHash,
          request.model,
          null,
        );

      const requiredHeader = initial.headers.get('payment-required');
      if (!requiredHeader)
        throw new PaymentVerificationRejected('402 response omitted PAYMENT-REQUIRED');
      let declaration: unknown;
      try {
        declaration = decodePaymentRequiredHeader(requiredHeader);
      } catch {
        throw new PaymentVerificationRejected('PAYMENT-REQUIRED is malformed');
      }
      const validated = validatePaymentRequirement(declaration, policy, requestUrl, request.model);
      if (policy.requirePerCallConfirmation) {
        const confirmed = await this.options.confirmPayment?.({
          origin: policy.canonicalOrigin,
          model: request.model,
          network: validated.requirement.network,
          asset: validated.requirement.asset,
          recipient: validated.requirement.payTo,
          maximumAtomic: validated.amountAtomic.toString(),
        });
        if (confirmed !== true)
          throw new BuyerRuntimeError(
            'PaymentPolicyRejected',
            'do_not_retry',
            'payment was not confirmed by the human policy callback',
          );
      }
      this.options.ledger.reserve({
        idempotencyKey,
        requestHash,
        requirementHash: validated.requirementHash,
        model: request.model,
        agentId: this.options.authorizer.agentId,
        sessionId: this.options.authorizer.sessionId,
        maximumAtomic: validated.amountAtomic,
        now: Date.now(),
      });
      const paymentPayload = await this.options.authorizer.authorize({
        paymentRequired: validated.paymentRequired,
        requestUrl,
        model: request.model,
        idempotencyKey,
        requestHash,
        requirementHash: validated.requirementHash,
        agentId: this.options.authorizer.agentId,
        sessionId: this.options.authorizer.sessionId,
      });
      const paidHeaders = new Headers(headers);
      paidHeaders.set('payment-signature', encodePaymentSignatureHeader(paymentPayload));
      let paid: Response;
      try {
        paid = await this.fetch(requestUrl, {
          method: 'POST',
          headers: paidHeaders,
          body: serializedBody,
          redirect: 'error',
        });
      } catch {
        this.options.ledger.markUnknown(idempotencyKey);
        throw new SettlementOutcomeUnknown('paid request outcome is unknown');
      }
      return await this.handlePaidResponse(paid, idempotencyKey, request.model, validated);
    } catch (error) {
      return failure(asBuyerRuntimeError(error), idempotencyKey);
    }
  }

  private async handleNonChallenge(
    response: Response,
    idempotencyKey: string,
    requestHash: string,
    model: string,
    validated: ValidatedPaymentRequirement | null,
  ): Promise<BuyerResult> {
    if (!response.ok) {
      const parsed = await parseResponse(response);
      throw mapKnownFailure(response.status, parsed);
    }
    const operation = this.options.ledger.get(idempotencyKey);
    if (!operation && !validated)
      throw new ReceiptVerificationFailed('unexpected success without a local operation');
    if (operation && (operation.requestHash !== requestHash || operation.model !== model))
      throw new IdempotencyConflict('recovered response does not match the local request');
    const maximumAtomic = validated?.amountAtomic ?? operation?.maximumAtomic;
    if (maximumAtomic === undefined)
      throw new ReceiptVerificationFailed('local authorization maximum is missing');
    return await this.completeSuccess(
      response,
      idempotencyKey,
      model,
      maximumAtomic,
      validated,
      true,
    );
  }

  private async handlePaidResponse(
    response: Response,
    idempotencyKey: string,
    model: string,
    validated: ValidatedPaymentRequirement,
  ): Promise<BuyerResult> {
    if (!response.ok) {
      let parsed: ParsedResponse;
      try {
        parsed = await parseResponse(response);
      } catch (error) {
        this.options.ledger.markUnknown(idempotencyKey);
        throw error;
      }
      const mapped = mapKnownFailure(response.status, parsed);
      if (
        mapped.code === 'ProviderOutcomeUnknown' ||
        mapped.code === 'SettlementOutcomeUnknown' ||
        mapped.code === 'ReceiptVerificationFailed'
      )
        this.options.ledger.markUnknown(idempotencyKey);
      else this.options.ledger.releaseDefiniteFailure(idempotencyKey);
      throw mapped;
    }
    try {
      return await this.completeSuccess(
        response,
        idempotencyKey,
        model,
        validated.amountAtomic,
        validated,
        response.headers.get('x-recovered-response') === 'true',
      );
    } catch (error) {
      this.options.ledger.markUnknown(idempotencyKey);
      throw error;
    }
  }

  private async completeSuccess(
    response: Response,
    idempotencyKey: string,
    model: string,
    maximumAtomic: bigint,
    validated: ValidatedPaymentRequirement | null,
    recovered: boolean,
  ): Promise<BuyerResult> {
    const operationPolicy = this.options.ledger.policyForOperation(idempotencyKey);
    const parsed = await parseResponse(response);
    let settlement: SettleResponse | null = null;
    const settlementHeader = response.headers.get('payment-response');
    if (!settlementHeader && !recovered) {
      this.options.ledger.markUnknown(idempotencyKey);
      throw new ReceiptVerificationFailed('successful paid response omitted PAYMENT-RESPONSE');
    }
    if (settlementHeader) {
      try {
        settlement = decodePaymentResponseHeader(settlementHeader);
      } catch {
        this.options.ledger.markUnknown(idempotencyKey);
        throw new ReceiptVerificationFailed('PAYMENT-RESPONSE is malformed');
      }
      if (
        !settlement.success ||
        settlement.network !== operationPolicy.network ||
        !settlement.payer ||
        settlement.payer.toLowerCase() !== this.options.authorizer.address.toLowerCase() ||
        !settlement.amount ||
        !/^\d+$/.test(settlement.amount) ||
        BigInt(settlement.amount) > maximumAtomic
      )
        throw new ReceiptVerificationFailed(
          'PAYMENT-RESPONSE does not confirm the expected payment',
        );
    }
    const receiptId = response.headers.get('x-receipt-id');
    const receiptToken = response.headers.get('x-receipt-token');
    if (!receiptId || !receiptToken) {
      this.options.ledger.markUnknown(idempotencyKey);
      throw new ReceiptVerificationFailed('successful response omitted receipt access');
    }
    let receipt: VerifiedReceipt;
    try {
      receipt = await this.retrieveReceipt(receiptId, receiptToken, {
        model,
        maximumAtomic,
        settlement,
        policy: operationPolicy,
      });
      this.options.ledger.commitSpent(idempotencyKey, BigInt(receipt.actualAmount), receipt);
    } catch (error) {
      this.options.ledger.markUnknown(idempotencyKey);
      throw error;
    }
    return {
      ok: true,
      outcome: recovered ? 'RecoveredSuccess' : 'Completed',
      idempotencyKey,
      body: parsed.body,
      receipt,
      payment: {
        network: receipt.settlement.network,
        asset: validated?.requirement.asset ?? operationPolicy.asset,
        recipient: validated?.requirement.payTo ?? operationPolicy.recipients[0] ?? '',
        authorizedMaximumAtomic: receipt.maximumAmount,
        actualAtomic: receipt.actualAmount,
        transaction: receipt.settlement.transaction,
      },
    };
  }

  private async retrieveReceipt(
    receiptId: string,
    receiptToken: string,
    expected: {
      readonly model: string;
      readonly maximumAtomic: bigint;
      readonly settlement: SettleResponse | null;
      readonly policy: EffectiveBuyerPolicy;
    },
  ): Promise<VerifiedReceipt> {
    const receiptUrl = `${expected.policy.canonicalOrigin}/v1/receipts/${encodeURIComponent(receiptId)}`;
    for (let attempt = 1; attempt <= this.receiptAttempts; attempt += 1) {
      try {
        const response = await this.fetch(receiptUrl, {
          method: 'GET',
          headers: { 'x-receipt-token': receiptToken },
          redirect: 'error',
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 404) break;
          continue;
        }
        const bytes = await readBounded(response, MAX_RECEIPT_BYTES);
        const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        return verifyReceipt(body, {
          id: receiptId,
          model: expected.model,
          payer: this.options.authorizer.address,
          maximumAtomic: expected.maximumAtomic,
          policy: expected.policy,
          ...(expected.settlement?.amount
            ? { settlementAmountAtomic: BigInt(expected.settlement.amount) }
            : {}),
          ...(expected.settlement?.transaction
            ? { settlementTransaction: expected.settlement.transaction }
            : {}),
        });
      } catch (error) {
        if (error instanceof ReceiptVerificationFailed) throw error;
      }
    }
    throw new ReceiptVerificationFailed('durable receipt could not be verified');
  }
}
