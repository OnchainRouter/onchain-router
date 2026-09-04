import { fork } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  BuyerRuntimeError,
  PaymentPolicyRejected,
  WalletLocked,
  type EffectiveBuyerPolicy,
  type PaymentConfirmation,
} from '@onchainrouter/buyer-core';
import {
  LocalSpendLedger,
  WalletVault,
  atomicPrivateWrite,
  createBuyerPolicy,
  isPolicyRestriction,
  pathExists,
  type WalletVaultOptions,
} from '@onchainrouter/buyer-core/admin';
import {
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  OnchainRouterBuyer,
  OnchainRouterDiscovery,
  PAID_JSON_ENDPOINTS,
  MAX_MEDIA_JSON_BYTES,
  STT_RETENTION_NOTICE,
  buyerProfilePaths,
  type BuyerProfilePaths,
  type PaidJsonEndpoint,
} from '@onchainrouter/client';
import { removeBuyerSession } from '@onchainrouter/client/admin';
import {
  assertKnownFlags,
  booleanFlag,
  flag,
  parseArguments,
  requiredFlag,
  type ParsedArguments,
} from './args.js';
import { safeError, safeJson } from './format.js';
import { TerminalPrompt, type PromptIO } from './prompt.js';
import { readAudioFile } from './media-file.js';

const VERSION = '0.2.1';
const DEFAULT_ORIGIN = 'https://onchainrouter.dev';
const DEFAULT_AGENT_ID = 'cli';
const MAX_BRIDGE_BYTES = MAX_MEDIA_JSON_BYTES + 65_536;
const DEFAULT_SESSION_MS = 30 * 60_000;
const DEFAULT_LIMITS = {
  perCallAtomic: 250_000n,
  sessionAtomic: 1_000_000n,
  hourAtomic: 2_000_000n,
  dayAtomic: 5_000_000n,
} as const;

