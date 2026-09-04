import {
  PaymentPolicyRejected,
  RuntimeUnavailable,
  UnexpectedAsset,
  UnexpectedRecipient,
  UnsupportedNetwork,
} from '@onchainrouter/buyer-core';

export const BASE_MAINNET_NETWORK = 'eip155:8453' as const;
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CATALOG_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUOTE_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_QUOTE_TOKEN_LENGTH = 8_192;

export interface ModelCatalog {
  readonly object: 'list';
  readonly catalog_version: string;
  readonly categories: readonly unknown[];
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly category?: string;
    readonly supported_endpoints?: readonly string[];
    readonly max_output_tokens?: number | null;
    readonly [key: string]: unknown;
  }>;
}

export interface PricingCatalog {
  readonly object: 'pricing_catalog';
  readonly catalog_version: string;
  readonly service_fee_basis_points: number;
  readonly promotion: string | null;
  readonly data: readonly unknown[];
}

export interface WalletBalance {
  readonly object: 'wallet_balance';
  readonly network: typeof BASE_MAINNET_NETWORK;
  readonly asset: typeof BASE_MAINNET_USDC;
  readonly currency: 'USDC';
  readonly wallet: string;
  readonly balance_usdc_atomic: string;
  readonly balance_usdc: string;
}

export interface BuyerPaymentContract {
  readonly canonicalOrigin: string;
  readonly network: typeof BASE_MAINNET_NETWORK;
  readonly asset: typeof BASE_MAINNET_USDC;
  readonly recipients: readonly `0x${string}`[];
  readonly models: readonly string[];
  readonly scheme: 'exact';
}

export interface BuyerRequestQuote {
  /** Ephemeral request-bound server token. Never persist or log it. */
  readonly token: string;
  readonly maximumAtomic: bigint;
  readonly catalogVersion: string;
  readonly expiresAt: number;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentPolicyRejected('buyer origin is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value.endsWith('/')
  )
    throw new PaymentPolicyRejected('buyer origin must be a credential-free HTTPS origin');
  return url.origin;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(MAX_DISCOVERY_BYTES))
    throw new RuntimeUnavailable('discovery response exceeds the local size limit');
  if (!response.body) throw new RuntimeUnavailable('discovery response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DISCOVERY_BYTES) {
      await reader.cancel();
      throw new RuntimeUnavailable('discovery response exceeds the local size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RuntimeUnavailable('discovery response is malformed');
  }
}

function validModelEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const identifier = (value as Record<string, unknown>)['id'];
  return typeof identifier === 'string' && MODEL.test(identifier);
}

function modelCatalog(value: unknown): ModelCatalog {
  if (typeof value !== 'object' || value === null)
    throw new RuntimeUnavailable('model catalog is malformed');
  const candidate = value as Record<string, unknown>;
  if (
    candidate['object'] !== 'list' ||
    typeof candidate['catalog_version'] !== 'string' ||
    !Array.isArray(candidate['categories']) ||
    !Array.isArray(candidate['data']) ||
    candidate['data'].some((model: unknown) => !validModelEntry(model))
  )
    throw new RuntimeUnavailable('model catalog is malformed');
  return candidate as unknown as ModelCatalog;
}

