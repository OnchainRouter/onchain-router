import { BuyerRuntimeError } from '@onchainrouter/buyer-core';

export function safeJson(value: unknown, spacing?: number): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
    spacing,
  );
}

export function safeError(error: unknown): {
  code: string;
  retry: string;
  message: string;
  reference?: string;
} {
  if (error instanceof BuyerRuntimeError)
    return {
      code: error.code,
      retry: error.retry,
      message: error.message,
      ...(error.reference ? { reference: error.reference } : {}),
    };
  return {
    code: 'RuntimeUnavailable',
    retry: 'do_not_retry',
    message: 'command failed',
  };
}
