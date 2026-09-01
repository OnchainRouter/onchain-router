import { readStdin } from './read-stdin.mjs';

import { invokeBuyer } from './cli-bridge.mjs';

function argumentsByName(input) {
  const values = new Map();
  for (let index = 0; index < input.length; index += 2) {
    const name = input[index];
    const value = input[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new Error('every option requires one value');
    const key = name.slice(2);
    if (!['model', 'max-output-tokens', 'idempotency-key'].includes(key))
      throw new Error(`unknown option: ${name}`);
    if (values.has(key)) throw new Error(`duplicate option: ${name}`);
    values.set(key, value);
  }
  return values;
}

try {
  const values = argumentsByName(process.argv.slice(2));
  const model = values.get('model');
  const prompt = await readStdin(128 * 1024);
  const maxTokens = values.get('max-output-tokens') ?? '1024';
  const idempotencyKey = values.get('idempotency-key');
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(model))
    throw new Error('--model requires a valid live alias');
  if (!prompt || Buffer.byteLength(prompt, 'utf8') > 128 * 1024)
    throw new Error('prompt stdin is required and must not exceed 128 KiB');
  if (!/^\d+$/.test(maxTokens) || BigInt(maxTokens) < 1n || BigInt(maxTokens) > 65_536n)
    throw new Error('--max-output-tokens must be an integer between 1 and 65536');
  if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey))
    throw new Error('--idempotency-key requires a stable caller-owned identifier');
  process.exitCode = invokeBuyer({
    action: 'execute',
    endpoint: '/v1/chat/completions',
    idempotencyKey,
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: Number(maxTokens),
      stream: false,
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'invalid arguments'}\n`);
  process.exitCode = 2;
}