interface BrokerStartRequest {
  readonly profileDirectory: string;
  readonly passphrase: string;
  readonly agentId: string;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

interface BrokerStartResult {
  readonly address: string;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface CliDependencies {
  readonly prompt?: PromptIO;
  readonly fetch?: typeof fetch;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly startBroker?: (request: BrokerStartRequest) => Promise<BrokerStartResult>;
  /** Test-only construction override; production callers use the strong vault KDF. */
  readonly testVaultOptions?: Pick<WalletVaultOptions, 'scryptN' | 'allowWeakTestKdf'>;
}

interface CliContext {
  readonly prompt: PromptIO;
  readonly fetch?: typeof fetch;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly startBroker: (request: BrokerStartRequest) => Promise<BrokerStartResult>;
  readonly testVaultOptions?: Pick<WalletVaultOptions, 'scryptN' | 'allowWeakTestKdf'>;
}

interface CommandOutput {
  readonly command: string;
  readonly result: unknown;
}

function output(context: CliContext, args: ParsedArguments, value: CommandOutput): void {
  if (booleanFlag(args, 'json'))
    context.stdout(`${safeJson({ version: 1, ok: true, ...value })}\n`);
  else if (typeof value.result === 'string') context.stdout(`${value.result}\n`);
  else context.stdout(`${safeJson(value.result, 2)}\n`);
}

function profile(args: ParsedArguments): BuyerProfilePaths {
  const configured = flag(args, 'profile');
  if (configured === 'true') throw new PaymentPolicyRejected('--profile requires a value');
  return buyerProfilePaths(configured);
}

function origin(args: ParsedArguments): string {
  const configured = flag(args, 'origin');
  if (configured === 'true') throw new PaymentPolicyRejected('--origin requires a value');
  return configured ?? DEFAULT_ORIGIN;
}

function parseUsdc(value: string, label: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new PaymentPolicyRejected(`${label} must be a positive USDC decimal`);
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  const atomic = whole * 1_000_000n + fraction;
  if (atomic <= 0n) throw new PaymentPolicyRejected(`${label} must be greater than zero`);
  return atomic;
}

function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new PaymentPolicyRejected(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new PaymentPolicyRejected(`${label} must be a positive safe integer`);
  return parsed;
}

function agentId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new PaymentPolicyRejected('agent ID is invalid');
  return value;
}

function modelList(value: string): string[] {
  const models = [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length === 0) throw new PaymentPolicyRejected('at least one model is required');
  return models;
}

function policyJson(policy: EffectiveBuyerPolicy): unknown {
  return {
    canonicalOrigin: policy.canonicalOrigin,
    network: policy.network,
    asset: policy.asset,
    recipients: policy.recipients,
    schemes: policy.schemes,
    models: policy.models,
    limits: {
      perCallUsdc: formatUsdc(policy.limits.perCallAtomic),
      sessionUsdc: formatUsdc(policy.limits.sessionAtomic),
      hourUsdc: formatUsdc(policy.limits.hourAtomic),
      dayUsdc: formatUsdc(policy.limits.dayAtomic),
    },
    delegations: policy.delegations?.map((delegation) => ({
      agentId: delegation.agentId,
      maximumUsdc: formatUsdc(delegation.maximumAtomic),
      revoked: delegation.revoked ?? false,
    })),
    sessionDurationMs: policy.sessionDurationMs,
    reservationTtlMs: policy.reservationTtlMs,
    maximumAuthorizationSeconds: policy.maximumAuthorizationSeconds,
    maximumOutputTokens: policy.maximumOutputTokens,
    requirePerCallConfirmation: policy.requirePerCallConfirmation,
    hash: policy.hash,
  };
}

function vault(paths: BuyerProfilePaths, context: CliContext): WalletVault {
  return new WalletVault({
    directory: paths.walletDirectory,
    ...(context.testVaultOptions ?? {}),
  });
}

async function brokerProcess(request: BrokerStartRequest): Promise<BrokerStartResult> {
  const child = fork(new URL('./broker-worker.js', import.meta.url), [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return await new Promise<BrokerStartResult>((resolveStart, reject) => {
    let settled = false;
    const finishFailure = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      if (child.connected) child.disconnect();
      reject(new WalletLocked(message));
    };
    const timeout = setTimeout(() => {
      finishFailure('signer broker did not start in time');
    }, 120_000);
    timeout.unref();
    const fail = () => finishFailure('signer broker could not start');
    const exited = () => finishFailure('signer broker exited before startup');
    child.once('error', fail);
    child.once('exit', exited);
    child.once('message', (message: unknown) => {
      if (settled) return;
      if (!isBrokerResponse(message)) {
        finishFailure('signer broker returned an invalid startup response');
        return;
      }
      if (!message.ok) {
        finishFailure(message.error.message);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off('error', fail);
      child.off('exit', exited);
      child.disconnect();
      child.unref();
      resolveStart(message.result);
    });
    child.send({ version: 1, action: 'start', ...request });
  });
}

function isBrokerResponse(
  value: unknown,
): value is
  | { version: 1; ok: true; result: BrokerStartResult }
  | { version: 1; ok: false; error: { message: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item['version'] !== 1 || typeof item['ok'] !== 'boolean') return false;
  if (!item['ok'])
    return (
      typeof item['error'] === 'object' &&
      item['error'] !== null &&
      typeof (item['error'] as Record<string, unknown>)['message'] === 'string'
    );
  if (typeof item['result'] !== 'object' || item['result'] === null) return false;
  const result = item['result'] as Record<string, unknown>;
  return (
    typeof result['address'] === 'string' &&
    typeof result['idleExpiresAt'] === 'number' &&
    typeof result['absoluteExpiresAt'] === 'number'
  );
}

async function setup(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, [
    'profile',
    'origin',
    'json',
    'models',
    'agent',
    'per-call-usdc',
    'session-usdc',
    'hour-usdc',
    'day-usdc',
    'max-output-tokens',
    'confirm-each',
    'wallet-mode',
    'yes',
  ]);
  if (args.positionals.length !== 1) throw new PaymentPolicyRejected('usage: onchain-router setup');
  const paths = profile(args);
  if (await pathExists(paths.directory))
    throw new PaymentPolicyRejected('buyer profile already exists');
  const discovery = new OnchainRouterDiscovery(origin(args), {
    ...(context.fetch ? { fetch: context.fetch } : {}),
  });
  const contract = await discovery.paymentContract();
  context.stderr(
    `Verified x402 v2 on ${contract.network}; USDC ${contract.asset}; recipient ${contract.recipients.join(', ')}.\n`,
  );
  const selectedModels = modelList(
    flag(args, 'models')
      ? requiredFlag(args, 'models')
      : await context.prompt.ask('Allowed models (comma-separated)', contract.models.join(',')),
  );
  if (selectedModels.some((model) => !contract.models.includes(model)))
    throw new PaymentPolicyRejected('selected model is absent from verified discovery');
  const selectedAgent = agentId(
    flag(args, 'agent')
      ? requiredFlag(args, 'agent')
      : await context.prompt.ask('Agent ID', DEFAULT_AGENT_ID),
  );
  const perCallAtomic = parseUsdc(
    flag(args, 'per-call-usdc')
      ? requiredFlag(args, 'per-call-usdc')
      : await context.prompt.ask('Per-call cap in USDC', formatUsdc(DEFAULT_LIMITS.perCallAtomic)),
    'per-call cap',
  );
  const sessionAtomic = parseUsdc(
    flag(args, 'session-usdc')
      ? requiredFlag(args, 'session-usdc')
      : await context.prompt.ask('Session cap in USDC', formatUsdc(DEFAULT_LIMITS.sessionAtomic)),
    'session cap',
  );
  const hourAtomic = parseUsdc(
    flag(args, 'hour-usdc')
      ? requiredFlag(args, 'hour-usdc')
      : await context.prompt.ask('Hourly cap in USDC', formatUsdc(DEFAULT_LIMITS.hourAtomic)),
    'hour cap',
  );
  const dayAtomic = parseUsdc(
    flag(args, 'day-usdc')
      ? requiredFlag(args, 'day-usdc')
      : await context.prompt.ask('Daily cap in USDC', formatUsdc(DEFAULT_LIMITS.dayAtomic)),
    'day cap',
  );
  const maximumOutputTokens = positiveInteger(
    flag(args, 'max-output-tokens')
      ? requiredFlag(args, 'max-output-tokens')
      : await context.prompt.ask('Maximum output tokens', '8192'),
    'maximum output tokens',
  );
  const requirePerCallConfirmation =
    flag(args, 'confirm-each') === undefined
      ? await context.prompt.confirm('Require confirmation before every payment', true)
      : booleanFlag(args, 'confirm-each');
  const mode = (
    flag(args, 'wallet-mode')
      ? requiredFlag(args, 'wallet-mode')
      : await context.prompt.ask('Wallet mode: create or import', 'create')
  ).toLowerCase();
  if (mode !== 'create' && mode !== 'import')
    throw new PaymentPolicyRejected('wallet mode must be create or import');
  const importedSecret =
    mode === 'import' ? await context.prompt.secret('Private key or seed phrase') : '';
  const passphrase = await context.prompt.secret('New wallet passphrase');
  const repeated = await context.prompt.secret('Repeat wallet passphrase');
  if (passphrase !== repeated) throw new PaymentPolicyRejected('wallet passphrases do not match');
  if (
    !booleanFlag(args, 'yes') &&
    !(await context.prompt.confirm('Create this bounded Base mainnet buyer profile', false))
  )
    throw new PaymentPolicyRejected('setup was cancelled');

  const policy = createBuyerPolicy({
    canonicalOrigin: contract.canonicalOrigin,
    network: contract.network,
    asset: contract.asset,
    recipients: contract.recipients,
    schemes: [contract.scheme],
    models: selectedModels,
    delegations: [{ agentId: selectedAgent, maximumAtomic: dayAtomic }],
    limits: { perCallAtomic, sessionAtomic, hourAtomic, dayAtomic },
    sessionDurationMs: DEFAULT_SESSION_MS,
    reservationTtlMs: 5 * 60_000,
    maximumAuthorizationSeconds: 300,
    maximumOutputTokens,
    requirePerCallConfirmation,
  });
  const parent = dirname(paths.directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, '.onchain-router-setup-'));
  await chmod(staging, 0o700);
  try {
    const stagingPaths = buyerProfilePaths(staging);
    const stagingVault = vault(stagingPaths, context);
    const status =
      mode === 'create'
        ? await stagingVault.create(passphrase)
        : await stagingVault.importSecret(importedSecret, passphrase);
    const ledger = new LocalSpendLedger(stagingPaths.ledgerPath, policy);
    try {
      if (!status.address) throw new PaymentPolicyRejected('wallet creation returned no address');
      ledger.bindWalletAddress(status.address);
    } finally {
      ledger.close();
    }
    await rename(staging, paths.directory);
    return {
      profile: paths.directory,
      address: status.address,
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      agentId: selectedAgent,
      models: selectedModels,
      policy: policyJson(policy),
      next: `Fund ${status.address} with Base mainnet USDC, then unlock and make a request.`,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function unlock(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'agent', 'idle-seconds', 'session-seconds', 'json']);
  const paths = profile(args);
  const agent = agentId(flag(args, 'agent') ?? DEFAULT_AGENT_ID);
  const idleTimeoutMs =
    positiveInteger(flag(args, 'idle-seconds') ?? '300', 'idle seconds') * 1_000;
  const absoluteTimeoutMs =
    positiveInteger(flag(args, 'session-seconds') ?? '1800', 'session seconds') * 1_000;
  if (absoluteTimeoutMs < idleTimeoutMs)
    throw new PaymentPolicyRejected('session expiry cannot be shorter than idle expiry');
  let existing: OnchainRouterBuyer | undefined;
  try {
    existing = await OnchainRouterBuyer.connect({ profileDirectory: paths.directory });
  } catch (error) {
    if (error instanceof BuyerRuntimeError && error.code === 'WalletLocked')
      await removeBuyerSession(paths.directory).catch(() => undefined);
    else throw error;
  }
  if (existing) {
    existing.close();
    throw new WalletLocked('buyer wallet is already unlocked; lock it before starting a session');
  }
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    const policy = ledger.currentPolicy();
    if (absoluteTimeoutMs > policy.sessionDurationMs)
      throw new PaymentPolicyRejected('requested session exceeds the stored policy');
    const delegation = policy.delegations?.find((item) => item.agentId === agent);
    if (policy.delegations?.length && (!delegation || delegation.revoked))
      throw new PaymentPolicyRejected('agent has no active delegation');
  } finally {
    ledger.close();
  }
  const passphrase = await context.prompt.secret('Wallet passphrase');
  const started = await context.startBroker({
    profileDirectory: paths.directory,
    passphrase,
    agentId: agent,
    idleTimeoutMs,
    absoluteTimeoutMs,
  });
  return {
    address: started.address,
    agentId: agent,
    unlocked: true,
    idleExpiresAt: new Date(started.idleExpiresAt).toISOString(),
    absoluteExpiresAt: new Date(started.absoluteExpiresAt).toISOString(),
  };
}

async function lock(args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json']);
  const paths = profile(args);
  try {
    const buyer = await OnchainRouterBuyer.connect({ profileDirectory: paths.directory });
    await buyer.lock();
  } catch (error) {
    if (!(error instanceof BuyerRuntimeError) || error.code !== 'WalletLocked') throw error;
    await removeBuyerSession(paths.directory).catch(() => undefined);
  }
  return { locked: true };
}

async function rotateWalletPassphrase(
  context: CliContext,
  args: ParsedArguments,
): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json']);
  if (args.positionals.length !== 2 || args.positionals[1] !== 'rotate-passphrase')
    throw new PaymentPolicyRejected('usage: onchain-router wallet rotate-passphrase');
  const paths = profile(args);
  const wallet = vault(paths, context);
  const before = await wallet.status();
  if (!before.initialized || !before.address)
    throw new PaymentPolicyRejected('buyer wallet is not initialized');

