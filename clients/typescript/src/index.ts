import { randomUUID } from 'node:crypto';

export {
  MEDIA_ENDPOINTS,
  MAX_AUDIO_INPUT_BYTES,
  MAX_MEDIA_JSON_BYTES,
  STT_RETENTION_NOTICE,
  prepareMediaBody,
  validateMediaCatalog,
  type MediaEndpoint,
  type ImageRequest,
  type SpeechRequest,
  type TranscriptionRequest,
} from './media.js';

export {
  formatRoutingReceiptEvidence,
  OnchainRouterBuyer,
  PAID_JSON_ENDPOINTS,
  ROUTING_RECEIPT_EVIDENCE_VERSION,
  type BuyerStatus,
  type OnchainRouterBuyerOptions,
  type PaidJsonEndpoint,
  type RoutedBuyerResult,
  type RoutedChatOptions,
  type RoutingReceiptEvidence,
} from './buyer.js';
export {
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  OnchainRouterDiscovery,
  type BuyerPaymentContract,
  type BuyerRequestQuote,
  type ModelCatalog,
  type PricingCatalog,
  type WalletBalance,
} from './discovery.js';
export { BUYER_PROFILE_VERSION, buyerProfilePaths, type BuyerProfilePaths } from './profile.js';
export {
  inspectBuyerCatalog,
  inspectBuyerProfile,
  readBuyerReceipt,
  serializeBuyerPolicy,
  type BuyerCatalogInspection,
  type BuyerProfileInspection,
  type InspectBuyerProfileOptions,
  type SerializedBuyerPolicy,
} from './local.js';
export {
  ROUTING_POLICY_VERSION,
  ROUTING_PORT_VERSION,
  RoutingRejected,
  type RankedRoute,
  type RouteDecision,
  type RouteHealth,
  type RouteModel,
  type RouteProfile,
  type RouteWeights,
} from '@agenticfi/onchain-router-routing';

export interface OnchainRouterClientOptions {
  baseUrl: string;
  /** A fetch already wrapped by the official @x402/fetch client and official EVM scheme. */
  paymentFetch: typeof fetch;
}

export class OnchainRouterClient {
  public constructor(private readonly options: OnchainRouterClientOptions) {}
  public async chat(body: unknown, idempotencyKey: string = randomUUID()): Promise<Response> {
    return this.request('/v1/chat/completions', body, idempotencyKey);
  }
  public async messages(body: unknown, idempotencyKey: string = randomUUID()): Promise<Response> {
    return this.request('/v1/messages', body, idempotencyKey);
  }
  private async request(path: string, body: unknown, idempotencyKey: string): Promise<Response> {
    return this.options.paymentFetch(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
  }
}
