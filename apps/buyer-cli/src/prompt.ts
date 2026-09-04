import { closeSync, openSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ReadStream, WriteStream } from 'node:tty';
import { PaymentPolicyRejected } from '@onchainrouter/buyer-core';

export interface PromptIO {
  ask(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
}

interface InteractiveTerminal {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  close(): void;
}

function controllingTerminal(): InteractiveTerminal {
  if (stdin.isTTY && stdout.isTTY) return { input: stdin, output: stdout, close: () => undefined };
  let inputDescriptor: number | null = null;
  let outputDescriptor: number | null = null;
  try {
    inputDescriptor = openSync('/dev/tty', 'r');
    outputDescriptor = openSync('/dev/tty', 'w');
    const input = new ReadStream(inputDescriptor);
    const output = new WriteStream(outputDescriptor);
    return {
      input,
      output,
      close: () => {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    if (inputDescriptor !== null) closeSync(inputDescriptor);
    if (outputDescriptor !== null) closeSync(outputDescriptor);
    throw new PaymentPolicyRejected('interactive input requires a controlling terminal');
  }
}

export class TerminalPrompt implements PromptIO {
  public constructor(private readonly terminal: () => InteractiveTerminal = controllingTerminal) {}

  public async ask(message: string, defaultValue?: string): Promise<string> {
    const terminal = this.terminal();
    const prompt = `${message}${defaultValue === undefined ? '' : ` [${defaultValue}]`}: `;
    const reader = createInterface({ input: terminal.input, output: terminal.output });
    try {
      const answer = (await reader.question(prompt)).trim();
      return answer || defaultValue || '';
    } finally {
      reader.close();
      terminal.close();
    }
  }

  public async secret(message: string): Promise<string> {
    const terminal = this.terminal();
    const input = terminal.input;
    const output = terminal.output;
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
      terminal.close();
      throw new PaymentPolicyRejected('secret input requires an interactive terminal');
    }
    output.write(`${message}: `);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    try {
      return await new Promise<string>((resolveSecret, reject) => {
        let value = '';
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          input.off('data', onData);
          input.setRawMode(Boolean(wasRaw));
          if (!wasRaw) input.pause();
          output.write('\n');
          if (error) reject(error);
          else resolveSecret(value);
        };
        const onData = (chunk: string) => {
          for (const character of chunk) {
            if (character === '\u0003') {
              finish(new PaymentPolicyRejected('secret input was cancelled'));
              return;
            }
            if (character === '\r' || character === '\n') {
              finish();
              return;
            }
            if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
            else if (character >= ' ') value += character;
          }
        };
        input.on('data', onData);
      });
    } finally {
      terminal.close();
    }
  }

  public async confirm(message: string, defaultValue = false): Promise<boolean> {
    const answer = (await this.ask(`${message} (${defaultValue ? 'Y/n' : 'y/N'})`)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    throw new PaymentPolicyRejected('confirmation must be yes or no');
  }
}