export class OnchainRouterDiscovery {
  public readonly origin: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(origin: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.origin = canonicalOrigin(origin);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000)
      throw new PaymentPolicyRejected('discovery timeout is invalid');
  }

  public async models(): Promise<ModelCatalog> {
    return modelCatalog(await this.get('/v1/models'));
  }

  public async voices(): Promise<Record<string, unknown>> {
    const value = await this.get('/v1/audio/voices');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Array.isArray((value as Record<string, unknown>)['data'])
    )
      throw new RuntimeUnavailable('voice catalog is malformed');
    return value as Record<string, unknown>;
  }

  public async pricing(): Promise<PricingCatalog> {
    const value = await this.get('/v1/pricing');
    if (typeof value !== 'object' || value === null)
      throw new RuntimeUnavailable('pricing catalog is malformed');
    const candidate = value as Partial<PricingCatalog>;
    if (
      candidate.object !== 'pricing_catalog' ||
      typeof candidate.catalog_version !== 'string' ||
      typeof candidate.service_fee_basis_points !== 'number' ||
      !Number.isSafeInteger(candidate.service_fee_basis_points) ||
      !Array.isArray(candidate.data)
    )
      throw new RuntimeUnavailable('pricing catalog is malformed');
    return candidate as PricingCatalog;
  }

  /** Obtain a free, request-bound fixed amount. The quote never authorizes or executes payment. */
  public async quote(
    kind: 'openai' | 'anthropic',
    request: Readonly<Record<string, unknown>>,
  ): Promise<BuyerRequestQuote> {
    const value = await this.request('/v1/quotes', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ kind, request }),
    });
    if (typeof value !== 'object' || value === null)
      throw new RuntimeUnavailable('quote response is malformed');
    const candidate = value as Record<string, unknown>;
    const amount = candidate['amount'] ?? candidate['maximumAmount'];
    if (
      typeof candidate['token'] !== 'string' ||
      candidate['token'].length > MAX_QUOTE_TOKEN_LENGTH ||
      !QUOTE_TOKEN.test(candidate['token']) ||
      typeof amount !== 'string' ||
      !/^[1-9]\d*$/.test(amount) ||
      typeof candidate['catalogVersion'] !== 'string' ||
      !CATALOG_VERSION.test(candidate['catalogVersion']) ||
      typeof candidate['expiresAt'] !== 'number' ||
      !Number.isSafeInteger(candidate['expiresAt'])
    )
      throw new RuntimeUnavailable('quote response is malformed');
    return {
      token: candidate['token'],
      maximumAtomic: BigInt(amount),
      catalogVersion: candidate['catalogVersion'],
      expiresAt: candidate['expiresAt'],
    };
  }

  public async balance(address: string): Promise<WalletBalance> {
    if (!ADDRESS.test(address)) throw new PaymentPolicyRejected('wallet address is invalid');
    const value = await this.get(`/v1/balance?address=${encodeURIComponent(address)}`);
    if (typeof value !== 'object' || value === null)
      throw new RuntimeUnavailable('wallet balance response is malformed');
    const candidate = value as Partial<WalletBalance>;
    if (
      candidate.object !== 'wallet_balance' ||
      candidate.network !== BASE_MAINNET_NETWORK ||
      candidate.asset?.toLowerCase() !== BASE_MAINNET_USDC.toLowerCase() ||
      candidate.currency !== 'USDC' ||
      typeof candidate.wallet !== 'string' ||
      candidate.wallet.toLowerCase() !== address.toLowerCase() ||
      typeof candidate.balance_usdc_atomic !== 'string' ||
      !/^\d+$/.test(candidate.balance_usdc_atomic) ||
      typeof candidate.balance_usdc !== 'string'
    )
      throw new RuntimeUnavailable('wallet balance response is malformed');
    return candidate as WalletBalance;
  }

  public async paymentContract(): Promise<BuyerPaymentContract> {
    const [models, discovery] = await Promise.all([this.models(), this.get('/.well-known/x402')]);
    if (typeof discovery !== 'object' || discovery === null)
      throw new RuntimeUnavailable('x402 discovery response is malformed');
    const candidate = discovery as { x402Version?: unknown; resources?: unknown };
    if (candidate.x402Version !== 2 || !Array.isArray(candidate.resources))
      throw new RuntimeUnavailable('x402 discovery response is malformed');
    const recipients = new Set<string>();
    const discoveredModels = new Set<string>();
    for (const resource of candidate.resources) {
      if (typeof resource !== 'object' || resource === null)
        throw new RuntimeUnavailable('x402 resource is malformed');
      const item = resource as Record<string, unknown>;
      if (item['scheme'] !== 'exact') continue;
      if (item['network'] !== BASE_MAINNET_NETWORK) throw new UnsupportedNetwork();
      if (
        typeof item['asset'] !== 'string' ||
        item['asset'].toLowerCase() !== BASE_MAINNET_USDC.toLowerCase()
      )
        throw new UnexpectedAsset();
      if (typeof item['payTo'] !== 'string' || !ADDRESS.test(item['payTo']))
        throw new UnexpectedRecipient();
      if (typeof item['model'] !== 'string' || !MODEL.test(item['model']))
        throw new RuntimeUnavailable('x402 resource model is malformed');
      recipients.add(item['payTo']);
      discoveredModels.add(item['model']);
    }
    const modelIds = models.data.map((model) => model.id);
    const enabled = modelIds.filter((model) => discoveredModels.has(model));
    if (recipients.size === 0 || enabled.length === 0)
      throw new RuntimeUnavailable('x402 discovery has no usable paid resources');
    return {
      canonicalOrigin: this.origin,
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      recipients: [...recipients].sort() as `0x${string}`[],
      models: enabled,
      scheme: 'exact',
    };
  }

  private async get(path: string): Promise<unknown> {
    return await this.request(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new RuntimeUnavailable('discovery request failed');
    }
    try {
      if (!response.ok)
        throw new RuntimeUnavailable(`discovery request returned HTTP ${response.status}`);
      return await readBoundedJson(response);
    } finally {
      clearTimeout(timer);
    }
  }
}
