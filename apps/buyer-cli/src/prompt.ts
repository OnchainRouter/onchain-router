import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { PaymentPolicyRejected } from '@agenticfi/onchain-router-buyer-core';

export interface PromptIO {
  ask(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
}

export class TerminalPrompt implements PromptIO {
  public async ask(message: string, defaultValue?: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY)
      throw new PaymentPolicyRejected('interactive input requires a terminal');
    const prompt = `${message}${defaultValue === undefined ? '' : ` [${defaultValue}]`}: `;
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await reader.question(prompt)).trim();
      return answer || defaultValue || '';
    } finally {
      reader.close();
    }
  }

  public async secret(message: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function')
      throw new PaymentPolicyRejected('secret input requires an interactive terminal');
    stdout.write(`${message}: `);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return await new Promise<string>((resolveSecret, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        stdin.off('data', onData);
        stdin.setRawMode(Boolean(wasRaw));
        if (!wasRaw) stdin.pause();
        stdout.write('\n');
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
      stdin.on('data', onData);
    });
  }

  public async confirm(message: string, defaultValue = false): Promise<boolean> {
    const answer = (await this.ask(`${message} (${defaultValue ? 'Y/n' : 'y/N'})`)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    throw new PaymentPolicyRejected('confirmation must be yes or no');
  }
}
