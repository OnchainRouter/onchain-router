import { spawnSync } from 'node:child_process';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const COMMAND = /^[^\0\r\n]+$/;

function runtimeFailure(message, retry = 'do_not_retry') {
  return {
    version: 1,
    ok: false,
    error: {
      code: 'RuntimeUnavailable',
      retry,
      message,
    },
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function executable() {
  const value = process.env.ONCHAIN_ROUTER_CLI?.trim() || 'onchain-router';
  if (!COMMAND.test(value)) throw new Error('configured buyer CLI path is invalid');
  return value;
}

function profileArguments() {
  const value = process.env.ONCHAIN_ROUTER_PROFILE?.trim();
  if (!value) return [];
  if (!COMMAND.test(value)) throw new Error('configured buyer profile path is invalid');
  return ['--profile', value];
}

export function invokeBuyer(request) {
  let encoded;
  try {
    encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES)
      throw new Error('buyer request exceeds 1 MiB');
  } catch {
    emit(runtimeFailure('buyer request could not be encoded safely'));
    return 1;
  }

  let completed;
  try {
    completed = spawnSync(executable(), ['_bridge', ...profileArguments()], {
      input: encoded,
      encoding: 'utf8',
      maxBuffer: MAX_RESPONSE_BYTES,
      shell: false,
      timeout: 330_000,
      windowsHide: true,
    });
  } catch {
    emit(runtimeFailure('onchain-router CLI could not be started'));
    return 1;
  }

  if (completed.error || completed.signal || completed.status !== 0) {
    const didNotStart = completed.error?.code === 'ENOENT' || completed.error?.code === 'EACCES';
    emit(
      runtimeFailure(
        'onchain-router CLI did not complete normally',
        didNotStart ? 'do_not_retry' : 'retry_same_idempotency_key',
      ),
    );
    return 1;
  }

  let envelope;
  try {
    envelope = JSON.parse(completed.stdout);
  } catch {
    emit(
      runtimeFailure('onchain-router CLI returned malformed JSON', 'retry_same_idempotency_key'),
    );
    return 1;
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    envelope.version !== 1 ||
    typeof envelope.ok !== 'boolean'
  ) {
    emit(
      runtimeFailure(
        'onchain-router CLI returned an invalid envelope',
        'retry_same_idempotency_key',
      ),
    );
    return 1;
  }
  emit(envelope);
  return envelope.ok ? 0 : 1;
}