  await lock(args);
  const currentPassphrase = await context.prompt.secret('Current wallet passphrase');
  const newPassphrase = await context.prompt.secret('New wallet passphrase');
  const repeated = await context.prompt.secret('Repeat new wallet passphrase');
  if (newPassphrase !== repeated)
    throw new PaymentPolicyRejected('new wallet passphrases do not match');
  const rotated = await wallet.rotatePassphrase(currentPassphrase, newPassphrase);
  if (rotated.address !== before.address)
    throw new PaymentPolicyRejected('wallet address changed during passphrase rotation');
  return { rotated: true, locked: true, address: rotated.address };
}

async function status(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json']);
  const paths = profile(args);
  const walletStatus = await vault(paths, context).status();
  if (!walletStatus.initialized)
    return { initialized: false, profile: paths.directory, locked: true };
  try {
    const buyer = await OnchainRouterBuyer.connect({
      profileDirectory: paths.directory,
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    try {
      return { initialized: true, locked: false, ...(await buyer.status()) };
    } finally {
      buyer.close();
    }
  } catch (error) {
    if (!(error instanceof BuyerRuntimeError) || error.code !== 'WalletLocked') throw error;
    await removeBuyerSession(paths.directory).catch(() => undefined);
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    try {
      return {
        initialized: true,
        locked: true,
        address: walletStatus.address,
        policy: policyJson(ledger.currentPolicy()),
      };
    } finally {
      ledger.close();
    }
  }
}

async function freeDiscovery(
  context: CliContext,
  args: ParsedArguments,
  action: 'models' | 'pricing' | 'voices',
): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'origin', 'json']);
  let selectedOrigin = origin(args);
  const paths = profile(args);
  if (await pathExists(paths.ledgerPath)) {
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    try {
      selectedOrigin = ledger.currentPolicy().canonicalOrigin;
    } finally {
      ledger.close();
    }
  }
  const discovery = new OnchainRouterDiscovery(selectedOrigin, {
    ...(context.fetch ? { fetch: context.fetch } : {}),
  });
  return await discovery[action]();
}

