import {
  PaymentPolicyRejected,
  SettlementOutcomeUnknown,
  type BuyerResult,
  type VerifiedReceipt,
} from '@onchainrouter/buyer-core';
import {
  OnchainRouterBuyer,
  inspectBuyerCatalog,
  inspectBuyerProfile,
  readBuyerReceipt,
  type BuyerCatalogInspection,
  type BuyerProfileInspection,
  type OnchainRouterBuyerOptions,
  type PaidJsonEndpoint,
  OnchainRouterDiscovery,
} from '@onchainrouter/client';
import { chatBody, type ChatToolInput } from './contracts.js';

export interface FocusedMcpService {
  models(): Promise<BuyerCatalogInspection>;
  chat(input: ChatToolInput, signal: AbortSignal): Promise<BuyerResult>;
  wallet(): Promise<BuyerProfileInspection>;
  receipt(idempotencyKey: string): Promise<VerifiedReceipt | null>;
  execute?(
    endpoint: PaidJsonEndpoint,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<BuyerResult>;
  voices?(): Promise<Record<string, unknown>>;
}

interface ConnectedBuyer {
  chat(body: Readonly<Record<string, unknown>>, idempotencyKey?: string): Promise<BuyerResult>;
  close(): void;
  execute?(
    endpoint: PaidJsonEndpoint,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<BuyerResult>;
}

export interface FocusedMcpServiceDependencies {
  readonly connectBuyer?: (options: OnchainRouterBuyerOptions) => Promise<ConnectedBuyer>;
  readonly inspectCatalog?: (options: OnchainRouterBuyerOptions) => Promise<BuyerCatalogInspection>;
  readonly inspectProfile?: (
    options: OnchainRouterBuyerOptions & { includeBalance?: boolean },
  ) => Promise<BuyerProfileInspection>;
  readonly readReceipt?: (
    idempotencyKey: string,
    options: Pick<OnchainRouterBuyerOptions, 'profileDirectory'>,
  ) => VerifiedReceipt | null;
}

export interface CreateFocusedMcpServiceOptions extends OnchainRouterBuyerOptions {
  readonly dependencies?: FocusedMcpServiceDependencies;
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new PaymentPolicyRejected('request was cancelled before financial handoff');
}

/** Thin MCP-facing adapter. All financial behavior stays inside Buyer Runtime. */
export function createFocusedMcpService(
  options: CreateFocusedMcpServiceOptions = {},
): FocusedMcpService {
  const dependencies = options.dependencies ?? {};
  const buyerOptions: OnchainRouterBuyerOptions = {
    ...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.receiptAttempts ? { receiptAttempts: options.receiptAttempts } : {}),
  };
  const connectBuyer =
    dependencies.connectBuyer ??
    (async (clientOptions: OnchainRouterBuyerOptions) =>
      await OnchainRouterBuyer.connect(clientOptions));
  const catalog = dependencies.inspectCatalog ?? inspectBuyerCatalog;
  const profile = dependencies.inspectProfile ?? inspectBuyerProfile;
  const receipt = dependencies.readReceipt ?? readBuyerReceipt;

  return {
    async voices() {
      const inspected = await catalog(buyerOptions);
      return await new OnchainRouterDiscovery(inspected.policy.canonicalOrigin, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }).voices();
    },
    async execute(endpoint, body, idempotencyKey, signal) {
      assertNotCancelled(signal);
      const buyer = await connectBuyer(buyerOptions);
      let handedOff = false;
      try {
        assertNotCancelled(signal);
        if (!buyer.execute) throw new PaymentPolicyRejected('media adapter is unavailable');
        handedOff = true;
        return await buyer.execute(endpoint, body, idempotencyKey);
      } catch (error) {
        if (handedOff && !(error instanceof PaymentPolicyRejected))
          throw new SettlementOutcomeUnknown('buyer runtime outcome is unknown after handoff');
        throw error;
      } finally {
        try {
          buyer.close();
        } catch {
          /* Preserve the durable typed outcome. */
        }
      }
    },
    async models() {
      return await catalog(buyerOptions);
    },
    async chat(input, signal) {
      assertNotCancelled(signal);
      const buyer = await connectBuyer(buyerOptions);
      let handedOff = false;
      try {
        // Cancellation is honored until the financially significant runtime handoff.
        // Once execute starts, Buyer Runtime must finish or recover the durable outcome.
        assertNotCancelled(signal);
        const body = chatBody(input);
        handedOff = true;
        return await buyer.chat(body, input.idempotency_key);
      } catch (error) {
        if (handedOff && !(error instanceof PaymentPolicyRejected))
          throw new SettlementOutcomeUnknown('buyer runtime outcome is unknown after handoff');
        throw error;
      } finally {
        try {
          buyer.close();
        } catch {
          /* Preserve the durable typed outcome. */
        }
      }
    },
    async wallet() {
      return await profile({ ...buyerOptions, includeBalance: true });
    },
    receipt(idempotencyKey) {
      return Promise.resolve(
        receipt(idempotencyKey, {
          ...(buyerOptions.profileDirectory
            ? { profileDirectory: buyerOptions.profileDirectory }
            : {}),
        }),
      );
    },
  };
}
