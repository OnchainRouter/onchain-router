import { describe, expect, it } from 'vitest';
import { BuyerRuntimeError } from '@onchainrouter/buyer-core';
import { safeError } from '../src/format.js';

describe('safe CLI errors', () => {
  it('preserves stable buyer outcomes and redacts unexpected dependency messages', () => {
    expect(
      safeError(
        new BuyerRuntimeError(
          'PaymentPolicyRejected',
          'do_not_retry',
          'model is outside the current policy',
        ),
      ),
    ).toMatchObject({
      code: 'PaymentPolicyRejected',
      retry: 'do_not_retry',
      message: 'model is outside the current policy',
    });
    expect(safeError(new Error('private-key-canary'))).toEqual({
      code: 'RuntimeUnavailable',
      retry: 'do_not_retry',
      message: 'command failed',
    });
  });
});
