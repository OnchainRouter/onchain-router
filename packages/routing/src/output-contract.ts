import type { BenchmarkExpectedValue } from './benchmark.js';

export const ROUTING_BENCHMARK_SCORER_VERSION = 'onchain-router-json-field-score/v2' as const;

/** Deliberately small JSON Schema subset: no answer-bearing const, enum, default, or examples. */
export type BenchmarkOutputSchema =
  | { readonly type: 'string' | 'integer' | 'boolean' | 'null' }
  | { readonly type: 'array'; readonly items: BenchmarkOutputSchema }
  | BenchmarkObjectSchema;

export interface BenchmarkObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, BenchmarkOutputSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface BenchmarkAnswerScore {
  readonly qualityBasisPoints: number;
  readonly matchedFields: number;
  readonly expectedFields: number;
  readonly outputContractSatisfied: boolean;
}

interface ContractTask {
  readonly request: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, BenchmarkExpectedValue>>;
  readonly outputSchema: BenchmarkObjectSchema;
}

const MAX_BYTES = 64 * 1024;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function validateBenchmarkOutputContract(task: ContractTask): void {
  const fail = () => {
    throw new Error('routing benchmark output contract is invalid');
  };
  if (
    !task.outputSchema ||
    task.outputSchema.type !== 'object' ||
    Buffer.byteLength(JSON.stringify(task.outputSchema), 'utf8') > MAX_BYTES ||
    Buffer.byteLength(JSON.stringify(task.expected), 'utf8') > MAX_BYTES
  )
    fail();
  validateSchema(task.outputSchema, 0);
  if (!matchesSchema(task.expected, task.outputSchema))
    throw new Error('routing benchmark expected answer violates its output contract');
  const request = task.request;
  if (
    Object.keys(request).some(
      (key) => !['messages', 'max_tokens', 'response_format'].includes(key),
    ) ||
    !Number.isSafeInteger(request['max_tokens']) ||
    Number(request['max_tokens']) < 1 ||
    Number(request['max_tokens']) > 1_000_000 ||
    !Array.isArray(request['messages']) ||
    request['messages'].length < 1 ||
    request['messages'].length > 32 ||
    request['messages'].some(
      (message: unknown, index: number) =>
        !isRecord(message) ||
        !sameKeys(message, ['role', 'content']) ||
        (message['role'] !== 'user' && !(index === 0 && message['role'] === 'system')) ||
        typeof message['content'] !== 'string' ||
        message['content'].trim().length === 0,
    ) ||
    !request['messages'].some((message: Record<string, unknown>) => message['role'] === 'user') ||
    !isRecord(request['response_format']) ||
    !sameKeys(request['response_format'], ['type']) ||
    request['response_format']['type'] !== 'json_object'
  )
    throw new Error('routing benchmark structured request is invalid');
}

/** The identical schema-bearing request is used for quotation and every model completion. */
export function benchmarkTaskRequest(task: ContractTask): Readonly<Record<string, unknown>> {
  validateBenchmarkOutputContract(task);
  const messages = task.request['messages'] as readonly { role: string; content: string }[];
  const first = messages[0];
  const instruction =
    'Return exactly one JSON object, without prose or Markdown. Use exactly the required keys ' +
    'and value types in this JSON Schema; do not rename keys or add fields. Solve the task to ' +
    `determine the values. Output schema: ${canonicalJson(task.outputSchema)}`;
  const request = {
    ...task.request,
    messages: [
      {
        role: 'system',
        content: first?.role === 'system' ? `${first.content}\n\n${instruction}` : instruction,
      },
      ...messages.slice(first?.role === 'system' ? 1 : 0),
    ],
  };
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES)
    throw new Error('routing benchmark schema-bearing request is too large');
  return deepFreeze(JSON.parse(encoded) as Readonly<Record<string, unknown>>);
}

export function scoreBenchmarkAnswer(
  answer: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, BenchmarkExpectedValue>>,
  schema: BenchmarkObjectSchema,
): BenchmarkAnswerScore {
  const expectedEntries = Object.entries(expected);
  const matchedFields = expectedEntries.filter(
    ([key, value]) =>
      Object.hasOwn(answer, key) && canonicalJson(answer[key]) === canonicalJson(value),
  ).length;
  const outputContractSatisfied = matchesSchema(answer, schema);
  return Object.freeze({
    qualityBasisPoints:
      Math.floor((matchedFields * 9_000) / expectedEntries.length) +
      (outputContractSatisfied ? 1_000 : 0),
    matchedFields,
    expectedFields: expectedEntries.length,
    outputContractSatisfied,
  });
}

function validateSchema(schema: unknown, depth: number): asserts schema is BenchmarkOutputSchema {
  const fail = (): never => {
    throw new Error('routing benchmark output schema is invalid');
  };
  if (!isRecord(schema) || depth > 8) return fail();
  switch (schema['type']) {
    case 'string':
    case 'integer':
    case 'boolean':
    case 'null':
      if (!sameKeys(schema, ['type'])) fail();
      return;
    case 'array':
      if (!sameKeys(schema, ['type', 'items'])) fail();
      validateSchema(schema['items'], depth + 1);
      return;
    case 'object': {
      if (
        !sameKeys(schema, ['type', 'properties', 'required', 'additionalProperties']) ||
        schema['additionalProperties'] !== false ||
        !isRecord(schema['properties']) ||
        !Array.isArray(schema['required'])
      )
        return fail();
      const properties = schema['properties'];
      const keys = Object.keys(properties);
      const required = schema['required'] as unknown[];
      if (
        keys.length < 1 ||
        keys.length > 32 ||
        keys.some((key) => !KEY.test(key) || ['constructor', 'prototype'].includes(key)) ||
        required.length !== keys.length ||
        new Set(required).size !== keys.length ||
        required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key))
      )
        fail();
      for (const child of Object.values(properties)) validateSchema(child, depth + 1);
      return;
    }
    default:
      fail();
  }
}

function matchesSchema(value: unknown, schema: BenchmarkOutputSchema): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value) && value.every((item) => matchesSchema(item, schema.items));
    case 'object':
      return (
        isRecord(value) &&
        sameKeys(value, schema.required) &&
        Object.entries(schema.properties).every(([key, child]) => matchesSchema(value[key], child))
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