async function balance(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json']);
  const paths = profile(args);
  const walletStatus = await vault(paths, context).status();
  if (!walletStatus.address) throw new PaymentPolicyRejected('buyer wallet is not initialized');
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    const discovery = new OnchainRouterDiscovery(ledger.currentPolicy().canonicalOrigin, {
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    return await discovery.balance(walletStatus.address);
  } finally {
    ledger.close();
  }
}

async function funding(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json']);
  const paths = profile(args);
  const walletStatus = await vault(paths, context).status();
  if (!walletStatus.address) throw new PaymentPolicyRejected('buyer wallet is not initialized');
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    const scheme = ledger.currentPolicy().schemes[0];
    if (scheme !== 'exact')
      return {
        address: walletStatus.address,
        network: BASE_MAINNET_NETWORK,
        asset: BASE_MAINNET_USDC,
        actionRequired: 'migrate_profile_to_exact',
        instruction: `Run onchain-router policy set --profile ${paths.directory} --scheme exact. Existing USDC and the wallet address are preserved.`,
      };
    return {
      address: walletStatus.address,
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      scheme: 'exact',
      instruction: `Send Base mainnet USDC to ${walletStatus.address}. Do not send funds on another network.`,
    };
  } finally {
    ledger.close();
  }
}

function showPolicy(args: ParsedArguments): unknown {
  assertKnownFlags(args, ['profile', 'json']);
  const paths = profile(args);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    return policyJson(ledger.currentPolicy());
  } finally {
    ledger.close();
  }
}

