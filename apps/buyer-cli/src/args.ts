import { PaymentPolicyRejected } from '@onchainrouter/buyer-core';

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export function parseArguments(input: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item) continue;
    if (item === '--') {
      positionals.push(...input.slice(index + 1));
      break;
    }
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const separator = item.indexOf('=');
    const name = item.slice(2, separator < 0 ? undefined : separator);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new PaymentPolicyRejected(`invalid option: ${item}`);
    let value = separator < 0 ? undefined : item.slice(separator + 1);
    if (value === undefined && input[index + 1] && !input[index + 1]!.startsWith('--')) {
      value = input[index + 1];
      index += 1;
    }
    const values = flags.get(name) ?? [];
    values.push(value ?? 'true');
    flags.set(name, values);
  }
  return { positionals, flags };
}

export function flag(args: ParsedArguments, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function requiredFlag(args: ParsedArguments, name: string): string {
  const value = flag(args, name);
  if (!value || value === 'true') throw new PaymentPolicyRejected(`--${name} requires a value`);
  return value;
}

export function booleanFlag(args: ParsedArguments, name: string, fallback = false): boolean {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  if (value === 'true' || value === 'yes' || value === '1') return true;
  if (value === 'false' || value === 'no' || value === '0') return false;
  throw new PaymentPolicyRejected(`--${name} must be true or false`);
}

export function assertKnownFlags(args: ParsedArguments, names: readonly string[]): void {
  const allowed = new Set(names);
  for (const name of args.flags.keys()) {
    if (!allowed.has(name)) throw new PaymentPolicyRejected(`unknown option: --${name}`);
  }
}
