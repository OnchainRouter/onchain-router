import { z } from 'zod';
import { ReceiptVerificationFailed } from './errors.js';
import type { EffectiveBuyerPolicy, VerifiedReceipt } from './types.js';

const atomicString = z.string().regex(/^\d+$/);
const receiptSchema = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  catalogVersion: z.string().nullable(),
  model: z.string().nullable(),
  usage: z.record(z.unknown()),
  settlement: z
    .object({
      success: z.literal(true),
      transaction: z.string().min(1).max(256),
      network: z.string().min(1).max(128),
      payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    })
    .strict(),
  maximumAmount: atomicString,
  actualAmount: atomicString,
});

export interface ReceiptExpectation {
  readonly id: string;
  readonly model: string;
  readonly payer: string;
  readonly maximumAtomic: bigint;
  readonly policy: Pick<EffectiveBuyerPolicy, 'network'>;
  readonly settlementAmountAtomic?: bigint;
  readonly settlementTransaction?: string;
}

export function verifyReceipt(value: unknown, expected: ReceiptExpectation): VerifiedReceipt {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw new ReceiptVerificationFailed('receipt schema is invalid');
  const receipt = parsed.data;
  const maximum = BigInt(receipt.maximumAmount);
  const actual = BigInt(receipt.actualAmount);
  if (receipt.id !== expected.id || receipt.operationId !== expected.id)
    throw new ReceiptVerificationFailed('receipt identity does not match the operation');
  if (receipt.model !== expected.model)
    throw new ReceiptVerificationFailed('receipt model does not match the request');
  if (receipt.settlement.network !== expected.policy.network)
    throw new ReceiptVerificationFailed('receipt network does not match policy');
  if (receipt.settlement.payer.toLowerCase() !== expected.payer.toLowerCase())
    throw new ReceiptVerificationFailed('receipt payer does not match the signer');
  if (maximum !== expected.maximumAtomic || actual > maximum)
    throw new ReceiptVerificationFailed('receipt amount exceeds or changes the authorization');
  if (expected.settlementAmountAtomic !== undefined && actual !== expected.settlementAmountAtomic)
    throw new ReceiptVerificationFailed('receipt amount does not match PAYMENT-RESPONSE');
  if (
    expected.settlementTransaction !== undefined &&
    receipt.settlement.transaction !== expected.settlementTransaction
  )
    throw new ReceiptVerificationFailed('receipt transaction does not match PAYMENT-RESPONSE');
  return {
    ...receipt,
    settlement: {
      success: true,
      transaction: receipt.settlement.transaction,
      network: receipt.settlement.network,
      payer: receipt.settlement.payer,
    },
  };
}
