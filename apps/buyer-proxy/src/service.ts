import {
  PaymentPolicyRejected,
  SettlementOutcomeUnknown,
  type BuyerResult,
} from '@agenticfi/onchain-router-buyer-core';
import {
  OnchainRouterBuyer,
  OnchainRouterDiscovery,
  PAID_JSON_ENDPOINTS,
  type PaidJsonEndpoint,
  inspectBuyerCatalog,
  type BuyerCatalogInspection,
  type BuyerStatus,
  type ModelCatalog,
  type OnchainRouterBuyerOptions,
} from '@agenticfi/onchain-router';
import {
  ResponseCache,
  cacheableRequest,
  responseCacheKey,
  type CacheMode,
  type CachedResponse,
} from './response-cache.js';

export type ProxyChatResult = (BuyerResult & { readonly cacheStatus?: 'MISS' }) | CachedResponse;
export interface ProxyChatOptions {
  readonly cacheMode?: CacheMode;
  readonly callerSuppliedIdempotencyKey?: boolean;
}

export interface BuyerProxyService {
  models(signal: AbortSignal): Promise<ModelCatalog>;
  chat(
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    options?: ProxyChatOptions,
  ): Promise<ProxyChatResult>;
  close?(): void;
  execute?(
    endpoint: PaidJsonEndpoint,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<BuyerResult>;
  discovery?(path: '/v1/pricing' | '/v1/audio/voices', signal: AbortSignal): Promise<unknown>;
}

interface ConnectedBuyer {
  status(): Promise<BuyerStatus>;
  chat(body: Readonly<Record<string, unknown>>, idempotencyKey?: string): Promise<BuyerResult>;
  close(): void;
  execute?(
    endpoint: PaidJsonEndpoint,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<BuyerResult>;
}

export interface BuyerProxyServiceDependencies {
  readonly connectBuyer?: (options: OnchainRouterBuyerOptions) => Promise<ConnectedBuyer>;
  readonly inspectCatalog?: (options: OnchainRouterBuyerOptions) => Promise<BuyerCatalogInspection>;
}

export interface CreateBuyerProxyServiceOptions extends OnchainRouterBuyerOptions {
  readonly dependencies?: BuyerProxyServiceDependencies;
  readonly cacheEnabled?: boolean;
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new PaymentPolicyRejected('request was cancelled before financial handoff');
}

function filteredModels(catalog: BuyerCatalogInspection): ModelCatalog {
  const allowed = new Set(catalog.policy.models);
  const data = catalog.models.data.filter(
    (model) =>
      allowed.has(model.id) &&
      model.supported_endpoints?.some((endpoint) =>
        PAID_JSON_ENDPOINTS.includes(endpoint as PaidJsonEndpoint),
      ) === true,
  );
  const ids = new Set(data.map((model) => model.id));
  const categories = catalog.models.categories
    .filter((category): category is Record<string, unknown> =>
      Boolean(category && typeof category === 'object' && !Array.isArray(category)),
    )
    .map((category) => {
      const modelIds = Array.isArray(category['model_ids'])
        ? category['model_ids'].filter((id): id is string => typeof id === 'string' && ids.has(id))
        : [];
      const endpoints = Array.isArray(category['endpoints'])
        ? category['endpoints'].filter(
            (endpoint) =>
              endpoint &&
              typeof endpoint === 'object' &&
              PAID_JSON_ENDPOINTS.includes(
                (endpoint as Record<string, unknown>)['path'] as PaidJsonEndpoint,
              ),
          )
        : [];
      return { ...category, model_ids: modelIds, endpoints };
    })
    .filter((category) => (category['model_ids'] as readonly string[]).length > 0);
  return { ...catalog.models, categories, data };
}

/** Thin HTTP-facing adapter. Buyer Runtime remains the only financial implementation. */
export function createBuyerProxyService(
  options: CreateBuyerProxyServiceOptions = {},
): BuyerProxyService {
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
  const inspectCatalog = dependencies.inspectCatalog ?? inspectBuyerCatalog;
  const cache = new ResponseCache();

  return {
    async discovery(path, signal) {
      assertNotCancelled(signal);
      const catalog = await inspectCatalog(buyerOptions);
      assertNotCancelled(signal);
      const discovery = new OnchainRouterDiscovery(catalog.policy.canonicalOrigin, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return path === '/v1/pricing' ? await discovery.pricing() : await discovery.voices();
    },
    async execute(endpoint, body, idempotencyKey, signal) {
      assertNotCancelled(signal);
      const buyer = await connectBuyer(buyerOptions);
      let handedOff = false;
      try {
        assertNotCancelled(signal);
        if (!buyer.execute) throw new PaymentPolicyRejected('this client does not support media');
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
          /* Preserve durable results. */
        }
      }
    },
    close() {
      cache.close();
    },
    async models(signal) {
      assertNotCancelled(signal);
      const catalog = await inspectCatalog(buyerOptions);
      assertNotCancelled(signal);
      return filteredModels(catalog);
    },
    async chat(body, idempotencyKey, signal, chatOptions = {}) {
      assertNotCancelled(signal);
      let buyer: ConnectedBuyer;
      try {
        buyer = await connectBuyer(buyerOptions);
      } catch (error) {
        cache.clear();
        throw error;
      }
      let handedOff = false;
      try {
        let key: string | null = null;
        let sessionExpiresAt = 0;
        let catalogVersion: string | undefined;
        const mode = chatOptions.cacheMode ?? 'reuse';
        const explicitKey =
          chatOptions.callerSuppliedIdempotencyKey ?? idempotencyKey !== undefined;
        if (
          options.cacheEnabled !== false &&
          !explicitKey &&
          mode !== 'bypass' &&
          cacheableRequest(body)
        ) {
          // Live discovery prevents reuse after catalog removal; broker status is checked last so
          // a slow discovery read cannot outlive wallet unlock or a current policy restriction.
          const catalog = await inspectCatalog(buyerOptions);
          const status = await buyer.status();
          const policy = status.policy;
          const delegation = policy.delegations.find((item) => item.agentId === status.agentId);
          sessionExpiresAt = Math.min(status.idleExpiresAt, status.absoluteExpiresAt);
          if (
            sessionExpiresAt <= Date.now() ||
            policy.hash !== catalog.policy.hash ||
            !policy.models.includes(String(body['model'])) ||
            (policy.delegations.length > 0 && (!delegation || delegation.revoked))
          ) {
            cache.clear();
            throw new PaymentPolicyRejected(
              'cache access requires the current active buyer policy',
            );
          }
          catalogVersion = catalog.models.catalog_version;
          const model = catalog.models.data.find(
            (item) =>
              item.id === body['model'] &&
              item.supported_endpoints?.includes('/v1/chat/completions'),
          );
          // Confirmation-only policies never reuse results autonomously. All ordinary policy
          // validation and every cache miss remain independently enforced by Buyer Runtime.
          if (model && !policy.requirePerCallConfirmation) {
            key = responseCacheKey(
              {
                origin: policy.canonicalOrigin,
                wallet: status.address,
                agent: status.agentId,
                session: status.sessionId,
                policy: policy.hash,
                catalog: catalogVersion,
              },
              body,
            );
            assertNotCancelled(signal);
            if (key && mode === 'reuse') {
              const hit = cache.get(key);
              if (hit) return hit;
            }
            if (key && mode === 'refresh') cache.invalidate(key);
          }
        }
        // Cancellation is honored until this exact handoff. After it, Buyer Runtime must finish or
        // conservatively classify the financial outcome even if the HTTP client disconnects.
        assertNotCancelled(signal);
        handedOff = true;
        const result = await buyer.chat(body, idempotencyKey);
        // Only a durable, verified runtime success from this exact model/catalog can seed reuse.
        // Cache maintenance cannot replace a known result with financial ambiguity.
        if (
          key &&
          result.ok &&
          result.receipt.model === body['model'] &&
          result.receipt.catalogVersion === catalogVersion
        ) {
          try {
            cache.put(key, result, sessionExpiresAt);
          } catch {
            cache.clear();
          }
        }
        return key ? { ...result, cacheStatus: 'MISS' as const } : result;
      } catch (error) {
        if (handedOff)
          throw new SettlementOutcomeUnknown('buyer runtime outcome is unknown after handoff');
        cache.clear();
        throw error;
      } finally {
        try {
          // Once Buyer Runtime returned a typed result, cleanup must not replace that durable
          // financial outcome with a generic retryable transport error.
          buyer.close();
        } catch {
          // A later connection attempt will surface an unhealthy local runtime. There is no safe
          // request-level action to take here that is more accurate than the result already held.
        }
      }
    },
  };
}
