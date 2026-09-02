import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TerminalPrompt } from '../src/prompt.js';

describe('terminal prompts', () => {
  it('uses a controlling-terminal session when request JSON occupies stdin', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const close = vi.fn();
    input.end('yes\n');
    const prompt = new TerminalPrompt((() => ({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      close,
    })) as never);

    await expect(prompt.confirm('Authorize this bounded payment')).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
