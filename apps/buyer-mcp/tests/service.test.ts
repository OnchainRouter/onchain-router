import { PaymentPolicyRejected, type BuyerResult } from '@onchainrouter/buyer-core';
import { describe, expect, it, vi } from 'vitest';
import { chatBody, type ChatToolInput } from '../src/contracts.js';
import { createFocusedMcpService } from '../src/service.js';

const INPUT: ChatToolInput = {
  idempotency_key: 'mcp-request-1',
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'hello' }],
  max_output_tokens: 512,
};

const SUCCESS: BuyerResult = {
  ok: true,
  outcome: 'Completed',
  idempotencyKey: INPUT.idempotency_key,
  body: { choices: [{ message: { role: 'assistant', content: 'hello' } }] },
  receipt: {
    id: 'receipt-1',
    operationId: 'operation-1',
    catalogVersion: 'catalog-1',
    model: INPUT.model,
    usage: { inputTokens: '1', outputTokens: '1' },
    settlement: {
      success: true,
      transaction: '0xsettlement',
      network: 'eip155:8453',
      payer: '0x1111111111111111111111111111111111111111',
    },
    maximumAmount: '1000',
    actualAmount: '100',
  },
  payment: {
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipient: '0x2222222222222222222222222222222222222222',
    authorizedMaximumAtomic: '1000',
    actualAtomic: '100',
    transaction: '0xsettlement',
  },
};

describe('focused MCP Buyer Runtime adapter', () => {
  it('forwards only the bounded chat body and the stable idempotency key', async () => {
    const chat = vi.fn(async () => SUCCESS);
    const close = vi.fn();
    const service = createFocusedMcpService({
      profileDirectory: '/tmp/onchain-router-mcp-test',
      dependencies: {
        connectBuyer: async () => ({ chat, close }),
      },
    });
    const result = await service.chat(INPUT, new AbortController().signal);
    expect(result).toBe(SUCCESS);
    expect(chat).toHaveBeenCalledWith(
      {
        model: INPUT.model,
        messages: INPUT.messages,
        max_tokens: 512,
      },
      INPUT.idempotency_key,
    );
    expect(JSON.stringify(chat.mock.calls)).not.toMatch(/origin|recipient|payTo|private|maximum/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it('honors cancellation after connect but before the financial handoff', async () => {
    const controller = new AbortController();
    const chat = vi.fn(async () => SUCCESS);
    const close = vi.fn();
    let finishConnect: ((value: { chat: typeof chat; close: typeof close }) => void) | undefined;
    const service = createFocusedMcpService({
      dependencies: {
        connectBuyer: async () =>
          await new Promise((resolve) => {
            finishConnect = resolve;
          }),
      },
    });
    const pending = service.chat(INPUT, controller.signal);
    await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'));
    controller.abort('client cancelled');
    finishConnect?.({ chat, close });
    await expect(pending).rejects.toBeInstanceOf(PaymentPolicyRejected);
    expect(chat).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not interrupt financial finalization after Buyer Runtime accepts the request', async () => {
    const controller = new AbortController();
    const chat = vi.fn(async () => {
      controller.abort('client disconnected after handoff');
      return SUCCESS;
    });
    const service = createFocusedMcpService({
      dependencies: { connectBuyer: async () => ({ chat, close: vi.fn() }) },
    });
    await expect(service.chat(INPUT, controller.signal)).resolves.toBe(SUCCESS);
    expect(chat).toHaveBeenCalledOnce();
  });

  it('rejects aggregate prompt and body sizes before Buyer Runtime', () => {
    expect(() =>
      chatBody({
        ...INPUT,
        messages: [
          { role: 'user', content: 'a'.repeat(131_072) },
          { role: 'assistant', content: 'b'.repeat(131_072) },
          { role: 'user', content: 'c' },
        ],
      }),
    ).toThrow('chat messages exceed the total local prompt limit');
  });
});
