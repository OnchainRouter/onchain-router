import { McpServer } from '@modelcontextprotocol/server';
import { BuyerRuntimeError, PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';
import {
  MEDIA_ENDPOINTS,
  prepareMediaBody,
  type MediaEndpoint,
  type PaidJsonEndpoint,
} from '@agenticfi/onchain-router';
import {
  chatInputSchema,
  modelsInputSchema,
  receiptInputSchema,
  walletInputSchema,
  messagesInputSchema,
  imageInputSchema,
  speechInputSchema,
  transcriptionInputSchema,
} from './contracts.js';
import { createFocusedMcpService, type FocusedMcpService } from './service.js';

export const MCP_SERVER_NAME = 'onchain-router';
export const MCP_SERVER_VERSION = '0.1.3';
export const MCP_TOOL_NAMES = [
  'onchain_router_models',
  'onchain_router_chat',
  'onchain_router_wallet',
  'onchain_router_receipt',
  'onchain_router_messages',
  'onchain_router_images',
  'onchain_router_speech',
  'onchain_router_transcriptions',
  'onchain_router_voices',
] as const;

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function result(value: object, isError = false) {
  return {
    content: [{ type: 'text' as const, text: safeJson(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown) {
  if (error instanceof BuyerRuntimeError)
    return result(
      {
        ok: false,
        outcome: error.code,
        retry: error.retry,
        message: error.message,
        ...(error.reference ? { reference: error.reference } : {}),
      },
      true,
    );
  if (error instanceof Error && error.message.startsWith('chat '))
    return result(
      {
        ok: false,
        outcome: 'PaymentPolicyRejected',
        retry: 'do_not_retry',
        message: error.message,
      },
      true,
    );
  return result(
    {
      ok: false,
      outcome: 'RuntimeUnavailable',
      retry: 'retry_same_idempotency_key',
      message: 'buyer runtime is unavailable',
    },
    true,
  );
}

export interface CreateFocusedMcpServerOptions {
  readonly service?: FocusedMcpService;
  readonly profileDirectory?: string;
}

export function createFocusedMcpServer(options: CreateFocusedMcpServerOptions = {}): McpServer {
  const service =
    options.service ??
    createFocusedMcpService({
      ...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}),
    });
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    'onchain_router_models',
    {
      title: 'Onchain Router models',
      description:
        'List the live model/pricing catalog and the local allowlist, output ceiling, and USDC limits. Free; does not unlock or spend.',
      inputSchema: modelsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        return result({ ok: true, ...(await service.models()) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'onchain_router_chat',
    {
      title: 'Onchain Router chat',
      description:
        'Make one paid, non-streaming chat request. This can spend Base USDC. Local policy fixes the origin, network, asset, recipients, model allowlist, output ceiling, and every monetary cap; this tool cannot widen them.',
      inputSchema: chatInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        const outcome = await service.chat(input, context.mcpReq.signal);
        return result(outcome, !outcome.ok);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'onchain_router_wallet',
    {
      title: 'Onchain Router wallet status',
      description:
        'Read encrypted-wallet address, Base USDC balance, lock state, local policy, session spend, and delegations. Cannot unlock, export keys, sign arbitrary data, or change authority.',
      inputSchema: walletInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        return result({ ok: true, ...(await service.wallet()) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'onchain_router_receipt',
    {
      title: 'Onchain Router receipt',
      description:
        'Read a durable receipt already verified and committed by Buyer Runtime using the original idempotency key. Free; returns no receipt capability token.',
      inputSchema: receiptInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ idempotency_key }) => {
      try {
        const receipt = await service.receipt(idempotency_key);
        if (!receipt)
          return result(
            {
              ok: false,
              outcome: 'ReceiptNotFound',
              retry: 'do_not_retry',
              message: 'receipt was not found in the local ledger',
            },
            true,
          );
        return result({ ok: true, receipt });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  function registerPaid(
    name: string,
    description: string,
    inputSchema:
      | typeof messagesInputSchema
      | typeof imageInputSchema
      | typeof speechInputSchema
      | typeof transcriptionInputSchema,
    endpoint: PaidJsonEndpoint,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (
        input: { idempotency_key: string; [key: string]: unknown },
        context: { mcpReq: { signal: AbortSignal } },
      ) => {
        try {
          if (!service.execute)
            throw new PaymentPolicyRejected(
              'this adapter does not support the requested capability',
            );
          const { idempotency_key, ...body } = input;
          if (
            Buffer.byteLength(JSON.stringify(body)) >
            (endpoint === '/v1/audio/transcriptions' ? 1_114_112 : 131_072)
          )
            throw new PaymentPolicyRejected('tool input exceeds its local byte limit');
          if (MEDIA_ENDPOINTS.includes(endpoint as MediaEndpoint))
            prepareMediaBody(endpoint as MediaEndpoint, body);
          const outcome = await service.execute(
            endpoint,
            body,
            idempotency_key,
            context.mcpReq.signal,
          );
          return result(outcome, !outcome.ok);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
  registerPaid(
    'onchain_router_messages',
    'Paid Anthropic-style text messages on Base USDC. Use live catalog models and the same key for recovery. Cannot change wallet policy.',
    messagesInputSchema,
    '/v1/messages',
  );
  registerPaid(
    'onchain_router_images',
    'Generate one paid image with a live catalog model and specification. Returns a hosted URL with its expiry; download before expiry. Spends Base USDC.',
    imageInputSchema,
    '/v1/images/generations',
  );
  registerPaid(
    'onchain_router_speech',
    'Generate paid speech as hosted MP3 with an expiry. Voice must be a public compatible alias. Spends Base USDC.',
    speechInputSchema,
    '/v1/audio/speech',
  );
  registerPaid(
    'onchain_router_transcriptions',
    'Transcribe bounded MP3 Base64. Spends Base USDC. ElevenLabs may retain audio/transcripts independently of Onchain Router deletion; obtain permission and acknowledge retention before upload. No file paths or remote URLs.',
    transcriptionInputSchema,
    '/v1/audio/transcriptions',
  );
  server.registerTool(
    'onchain_router_voices',
    {
      description:
        'List current public voice aliases, model compatibility, and defaults. Free; does not unlock or spend.',
      inputSchema: modelsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        if (!service.voices) throw new PaymentPolicyRejected('voice discovery is unavailable');
        return result({ ok: true, ...(await service.voices()) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  return server;
}