async function setPolicy(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, [
    'profile',
    'json',
    'origin',
    'models',
    'per-call-usdc',
    'session-usdc',
    'hour-usdc',
    'day-usdc',
    'max-output-tokens',
    'confirm-each',
    'scheme',
  ]);
  const paths = profile(args);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    const current = ledger.currentPolicy();
    const requestedOrigin = flag(args, 'origin');
    let canonicalOrigin = current.canonicalOrigin;
    if (requestedOrigin !== undefined) {
      const target = await new OnchainRouterDiscovery(requiredFlag(args, 'origin'), {
        ...(context.fetch ? { fetch: context.fetch } : {}),
      }).paymentContract();
      const sameRecipients =
        target.recipients.length === current.recipients.length &&
        target.recipients.every((recipient) =>
          current.recipients.some((item) => item.toLowerCase() === recipient.toLowerCase()),
        );
      if (target.network !== current.network)
        throw new PaymentPolicyRejected('target origin uses a different payment network');
      if (target.asset.toLowerCase() !== current.asset.toLowerCase())
        throw new PaymentPolicyRejected('target origin uses a different payment asset');
      if (!sameRecipients)
        throw new PaymentPolicyRejected('target origin uses a different payment recipient');
      if (target.scheme !== 'exact')
        throw new PaymentPolicyRejected('target origin does not advertise the exact scheme');
      if (current.models.some((model) => !target.models.includes(model)))
        throw new PaymentPolicyRejected('target origin does not advertise every allowed model');
      canonicalOrigin = target.canonicalOrigin;
    }
    const requestedScheme = flag(args, 'scheme');
    if (requestedScheme !== undefined && requestedScheme !== 'exact')
      throw new PaymentPolicyRejected('exact is the only supported payment scheme');
    if (current.schemes[0] !== 'exact' && requestedScheme !== 'exact')
      throw new PaymentPolicyRejected(
        'legacy profile migration must be explicit; rerun with --scheme exact',
      );
    const dayAtomic = flag(args, 'day-usdc')
      ? parseUsdc(requiredFlag(args, 'day-usdc'), 'day cap')
      : current.limits.dayAtomic;
    const next = createBuyerPolicy({
      ...current,
      canonicalOrigin,
      schemes: ['exact'],
      models: flag(args, 'models') ? modelList(requiredFlag(args, 'models')) : current.models,
      limits: {
        perCallAtomic: flag(args, 'per-call-usdc')
          ? parseUsdc(requiredFlag(args, 'per-call-usdc'), 'per-call cap')
          : current.limits.perCallAtomic,
        sessionAtomic: flag(args, 'session-usdc')
          ? parseUsdc(requiredFlag(args, 'session-usdc'), 'session cap')
          : current.limits.sessionAtomic,
        hourAtomic: flag(args, 'hour-usdc')
          ? parseUsdc(requiredFlag(args, 'hour-usdc'), 'hour cap')
          : current.limits.hourAtomic,
        dayAtomic,
      },
      ...(current.delegations
        ? {
            delegations: current.delegations.map((delegation) => ({
              ...delegation,
              maximumAtomic:
                delegation.maximumAtomic === current.limits.dayAtomic
                  ? dayAtomic
                  : delegation.maximumAtomic,
            })),
          }
        : {}),
      maximumOutputTokens: flag(args, 'max-output-tokens')
        ? positiveInteger(requiredFlag(args, 'max-output-tokens'), 'maximum output tokens')
        : current.maximumOutputTokens,
      requirePerCallConfirmation:
        flag(args, 'confirm-each') === undefined
          ? current.requirePerCallConfirmation
          : booleanFlag(args, 'confirm-each'),
    });
    if (isPolicyRestriction(current, next)) {
      ledger.restrictPolicy(next);
      return { change: 'restricted', policy: policyJson(next) };
    }
    await lock({ positionals: ['lock'], flags: new Map([['profile', [paths.directory]]]) });
    const passphrase = await context.prompt.secret('Wallet passphrase for wider policy');
    const authorization = await vault(paths, context).authenticatePolicyChange(
      next.hash,
      passphrase,
    );
    ledger.replacePolicy(next, authorization);
    return { change: 'human-authorized-replacement', locked: true, policy: policyJson(next) };
  } finally {
    ledger.close();
  }
}

async function confirmPayment(context: CliContext, value: PaymentConfirmation): Promise<boolean> {
  return await context.prompt.confirm(
    `Pay ${formatUsdc(BigInt(value.maximumAtomic))} USDC for ${value.model} to ${value.recipient}`,
    false,
  );
}

