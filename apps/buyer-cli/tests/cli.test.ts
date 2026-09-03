import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import {
  LocalSpendLedger,
  SignerBroker,
  WalletVault,
  createBuyerPolicy,
} from '@agenticfi/onchain-router-buyer-core/admin';
import { OnchainRouterBuyer, buyerProfilePaths } from '@agenticfi/onchain-router';
import { writeBuyerSession } from '@agenticfi/onchain-router/admin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCli } from '../src/main.js';
import type { PromptIO } from '../src/prompt.js';

it('returns nonzero for a paid unknown outcome and preserves it if cleanup fails', async () => {
  const output: string[] = [];
  vi.spyOn(OnchainRouterBuyer, 'connect').mockResolvedValue({
    chat: async () => ({ ok: false, outcome: 'SettlementOutcomeUnknown', retry: 'human_review' }),
    close: () => {
      throw new Error('cleanup must not mask the result');
    },
  } as unknown as OnchainRouterBuyer);
  const cli = createCli({ stdout: (value) => output.push(value), stderr: () => undefined });
  expect(await cli(['chat', 'fixture', '--model', 'fixture-model', '--json'])).toBe(2);
  expect(output.join('')).toContain('SettlementOutcomeUnknown');
  expect(output.join('')).not.toContain('cleanup must not mask');
});

const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'new locally entered wallet passphrase';
const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), 'buyer-cli-'));
  await chmod(path, 0o700);
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

class Answers implements PromptIO {
  public constructor(
    private readonly answers: string[],
    private readonly secrets: string[],
    private readonly confirmations: boolean[],
  ) {}

  public async ask(_message: string, defaultValue?: string): Promise<string> {
    return this.answers.shift() ?? defaultValue ?? '';
  }

  public async secret(_message: string): Promise<string> {
    const value = this.secrets.shift();
    if (value === undefined) throw new Error('missing test secret');
    return value;
  }

  public async confirm(_message: string, defaultValue?: boolean): Promise<boolean> {
    return this.confirmations.shift() ?? defaultValue ?? false;
  }
}

function discoveryFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/v1/models'))
      return new Response(
        JSON.stringify({
          object: 'list',
          catalog_version: 'catalog-v1',
          categories: [],
          data: [
            {
              id: 'gemini-2.5-flash',
              category: 'text_generation',
              supported_endpoints: ['/v1/chat/completions'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (url.includes('/v1/balance?')) {
      const wallet = new URL(url).searchParams.get('address');
      return new Response(
        JSON.stringify({
          object: 'wallet_balance',
          network: 'eip155:8453',
          asset: ASSET,
          currency: 'USDC',
          wallet,
          balance_usdc_atomic: '1250000',
          balance_usdc: '1.25',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        x402Version: 2,
        resources: [
          {
            path: '/v1/chat/completions',
            model: 'gemini-2.5-flash',
            category: 'text_generation',
            scheme: 'exact',
            network: 'eip155:8453',
            asset: ASSET,
            payTo: RECIPIENT,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

async function setupProfile(root: string) {
  const profile = join(root, 'profile');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompt = new Answers(
    ['gemini-2.5-flash', 'cli', '0.25', '1', '2', '5', '8192', 'create'],
    [PASSPHRASE, PASSPHRASE],
    [true, true],
  );
  const cli = createCli({
    prompt,
    fetch: discoveryFetch(),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
  });
  expect(
    await cli(['setup', '--profile', profile, '--origin', 'https://router.example', '--json']),
  ).toBe(0);
  return { profile, stdout, stderr };
}

async function seedLegacyProfile(profile: string): Promise<void> {
  const paths = buyerProfilePaths(profile);
  const ledger = new LocalSpendLedger(paths.ledgerPath);
  const legacy = createBuyerPolicy({ ...ledger.currentPolicy(), schemes: ['upto'] });
  const vault = new WalletVault({
    directory: paths.walletDirectory,
    scryptN: 1_024,
    allowWeakTestKdf: true,
  });
  ledger.replacePolicy(legacy, await vault.authenticatePolicyChange(legacy.hash, PASSPHRASE));
  ledger.close();
}

describe('one-command buyer setup and administration', () => {
  it('creates one complete owner-only profile transactionally without exposing secrets', async () => {
    const root = await directory();
    const context = await setupProfile(root);
    const paths = buyerProfilePaths(context.profile);
    const wallet = await new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    }).status();
    expect(wallet).toMatchObject({ initialized: true, encrypted: true });
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    expect(ledger.currentPolicy()).toMatchObject({
      canonicalOrigin: 'https://router.example',
      network: 'eip155:8453',
      models: ['gemini-2.5-flash'],
      requirePerCallConfirmation: true,
    });
    ledger.close();
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.ledgerPath)).mode & 0o777).toBe(0o600);
    const rendered = `${context.stdout.join('')} ${context.stderr.join('')}`;
    expect(rendered).not.toContain(PASSPHRASE);
    expect(JSON.parse(context.stdout.at(-1) ?? '')).toMatchObject({
      version: 1,
      ok: true,
      command: 'setup',
    });
    expect(context.stdout.at(-1)).toContain('Fund');
    expect(context.stdout.at(-1)).toContain('Base mainnet USDC');
  });

  it('accepts every non-secret setup choice in one command', async () => {
    const root = await directory();
    const profile = join(root, 'flagged-profile');
    const stdout: string[] = [];
    const ask = vi.fn(async () => {
      throw new Error('setup unexpectedly prompted for a non-secret value');
    });
    const secret = vi.fn().mockResolvedValueOnce(PASSPHRASE).mockResolvedValueOnce(PASSPHRASE);
    const confirm = vi.fn(async () => {
      throw new Error('setup unexpectedly prompted for confirmation');
    });
    const prompt: PromptIO = {
      ask,
      secret,
      confirm,
    };
    const cli = createCli({
      prompt,
      fetch: discoveryFetch(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });

    expect(
      await cli([
        'setup',
        '--origin',
        'https://router.example',
        '--profile',
        profile,
        '--models',
        'gemini-2.5-flash',
        '--agent',
        'founder-cli-smoke',
        '--per-call-usdc',
        '0.02',
        '--session-usdc',
        '0.06',
        '--hour-usdc',
        '0.06',
        '--day-usdc',
        '0.10',
        '--max-output-tokens',
        '64',
        '--confirm-each',
        'true',
        '--wallet-mode',
        'create',
        '--yes',
        '--json',
      ]),
    ).toBe(0);

    expect(ask).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(secret).toHaveBeenCalledTimes(2);
    const ledger = new LocalSpendLedger(buyerProfilePaths(profile).ledgerPath);
    expect(ledger.currentPolicy()).toMatchObject({
      models: ['gemini-2.5-flash'],
      delegations: [{ agentId: 'founder-cli-smoke', maximumAtomic: 100_000n }],
      limits: {
        perCallAtomic: 20_000n,
        sessionAtomic: 60_000n,
        hourAtomic: 60_000n,
        dayAtomic: 100_000n,
      },
      maximumOutputTokens: 64,
      requirePerCallConfirmation: true,
    });
    ledger.close();
    expect(stdout.join('')).not.toContain(PASSPHRASE);
  });

  it('rejects wallet secrets supplied as setup flags', async () => {
    for (const secretFlag of ['passphrase', 'private-key', 'seed-phrase']) {
      const stdout: string[] = [];
      const cli = createCli({
        prompt: new Answers([], [], []),
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      });
      expect(await cli(['setup', `--${secretFlag}`, 'must-never-be-accepted', '--json'])).toBe(2);
      expect(stdout.join('')).toContain(`unknown option: --${secretFlag}`);
      expect(stdout.join('')).not.toContain('must-never-be-accepted');
    }
  });

  it('passes the passphrase only to the broker starter and keeps JSON output redacted', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const starts: unknown[] = [];
    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [PASSPHRASE], []),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      startBroker: async (request) => {
        starts.push(request);
        return {
          address: '0x3333333333333333333333333333333333333333',
          idleExpiresAt: Date.now() + 60_000,
          absoluteExpiresAt: Date.now() + 120_000,
        };
      },
    });
    expect(await cli(['unlock', '--profile', setup.profile, '--json'])).toBe(0);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ passphrase: PASSPHRASE, agentId: 'cli' });
    expect(stdout.join('')).not.toContain(PASSPHRASE);
    expect(stdout.join('')).not.toContain('capability');
  });

  it('rotates a locked wallet passphrase without changing its address or exposing either secret', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    const wallet = new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    const address = await wallet.verifyPassphrase(PASSPHRASE);
    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [PASSPHRASE, NEW_PASSPHRASE, NEW_PASSPHRASE], []),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });

    expect(await cli(['wallet', 'rotate-passphrase', '--profile', setup.profile, '--json'])).toBe(
      0,
    );
    expect(await wallet.verifyPassphrase(NEW_PASSPHRASE)).toBe(address);
    await expect(wallet.verifyPassphrase(PASSPHRASE)).rejects.toThrow();
    expect(stdout.join('')).not.toContain(PASSPHRASE);
    expect(stdout.join('')).not.toContain(NEW_PASSPHRASE);
    expect(JSON.parse(stdout.at(-1) ?? '')).toMatchObject({
      version: 1,
      ok: true,
      command: 'wallet',
      result: { rotated: true, locked: true, address },
    });
  });

  it('keeps the existing wallet usable when passphrase confirmation does not match', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    const wallet = new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    const cli = createCli({
      prompt: new Answers([], [PASSPHRASE, NEW_PASSPHRASE, 'different confirmation value'], []),
      stdout: () => undefined,
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });

    expect(await cli(['wallet', 'rotate-passphrase', '--profile', setup.profile, '--json'])).toBe(
      2,
    );
    await expect(wallet.verifyPassphrase(PASSPHRASE)).resolves.toMatch(/^0x/);
  });

  it('starts the real broker worker over inherited IPC and removes its session after lock', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    const worker = fork(fileURLToPath(new URL('../src/broker-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const response = await new Promise<unknown>((resolveResponse, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('error', onError);
        worker.off('exit', onExit);
        worker.off('message', onMessage);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.kill('SIGTERM');
        reject(error);
      };
      const onError = (error: Error) => fail(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        fail(
          new Error(
            `broker worker exited before startup (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
          ),
        );
      const onMessage = (message: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResponse(message);
      };
      const timer = setTimeout(
        () => fail(new Error('broker worker test timed out during bounded startup')),
        60_000,
      );
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.once('message', onMessage);
      worker.send(
        {
          version: 1,
          action: 'start',
          profileDirectory: setup.profile,
          passphrase: PASSPHRASE,
          agentId: 'cli',
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 60_000,
        },
        (error) => {
          if (error) fail(new Error('broker worker IPC startup request failed'));
        },
      );
    });
    expect(response).toMatchObject({ version: 1, ok: true });
    const buyer = await OnchainRouterBuyer.connect({ profileDirectory: setup.profile });
    expect(await buyer.status()).toMatchObject({ agentId: 'cli' });
    await buyer.lock();
    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('broker worker did not exit')), 5_000);
        worker.once('error', reject);
        worker.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    await expect(
      OnchainRouterBuyer.connect({ profileDirectory: paths.directory }),
    ).rejects.toMatchObject({ code: 'WalletLocked' });
  }, 20_000);

  it('applies restrictions directly and requires wallet authentication for wider caps', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const stdout: string[] = [];
    const narrow = createCli({
      prompt: new Answers([], [], []),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(
      await narrow([
        'policy',
        'set',
        '--profile',
        setup.profile,
        '--per-call-usdc',
        '0.2',
        '--json',
      ]),
    ).toBe(0);
    expect(stdout.join('')).toContain('restricted');

    const widerOutput: string[] = [];
    const wider = createCli({
      prompt: new Answers([], [PASSPHRASE], []),
      stdout: (value) => widerOutput.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(
      await wider([
        'policy',
        'set',
        '--profile',
        setup.profile,
        '--per-call-usdc',
        '0.3',
        '--json',
      ]),
    ).toBe(0);
    expect(widerOutput.join('')).toContain('human-authorized-replacement');
    expect(widerOutput.join('')).not.toContain(PASSPHRASE);
  });

  it('migrates a legacy upto profile to exact without changing its wallet or financial limits', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    const vaultStatusBefore = await new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    }).status();
    await seedLegacyProfile(setup.profile);

    const rejectedOutput: string[] = [];
    const rejected = createCli({
      prompt: new Answers([], [], []),
      stdout: (value) => rejectedOutput.push(value),
      stderr: () => undefined,
    });
    expect(
      await rejected(['policy', 'set', '--profile', setup.profile, '--scheme', 'upto', '--json']),
    ).toBe(2);
    expect(rejectedOutput.join('')).toContain('exact is the only supported payment scheme');

    const migrate = createCli({
      prompt: new Answers([], [PASSPHRASE], []),
      stdout: () => undefined,
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(
      await migrate(['policy', 'set', '--profile', setup.profile, '--scheme', 'exact', '--json']),
    ).toBe(0);

    const ledger = new LocalSpendLedger(paths.ledgerPath);
    const migrated = ledger.currentPolicy();
    ledger.close();
    const vaultStatusAfter = await new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    }).status();

    expect(migrated).toMatchObject({
      schemes: ['exact'],
      models: ['gemini-2.5-flash'],
      limits: {
        perCallAtomic: 250_000n,
        sessionAtomic: 1_000_000n,
        hourAtomic: 2_000_000n,
        dayAtomic: 5_000_000n,
      },
      delegations: [{ agentId: 'cli', maximumAtomic: 5_000_000n }],
      maximumOutputTokens: 8192,
      requirePerCallConfirmation: true,
    });
    expect(vaultStatusAfter.address).toBe(vaultStatusBefore.address);
  });

  it('writes a redacted diagnostic bundle and treats a locked broker as healthy', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const report = join(root, 'doctor.json');
    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [], []),
      fetch: discoveryFetch(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(await cli(['doctor', '--profile', setup.profile, '--out', report, '--json'])).toBe(0);
    const content = await readFile(report, 'utf8');
    expect(content).toContain('locked (safe default)');
    expect(content).toContain('base_usdc_balance');
    expect(content).toContain('1.25 USDC');
    expect(content).not.toContain('capability');
    expect(content).not.toContain(PASSPHRASE);
    expect(stdout.join('')).not.toContain(PASSPHRASE);
  });

  it('reports an actionable unhealthy result when a legacy profile conflicts with exact discovery', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    await seedLegacyProfile(setup.profile);

    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [], []),
      fetch: discoveryFetch(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(await cli(['doctor', '--profile', setup.profile, '--json'])).toBe(0);
    const envelope = JSON.parse(stdout.at(-1) ?? '') as {
      result: {
        healthy: boolean;
        checks: Array<{ check: string; ok: boolean; detail: string }>;
      };
    };
    expect(envelope.result.healthy).toBe(false);
    expect(envelope.result.checks).toContainEqual({
      check: 'payment_scheme',
      ok: false,
      detail: `profile uses upto; discovery requires exact; run onchain-router policy set --profile ${setup.profile} --scheme exact`,
    });
  });

  it('reports a malformed signer session as unhealthy instead of safely locked', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    await writeFile(paths.sessionPath, '{invalid', { encoding: 'utf8', mode: 0o600 });
    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [], []),
      fetch: discoveryFetch(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      testVaultOptions: { scryptN: 1_024, allowWeakTestKdf: true },
    });
    expect(await cli(['doctor', '--profile', setup.profile, '--json'])).toBe(0);
    const envelope = JSON.parse(stdout.at(-1) ?? '') as {
      result: {
        healthy: boolean;
        checks: Array<{ check: string; ok: boolean; detail: string }>;
      };
    };
    const report = envelope.result;
    expect(report.healthy).toBe(false);
    expect(report.checks).toContainEqual({
      check: 'signer_broker',
      ok: false,
      detail: 'session descriptor is invalid or unavailable',
    });
  });

  it('completes one clean-profile fake paid CLI call and returns only a verified receipt', async () => {
    const root = await directory();
    const setup = await setupProfile(root);
    const paths = buyerProfilePaths(setup.profile);
    const ledger = new LocalSpendLedger(paths.ledgerPath);
    const wallet = new WalletVault({
      directory: paths.walletDirectory,
      scryptN: 1_024,
      allowWeakTestKdf: true,
    });
    const policy = ledger.currentPolicy();
    const broker = new SignerBroker({
      socketPath: paths.socketPath,
      vault: wallet,
      ledger,
      policy,
      agentId: 'cli',
      idleTimeoutMs: 10_000,
      absoluteTimeoutMs: 60_000,
    });
    const session = await broker.start(PASSPHRASE);
    await writeBuyerSession(paths.directory, session);
    const receiptId = randomUUID();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        return new Response(JSON.stringify({ error: 'payment_required' }), {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'payment-required': encodePaymentRequiredHeader({
              x402Version: 2,
              resource: {
                url: 'https://router.example/v1/chat/completions',
                description: 'test',
                mimeType: 'application/json',
              },
              accepts: [
                {
                  scheme: 'exact',
                  network: 'eip155:8453',
                  asset: ASSET,
                  amount: '600',
                  payTo: RECIPIENT,
                  maxTimeoutSeconds: 60,
                  extra: { name: 'USD Coin', version: '2' },
                },
              ],
            }),
          },
        });
      if (calls === 2)
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
                amount: '600',
              }),
              'x-receipt-id': receiptId,
              'x-receipt-token': 'must-stay-in-runtime',
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
          actualAmount: '600',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const stdout: string[] = [];
    const cli = createCli({
      prompt: new Answers([], [], [true]),
      fetch,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });
    try {
      expect(
        await cli([
          'chat',
          'hello',
          '--model',
          'gemini-2.5-flash',
          '--idempotency-key',
          'cli-payment-1',
          '--profile',
          paths.directory,
          '--json',
        ]),
      ).toBe(0);
      expect(calls).toBe(3);
      expect(stdout.join('')).toContain(receiptId);
      expect(stdout.join('')).not.toContain('must-stay-in-runtime');
      expect(ledger.receipt('cli-payment-1')).toMatchObject({ id: receiptId });
    } finally {
      await broker.stop();
      ledger.close();
    }
  });
});
