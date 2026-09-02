import { PERMIT2_ADDRESS } from '@x402/evm';
import { encodeFunctionData, parseAbi } from 'viem';

import { PaymentPolicyRejected } from './errors.js';

const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Build an ERC-20 approval fixed to canonical Permit2 and a caller-reviewed finite amount. */
export function createBoundedPermit2ApprovalTx(
  asset: `0x${string}`,
  amountAtomic: bigint,
): { readonly to: `0x${string}`; readonly data: `0x${string}` } {
  if (amountAtomic <= 0n)
    throw new PaymentPolicyRejected('Permit2 approval amount must be positive');
  return {
    to: asset,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, amountAtomic],
    }),
  };
}