function textFromResponse(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const choices = (value as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || typeof choices[0] !== 'object' || choices[0] === null) return null;
  const message = (choices[0] as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}

async function chat(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json', 'model', 'max-output-tokens', 'idempotency-key']);
  const promptValue =
    args.positionals.length > 1
      ? args.positionals.slice(1).join(' ')
      : (await readBridgeInput())['prompt'];
  if (typeof promptValue !== 'string') throw new PaymentPolicyRejected('prompt must be text');
  const prompt = promptValue.trim();
  if (!prompt) throw new PaymentPolicyRejected('usage: onchain-router chat "prompt" --model MODEL');
  const model = requiredFlag(args, 'model');
  const maxTokens = positiveInteger(flag(args, 'max-output-tokens') ?? '1024', 'output tokens');
  const paths = profile(args);
  const buyer = await OnchainRouterBuyer.connect({
    profileDirectory: paths.directory,
    ...(context.fetch ? { fetch: context.fetch } : {}),
    confirmPayment: async (confirmation) => await confirmPayment(context, confirmation),
  });
  try {
    const result = await buyer.chat(
      { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens },
      flag(args, 'idempotency-key'),
    );
    if (booleanFlag(args, 'json') || !result.ok) return result;
    const content = textFromResponse(result.body);
    return content
      ? `${content}\n\nReceipt: ${result.receipt.id}\nTransaction: ${result.payment.transaction}`
      : result;
  } finally {
    try {
      buyer.close();
    } catch {
      /* Preserve the financial outcome on cleanup failure. */
    }
  }
}

async function mediaCommand(
  context: CliContext,
  args: ParsedArguments,
  command: 'image' | 'speak' | 'messages' | 'transcribe',
): Promise<unknown> {
  assertKnownFlags(args, [
    'profile',
    'json',
    'idempotency-key',
    ...(command === 'transcribe' ? ['file', 'model'] : []),
  ]);
  if (args.positionals.length !== 1)
    throw new PaymentPolicyRejected('send request JSON on standard input, not command arguments');
  const key = requiredFlag(args, 'idempotency-key');
  let body: Record<string, unknown>;
  if (command === 'transcribe') {
    context.stderr(`${STT_RETENTION_NOTICE}\n`);
    if (
      !(await context.prompt.confirm(
        'Do you understand this retention policy and have permission to upload this audio',
        false,
      ))
    )
      throw new PaymentPolicyRejected('audio upload was cancelled');
    body = {
      model: requiredFlag(args, 'model'),
      audio_base64: await readAudioFile(requiredFlag(args, 'file')),
      acknowledge_provider_retention: true,
    };
  } else {
    body = await readBridgeInput();
    // Large inline images are deliberately not printed by the human CLI workflow.
    if (
      command === 'image' &&
      body['response_format'] !== undefined &&
      body['response_format'] !== 'url'
    )
      throw new PaymentPolicyRejected(
        'CLI images use hosted URL output; use the SDK for bounded inline output',
      );
  }
  const endpoints = {
    image: '/v1/images/generations',
    speak: '/v1/audio/speech',
    messages: '/v1/messages',
    transcribe: '/v1/audio/transcriptions',
  } as const;
  const buyer = await OnchainRouterBuyer.connect({
    profileDirectory: profile(args).directory,
    ...(context.fetch ? { fetch: context.fetch } : {}),
    confirmPayment: async (confirmation) => await confirmPayment(context, confirmation),
  });
  try {
    return await buyer.execute(endpoints[command], body, key);
  } finally {
    try {
      buyer.close();
    } catch {
      /* A cleanup error must not erase a durable result. */
    }
  }
}

function receipt(args: ParsedArguments): unknown {
  assertKnownFlags(args, ['profile', 'json']);
  const key = args.positionals[1];
  if (!key) throw new PaymentPolicyRejected('usage: onchain-router receipt IDEMPOTENCY_KEY');
  const paths = profile(args);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  try {
    const found = ledger.receipt(key);
    if (!found) throw new PaymentPolicyRejected('receipt was not found in the local ledger');
    return found;
  } finally {
    ledger.close();
  }
}

async function doctor(context: CliContext, args: ParsedArguments): Promise<unknown> {
  assertKnownFlags(args, ['profile', 'json', 'out']);
  const paths = profile(args);
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  checks.push({
    check: 'platform',
    ok: process.platform === 'darwin' || process.platform === 'linux',
    detail: process.platform,
  });
  checks.push({ check: 'profile', ok: await pathExists(paths.directory), detail: paths.directory });
  const walletStatus = await vault(paths, context)
    .status()
    .catch(() => null);
  checks.push({
    check: 'encrypted_wallet',
    ok: walletStatus?.initialized === true,
    detail: walletStatus?.initialized ? 'initialized' : 'missing or unsafe',
  });
  let policy: EffectiveBuyerPolicy | null = null;
  try {
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    policy = ledger.currentPolicy();
    ledger.close();
    checks.push({ check: 'authoritative_ledger', ok: true, detail: 'schema and policy valid' });
  } catch {
    checks.push({ check: 'authoritative_ledger', ok: false, detail: 'missing or invalid' });
  }
  try {
    const buyer = await OnchainRouterBuyer.connect({ profileDirectory: paths.directory });
    await buyer.status();
    buyer.close();
    checks.push({ check: 'signer_broker', ok: true, detail: 'unlocked and responsive' });
  } catch (error) {
    const safelyLocked = error instanceof BuyerRuntimeError && error.code === 'WalletLocked';
    checks.push({
      check: 'signer_broker',
      ok: safelyLocked,
      detail: safelyLocked
        ? 'locked (safe default)'
        : 'session descriptor is invalid or unavailable',
    });
  }
  if (policy) {
    const discovery = new OnchainRouterDiscovery(policy.canonicalOrigin, {
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    try {
      const discovered = await discovery.paymentContract();
      const contractConsistent =
        discovered.network === policy.network &&
        discovered.asset.toLowerCase() === policy.asset.toLowerCase() &&
        policy.recipients.every((recipient) =>
          discovered.recipients.some((item) => item.toLowerCase() === recipient.toLowerCase()),
        ) &&
        policy.models.every((model) => discovered.models.includes(model));
      checks.push({
        check: 'live_discovery',
        ok: contractConsistent,
        detail: contractConsistent
          ? 'network, asset, recipient, and models match local policy'
          : 'network, asset, recipient, or models differ from local policy',
      });
      const schemeConsistent = discovered.scheme === policy.schemes[0];
      checks.push({
        check: 'payment_scheme',
        ok: schemeConsistent,
        detail: schemeConsistent
          ? `profile and discovery use ${discovered.scheme}`
          : `profile uses ${policy.schemes[0]}; discovery requires ${discovered.scheme}; run onchain-router policy set --profile ${paths.directory} --scheme ${discovered.scheme}`,
      });
    } catch {
      checks.push({ check: 'live_discovery', ok: false, detail: 'unavailable or invalid' });
    }
    if (walletStatus?.address) {
      try {
        const currentBalance = await discovery.balance(walletStatus.address);
        checks.push({
          check: 'base_usdc_balance',
          ok: true,
          detail: `${currentBalance.balance_usdc} USDC`,
        });
      } catch {
        checks.push({
          check: 'base_usdc_balance',
          ok: false,
          detail: 'unavailable or invalid',
        });
      }
    } else {
      checks.push({
        check: 'base_usdc_balance',
        ok: false,
        detail: 'wallet address unavailable',
      });
    }
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    profile: paths.directory,
    healthy: checks.every((check) => check.ok),
    checks,
    redaction:
      'No prompts, responses, wallet keys, passphrases, payment payloads, or broker capabilities included.',
  };
  const destination = flag(args, 'out');
  if (destination && destination !== 'true')
    await atomicPrivateWrite(resolve(destination), Buffer.from(`${safeJson(report, 2)}\n`, 'utf8'));
  return report;
}

async function readBridgeInput(): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_BRIDGE_BYTES)
      throw new PaymentPolicyRejected('SDK bridge request exceeds the media byte limit');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PaymentPolicyRejected('SDK bridge request is malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PaymentPolicyRejected('SDK bridge request must be an object');
  return value as Record<string, unknown>;
}

async function bridge(context: CliContext, args: ParsedArguments): Promise<void> {
  assertKnownFlags(args, ['profile']);
  const paths = profile(args);
  try {
    const request = await readBridgeInput();
    const action = request['action'];
    let result: unknown;
    if (action === 'models' || action === 'pricing' || action === 'voices') {
      result = await freeDiscovery(
        context,
        { positionals: [String(action)], flags: new Map([['profile', [paths.directory]]]) },
        action,
      );
    } else if (action === 'balance') {
      result = await balance(context, {
        positionals: ['balance'],
        flags: new Map([['profile', [paths.directory]]]),
      });
    } else if (action === 'status') {
      result = await status(context, {
        positionals: ['status'],
        flags: new Map([['profile', [paths.directory]]]),
      });
    } else if (action === 'receipt') {
      if (typeof request['idempotencyKey'] !== 'string')
        throw new PaymentPolicyRejected('receipt action requires idempotencyKey');
      result = receipt({
        positionals: ['receipt', request['idempotencyKey']],
        flags: new Map([['profile', [paths.directory]]]),
      });
    } else if (action === 'lock') {
      result = await lock({
        positionals: ['lock'],
        flags: new Map([['profile', [paths.directory]]]),
      });
    } else if (action === 'execute') {
      const endpoint = request['endpoint'];
      const body = request['body'];
      if (
        typeof endpoint !== 'string' ||
        !PAID_JSON_ENDPOINTS.includes(endpoint as PaidJsonEndpoint) ||
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body)
      )
        throw new PaymentPolicyRejected('execute action has an invalid endpoint or body');
      const buyer = await OnchainRouterBuyer.connect({
        profileDirectory: paths.directory,
        ...(context.fetch ? { fetch: context.fetch } : {}),
      });
      try {
        result = await buyer.execute(
          endpoint as PaidJsonEndpoint,
          body as Record<string, unknown>,
          typeof request['idempotencyKey'] === 'string' ? request['idempotencyKey'] : undefined,
        );
      } finally {
        try {
          buyer.close();
        } catch {
          /* The bridge must preserve the financial outcome. */
        }
      }
    } else {
      throw new PaymentPolicyRejected('SDK bridge action is unsupported');
    }
    context.stdout(`${safeJson({ version: 1, ok: true, result })}\n`);
  } catch (error) {
    context.stdout(`${safeJson({ version: 1, ok: false, error: safeError(error) })}\n`);
  }
}

function usage(): string {
  return `Onchain Router buyer CLI ${VERSION}

Usage:
  onchain-router setup [--origin URL] [--profile DIR] [--models A,B] [--agent ID]
                       [--per-call-usdc N] [--session-usdc N] [--hour-usdc N]
                       [--day-usdc N] [--max-output-tokens N]
                       [--confirm-each true|false] [--wallet-mode create|import] [--yes]
  onchain-router unlock [--agent ID] [--idle-seconds N] [--session-seconds N]
  onchain-router lock | status | balance | funding | models | pricing | voices
  onchain-router wallet rotate-passphrase
  onchain-router policy show
  onchain-router policy set [--origin URL] [--scheme exact] [--models A,B] [--per-call-usdc N] [--session-usdc N]
                              [--hour-usdc N] [--day-usdc N]
                              [--max-output-tokens N] [--confirm-each true|false]
  onchain-router chat "prompt" --model MODEL [--max-output-tokens N]
  onchain-router image | speak | messages --idempotency-key KEY < request.json
  onchain-router transcribe --file AUDIO.mp3 --model MODEL --idempotency-key KEY
  onchain-router receipt IDEMPOTENCY_KEY
  onchain-router doctor [--out FILE]

Global output: add --json. Paid calls never retry an ambiguous outcome automatically.`;
}

export function createCli(dependencies: CliDependencies = {}) {
  const context: CliContext = {
    prompt: dependencies.prompt ?? new TerminalPrompt(),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    stdout: dependencies.stdout ?? ((text) => process.stdout.write(text)),
    stderr: dependencies.stderr ?? ((text) => process.stderr.write(text)),
    startBroker: dependencies.startBroker ?? brokerProcess,
    ...(dependencies.testVaultOptions ? { testVaultOptions: dependencies.testVaultOptions } : {}),
  };
  return async (argv: readonly string[]): Promise<number> => {
    let args: ParsedArguments | null = null;
    try {
      args = parseArguments(argv);
      const command = args.flags.has('version') ? 'version' : (args.positionals[0] ?? 'help');
      if (command === '_bridge') {
        await bridge(context, args);
        return 0;
      }
      if (command === 'help' || command === '--help') {
        context.stdout(`${usage()}\n`);
        return 0;
      }
      if (command === 'version') {
        assertKnownFlags(args, ['json', 'version']);
        output(context, args, { command, result: VERSION });
        return 0;
      }
      let result: unknown;
      switch (command) {
        case 'setup':
          result = await setup(context, args);
          break;
        case 'unlock':
          result = await unlock(context, args);
          break;
        case 'lock':
          result = await lock(args);
          break;
        case 'wallet':
          result = await rotateWalletPassphrase(context, args);
          break;
        case 'status':
          result = await status(context, args);
          break;
        case 'balance':
          result = await balance(context, args);
          break;
        case 'funding':
          result = await funding(context, args);
          break;
        case 'models':
        case 'pricing':
        case 'voices':
          result = await freeDiscovery(context, args, command);
          break;
        case 'policy':
          if (args.positionals[1] === 'show') result = showPolicy(args);
          else if (args.positionals[1] === 'set') result = await setPolicy(context, args);
          else throw new PaymentPolicyRejected('usage: onchain-router policy show|set');
          break;
        case 'chat':
          result = await chat(context, args);
          break;
        case 'image':
        case 'speak':
        case 'messages':
        case 'transcribe':
          result = await mediaCommand(context, args, command);
          break;
        case 'receipt':
          result = receipt(args);
          break;
        case 'doctor':
          result = await doctor(context, args);
          break;
        default:
          throw new PaymentPolicyRejected(`unknown command: ${command}`);
      }
      output(context, args, { command, result });
      return result && typeof result === 'object' && 'ok' in result && result.ok === false ? 2 : 0;
    } catch (error) {
      const safe = safeError(error);
      if (args && booleanFlag(args, 'json'))
        context.stdout(`${safeJson({ version: 1, ok: false, error: safe })}\n`);
      else context.stderr(`${safe.code}: ${safe.message}\n`);
      return error instanceof BuyerRuntimeError ? 2 : 1;
    }
  };
}
