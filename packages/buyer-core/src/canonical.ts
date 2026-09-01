import { createHash } from 'node:crypto';
import { PaymentPolicyRejected } from './errors.js';

function canonical(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new PaymentPolicyRejected('JSON contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new PaymentPolicyRejected('JSON contains a cycle');
    ancestors.add(value);
    const result = value.map((item) => canonical(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new PaymentPolicyRejected('JSON contains a non-plain object');
    if (ancestors.has(value)) throw new PaymentPolicyRejected('JSON contains a cycle');
    ancestors.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new PaymentPolicyRejected('JSON contains an undefined value');
      result[key] = canonical(item, ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new PaymentPolicyRejected('value is not canonical JSON');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new WeakSet<object>()));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
