import { createHash } from 'node:crypto';
import { routingPolicyHash } from './policy.js';
import {
  ROUTING_BENCHMARK_SCORER_VERSION,
  benchmarkTaskRequest,
  deepFreeze,
  scoreBenchmarkAnswer,
  type BenchmarkAnswerScore,
  type BenchmarkObjectSchema,
} from './output-contract.js';
import type {
  RouteModel,
  RouteProfile,
  RouteQuotePort,
  RoutingPolicy,
  SmartRoutingPort,
} from './types.js';

export const ROUTING_BENCHMARK_VERSION = 'onchain-router-routing-benchmark/v2' as const;
export const ROUTING_BENCHMARK_REPORT_VERSION =
  'onchain-router-routing-benchmark-report/v2' as const;
export const ROUTING_CALIBRATION_VERSION = 'onchain-router-routing-calibration/v2' as const;
export const ROUTING_CALIBRATION_REPORT_VERSION =
  'onchain-router-routing-calibration-report/v2' as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EXPECTED_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_TASKS = 32;
const MAX_MODELS = 16;
const MAX_EXPECTED_FIELDS = 32;
const MAX_COMPLETION_BYTES = 64 * 1024;
const MAX_EXPECTED_DEPTH = 8;

type JsonScalar = string | number | boolean | null;
export type BenchmarkExpectedValue =
  | JsonScalar
  | readonly BenchmarkExpectedValue[]
  | { readonly [key: string]: BenchmarkExpectedValue };

export interface RoutingBenchmarkTask {
  readonly id: string;
  readonly profile: RouteProfile;
  readonly request: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, BenchmarkExpectedValue>>;
  readonly outputSchema: BenchmarkObjectSchema;
  readonly minimumQualityBasisPoints: number;
  /** Selected quote maximum may be this fraction of the fixed baseline quote maximum. */
  readonly maximumCostRatioBasisPoints: number;
}

export interface RoutingBenchmarkFixture {
  readonly version: typeof ROUTING_BENCHMARK_VERSION;
  readonly name: string;
  readonly baselineModel: string;
  readonly minimumAggregateQualityGainBasisPoints: number;
  readonly tasks: readonly RoutingBenchmarkTask[];
}

export interface RoutingCalibrationTask {
  readonly id: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, BenchmarkExpectedValue>>;
  readonly outputSchema: BenchmarkObjectSchema;
}

export interface RoutingCalibrationFixture {
  readonly version: typeof ROUTING_CALIBRATION_VERSION;
  readonly name: string;
  readonly models: readonly string[];
  readonly tasks: readonly RoutingCalibrationTask[];
}

/** Consumed v1 artifacts are hashable for historical evidence, never executable by this runner. */
export interface ArchivedRoutingBenchmarkFixture extends Omit<
  RoutingBenchmarkFixture,
  'version' | 'tasks'
> {
  readonly version: 'onchain-router-routing-benchmark/v1';
  readonly tasks: readonly Omit<RoutingBenchmarkTask, 'outputSchema'>[];
}

export interface ArchivedRoutingCalibrationFixture extends Omit<
  RoutingCalibrationFixture,
  'version' | 'tasks'
> {
  readonly version: 'onchain-router-routing-calibration/v1';
  readonly tasks: readonly Omit<RoutingCalibrationTask, 'outputSchema'>[];
}

export interface RoutingBenchmarkCompletion {
  /** OpenAI-compatible response body. Content is scored in memory and never copied to the report. */
  readonly body: unknown;
  readonly latencyMs: number;
}

export interface RoutingBenchmarkProviderPort {
  complete(input: {
    readonly taskId: string;
    readonly model: string;
    readonly request: Readonly<Record<string, unknown>>;
  }): Promise<RoutingBenchmarkCompletion>;
}

export interface RoutingBenchmarkTaskResult {
  readonly taskId: string;
  readonly profile: RouteProfile;
  readonly selectedModel: string;
  readonly baselineModel: string;
  readonly selectedMaximumAtomic: string;
  readonly baselineMaximumAtomic: string;
  readonly maximumCostRatioBasisPoints: number;
  readonly withinCostBudget: boolean;
  readonly selectedQualityBasisPoints: number;
  readonly baselineQualityBasisPoints: number;
  readonly selectedMatchedFields: number;
  readonly baselineMatchedFields: number;
  readonly expectedFields: number;
  readonly selectedOutputContractSatisfied: boolean;
  readonly baselineOutputContractSatisfied: boolean;
  readonly qualityGainBasisPoints: number;
  readonly selectedLatencyMs: number;
  readonly baselineLatencyMs: number;
  readonly minimumQualityBasisPoints: number;
  readonly passed: boolean;
}

export interface RoutingBenchmarkReport {
  readonly version: typeof ROUTING_BENCHMARK_REPORT_VERSION;
  readonly benchmarkVersion: typeof ROUTING_BENCHMARK_VERSION;
  readonly scorerVersion: typeof ROUTING_BENCHMARK_SCORER_VERSION;
  readonly suite: string;
  readonly suiteHash: string;
  readonly policyHash: string;
  readonly modelPriorsHash: string;
  readonly catalogVersion: string;
  readonly baselineModel: string;
  readonly providerCalls: number;
  readonly taskCount: number;
  readonly aggregateSelectedQualityBasisPoints: number;
  readonly aggregateBaselineQualityBasisPoints: number;
  readonly aggregateQualityGainBasisPoints: number;
  readonly minimumAggregateQualityGainBasisPoints: number;
  readonly passed: boolean;
  readonly tasks: readonly RoutingBenchmarkTaskResult[];
}

export interface RoutingCalibrationTaskResult {
  readonly taskId: string;
  readonly model: string;
  readonly maximumAtomic: string;
  readonly qualityBasisPoints: number;
  readonly matchedFields: number;
  readonly expectedFields: number;
  readonly outputContractSatisfied: boolean;
  readonly latencyMs: number;
}

export interface RoutingCalibrationModelResult {
  readonly model: string;
  readonly aggregateQualityBasisPoints: number;
  readonly totalMaximumAtomic: string;
  readonly taskCount: number;
}

export interface RoutingCalibrationReport {
  readonly version: typeof ROUTING_CALIBRATION_REPORT_VERSION;
  readonly calibrationVersion: typeof ROUTING_CALIBRATION_VERSION;
  readonly scorerVersion: typeof ROUTING_BENCHMARK_SCORER_VERSION;
  readonly suite: string;
  readonly suiteHash: string;
  readonly catalogVersion: string;
  readonly providerCalls: number;
  readonly taskCount: number;
  readonly modelCount: number;
  readonly models: readonly RoutingCalibrationModelResult[];
  readonly tasks: readonly RoutingCalibrationTaskResult[];
}

export interface RunRoutingCalibrationInput {
  readonly fixture: RoutingCalibrationFixture;
  readonly models: readonly RouteModel[];
  readonly quotes: RouteQuotePort;
  readonly localMaximumAtomic: bigint;
  readonly provider: RoutingBenchmarkProviderPort;
  readonly now?: () => number;
}

export interface RunRoutingBenchmarkInput {
  readonly fixture: RoutingBenchmarkFixture;
  readonly router: SmartRoutingPort;
  readonly policy: RoutingPolicy;
  readonly models: readonly RouteModel[];
  readonly localMaximumAtomic: bigint;
  readonly provider: RoutingBenchmarkProviderPort;
  readonly now?: () => number;
}

export async function runRoutingCalibration(
  input: RunRoutingCalibrationInput,
): Promise<RoutingCalibrationReport> {
  const fixture = snapshotFixture(input.fixture);
  validateCalibrationFixture(fixture);
  if (input.localMaximumAtomic <= 0n)
    throw new Error('routing calibration local maximum must be positive');
  const modelById = new Map(input.models.map((model) => [model.id, model] as const));
  if (
    input.models.length !== fixture.models.length ||
    fixture.models.some((model) => {
      const candidate = modelById.get(model);
      return (
        !candidate?.enabled ||
        candidate.category !== 'text_generation' ||
        !candidate.capabilities.includes('text') ||
        !candidate.capabilities.includes('json') ||
        !Number.isSafeInteger(candidate.maximumOutputTokens) ||
        candidate.maximumOutputTokens < 1
      );
    })
  )
    throw new Error('routing calibration models do not match the enabled fixture models');

  const now = input.now ?? Date.now;
  for (const task of fixture.tasks) {
    const requestedMaximum = Number(task.request['max_tokens']);
    if (
      fixture.models.some(
        (model) => requestedMaximum > (modelById.get(model)?.maximumOutputTokens ?? 0),
      )
    )
      throw new Error('routing calibration request exceeds the model output limit');
  }
  const quotes = new Map<string, bigint>();
  const catalogVersions = new Set<string>();
  for (const task of fixture.tasks) {
    const request = benchmarkTaskRequest(task);
    for (const model of fixture.models) {
      const quote = await input.quotes.quote({
        kind: 'openai',
        endpoint: '/v1/chat/completions',
        model,
        request: Object.freeze({ ...request, model }),
      });
      if (quote.model !== model || quote.maximumAtomic <= 0n)
        throw new Error('routing calibration quote is invalid');
      if (!IDENTIFIER.test(quote.catalogVersion) || quote.expiresAt <= now())
        throw new Error('routing calibration quote is invalid');
      if (quote.maximumAtomic > input.localMaximumAtomic)
        throw new Error('routing calibration quote exceeds the local maximum');
      quotes.set(`${task.id}\0${model}`, quote.maximumAtomic);
      catalogVersions.add(quote.catalogVersion);
    }
  }
  if (catalogVersions.size !== 1)
    throw new Error('routing calibration quotes changed catalog during the suite');

  const taskResults: RoutingCalibrationTaskResult[] = [];
  for (const task of fixture.tasks) {
    const request = benchmarkTaskRequest(task);
    for (const model of fixture.models) {
      const maximumAtomic = quotes.get(`${task.id}\0${model}`);
      if (maximumAtomic === undefined) throw new Error('routing calibration quote is missing');
      const completion = await input.provider.complete({
        taskId: task.id,
        model,
        request: Object.freeze({ ...request, model }),
      });
      taskResults.push(
        Object.freeze({
          taskId: task.id,
          model,
          maximumAtomic: maximumAtomic.toString(),
          ...scoreCompletion(completion, task),
          latencyMs: validLatency(completion.latencyMs),
        }),
      );
    }
  }

  const modelResults = fixture.models.map((model) => {
    const results = taskResults.filter((result) => result.model === model);
    return Object.freeze({
      model,
      aggregateQualityBasisPoints: average(results.map((result) => result.qualityBasisPoints)),
      totalMaximumAtomic: results
        .reduce((total, result) => total + BigInt(result.maximumAtomic), 0n)
        .toString(),
      taskCount: results.length,
    });
  });
  const catalogVersion = [...catalogVersions][0];
  if (!catalogVersion) throw new Error('routing calibration omitted the catalog version');
  return Object.freeze({
    version: ROUTING_CALIBRATION_REPORT_VERSION,
    calibrationVersion: fixture.version,
    scorerVersion: ROUTING_BENCHMARK_SCORER_VERSION,
    suite: fixture.name,
    suiteHash: calibrationFixtureHash(fixture),
    catalogVersion,
    providerCalls: taskResults.length,
    taskCount: fixture.tasks.length,
    modelCount: fixture.models.length,
    models: Object.freeze(modelResults),
    tasks: Object.freeze(taskResults),
  });
}

export async function runRoutingBenchmark(
  input: RunRoutingBenchmarkInput,
): Promise<RoutingBenchmarkReport> {
  const fixture = snapshotFixture(input.fixture);
  validateFixture(fixture);
  if (input.localMaximumAtomic <= 0n)
    throw new Error('routing benchmark local maximum must be positive');
  if (input.models.length < 2 || input.models.length > MAX_MODELS)
    throw new Error('routing benchmark candidate count is invalid');
  if (!input.models.some((model) => model.id === fixture.baselineModel && model.enabled))
    throw new Error('routing benchmark baseline is not an enabled candidate');

  const policyHash = routingPolicyHash(input.policy);
  const now = input.now ?? Date.now;
  const results: RoutingBenchmarkTaskResult[] = [];
  const catalogVersions = new Set<string>();
  let providerCalls = 0;

  for (const task of fixture.tasks) {
    const request = benchmarkTaskRequest(task);
    const decision = await input.router.route({
      endpoint: '/v1/chat/completions',
      kind: 'openai',
      profile: task.profile,
      body: request,
      models: input.models,
      localMaximumAtomic: input.localMaximumAtomic,
      now: now(),
    });
    if (decision.policyHash !== policyHash)
      throw new Error('routing benchmark decision used a different policy');
    catalogVersions.add(decision.catalogVersion);
    const baseline = decision.routes.find((route) => route.model === fixture.baselineModel);
    if (!baseline) throw new Error(`routing benchmark baseline unavailable for ${task.id}`);

    const selectedCompletion = await input.provider.complete({
      taskId: task.id,
      model: decision.selectedModel,
      request: Object.freeze({ ...request, model: decision.selectedModel }),
    });
    providerCalls += 1;
    const selectedScore = scoreCompletion(selectedCompletion, task);
    const selectedQuality = selectedScore.qualityBasisPoints;
    const baselineCompletion =
      decision.selectedModel === fixture.baselineModel
        ? selectedCompletion
        : await input.provider.complete({
            taskId: task.id,
            model: fixture.baselineModel,
            request: Object.freeze({ ...request, model: fixture.baselineModel }),
          });
    if (decision.selectedModel !== fixture.baselineModel) providerCalls += 1;

    const baselineScore = scoreCompletion(baselineCompletion, task);
    const baselineQuality = baselineScore.qualityBasisPoints;
    const selectedMaximum = BigInt(decision.selectedMaximumAtomic);
    const baselineMaximum = BigInt(baseline.maximumAtomic);
    const withinCostBudget =
      selectedMaximum * 10_000n <= baselineMaximum * BigInt(task.maximumCostRatioBasisPoints);
    const qualityGain = selectedQuality - baselineQuality;
    const passed = selectedQuality >= task.minimumQualityBasisPoints && withinCostBudget;
    results.push(
      Object.freeze({
        taskId: task.id,
        profile: task.profile,
        selectedModel: decision.selectedModel,
        baselineModel: fixture.baselineModel,
        selectedMaximumAtomic: decision.selectedMaximumAtomic,
        baselineMaximumAtomic: baseline.maximumAtomic,
        maximumCostRatioBasisPoints: task.maximumCostRatioBasisPoints,
        withinCostBudget,
        selectedQualityBasisPoints: selectedQuality,
        baselineQualityBasisPoints: baselineQuality,
        selectedMatchedFields: selectedScore.matchedFields,
        baselineMatchedFields: baselineScore.matchedFields,
        expectedFields: selectedScore.expectedFields,
        selectedOutputContractSatisfied: selectedScore.outputContractSatisfied,
        baselineOutputContractSatisfied: baselineScore.outputContractSatisfied,
        qualityGainBasisPoints: qualityGain,
        selectedLatencyMs: validLatency(selectedCompletion.latencyMs),
        baselineLatencyMs: validLatency(baselineCompletion.latencyMs),
        minimumQualityBasisPoints: task.minimumQualityBasisPoints,
        passed,
      }),
    );
  }

  if (catalogVersions.size !== 1)
    throw new Error('routing benchmark quotes changed catalog during the suite');
  const selectedQuality = average(results.map((result) => result.selectedQualityBasisPoints));
  const baselineQuality = average(results.map((result) => result.baselineQualityBasisPoints));
  const qualityGain = selectedQuality - baselineQuality;
  const catalogVersion = [...catalogVersions][0];
  if (!catalogVersion) throw new Error('routing benchmark omitted the catalog version');

  return Object.freeze({
    version: ROUTING_BENCHMARK_REPORT_VERSION,
    benchmarkVersion: fixture.version,
    scorerVersion: ROUTING_BENCHMARK_SCORER_VERSION,
    suite: fixture.name,
    suiteHash: benchmarkFixtureHash(fixture),
    policyHash,
    modelPriorsHash: routingModelPriorsHash(input.models),
    catalogVersion,
    baselineModel: fixture.baselineModel,
    providerCalls,
    taskCount: results.length,
    aggregateSelectedQualityBasisPoints: selectedQuality,
    aggregateBaselineQualityBasisPoints: baselineQuality,
    aggregateQualityGainBasisPoints: qualityGain,
    minimumAggregateQualityGainBasisPoints: fixture.minimumAggregateQualityGainBasisPoints,
    passed:
      results.every((result) => result.passed) &&
      qualityGain >= fixture.minimumAggregateQualityGainBasisPoints,
    tasks: Object.freeze(results),
  });
}

export function benchmarkFixtureHash(
  fixture: RoutingBenchmarkFixture | ArchivedRoutingBenchmarkFixture,
): string {
  validateFixture(fixture, true);
  return createHash('sha256').update(canonicalJson(fixture)).digest('hex');
}

export function routingModelPriorsHash(models: readonly RouteModel[]): string {
  if (models.length < 2 || models.length > MAX_MODELS)
    throw new Error('routing benchmark model-prior count is invalid');
  const ids = new Set<string>();
  const normalized = models
    .map((model) => {
      if (!MODEL.test(model.id) || ids.has(model.id))
        throw new Error('routing benchmark model-prior identity is invalid');
      ids.add(model.id);
      const qualityBasisPoints = Object.fromEntries(
        Object.entries(model.qualityBasisPoints)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([task, quality]) => {
            if (
              !['general', 'code', 'reasoning', 'tool-use', 'vision'].includes(task) ||
              !Number.isSafeInteger(quality) ||
              quality < 0 ||
              quality > 10_000
            )
              throw new Error('routing benchmark model quality prior is invalid');
            return [task, quality];
          }),
      );
      if (
        model.preferenceBasisPoints !== undefined &&
        (!Number.isSafeInteger(model.preferenceBasisPoints) ||
          model.preferenceBasisPoints < 0 ||
          model.preferenceBasisPoints > 10_000)
      )
        throw new Error('routing benchmark model preference prior is invalid');
      return {
        id: model.id,
        qualityBasisPoints,
        ...(model.preferenceBasisPoints === undefined
          ? {}
          : { preferenceBasisPoints: model.preferenceBasisPoints }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

export function calibrationFixtureHash(
  fixture: RoutingCalibrationFixture | ArchivedRoutingCalibrationFixture,
): string {
  validateCalibrationFixture(fixture, true);
  return createHash('sha256').update(canonicalJson(fixture)).digest('hex');
}

function scoreCompletion(
  completion: RoutingBenchmarkCompletion,
  task: RoutingCalibrationTask,
): BenchmarkAnswerScore {
  validLatency(completion.latencyMs);
  const text = completionText(completion.body);
  const answer = parseAnswer(text);
  return scoreBenchmarkAnswer(answer, task.expected, task.outputSchema);
}

function completionText(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new Error('benchmark response is malformed');
  const choices = (body as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length !== 1)
    throw new Error('benchmark response must contain exactly one choice');
  const first: unknown = (choices as readonly unknown[])[0];
  if (typeof first !== 'object' || first === null)
    throw new Error('benchmark response choice is malformed');
  if ((first as Record<string, unknown>)['finish_reason'] === 'length')
    throw new Error('benchmark response was truncated');
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null)
    throw new Error('benchmark response message is malformed');
  const content = (message as Record<string, unknown>)['content'];
  if (
    typeof content !== 'string' ||
    content.length === 0 ||
    Buffer.byteLength(content, 'utf8') > MAX_COMPLETION_BYTES
  )
    throw new Error('benchmark response content is invalid');
  return content;
}

function parseAnswer(text: string): Readonly<Record<string, unknown>> {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('benchmark response is not one JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('benchmark response is not one JSON object');
  return parsed as Readonly<Record<string, unknown>>;
}

function validateFixture(
  fixture: RoutingBenchmarkFixture | ArchivedRoutingBenchmarkFixture,
  allowArchive = false,
): void {
  if (
    fixture.version !== ROUTING_BENCHMARK_VERSION &&
    !(allowArchive && fixture.version === 'onchain-router-routing-benchmark/v1')
  )
    throw new Error('routing benchmark version is unsupported');
  if (!IDENTIFIER.test(fixture.name) || !IDENTIFIER.test(fixture.baselineModel))
    throw new Error('routing benchmark identity is invalid');
  if (
    !Number.isSafeInteger(fixture.minimumAggregateQualityGainBasisPoints) ||
    fixture.minimumAggregateQualityGainBasisPoints < 0 ||
    fixture.minimumAggregateQualityGainBasisPoints > 10_000
  )
    throw new Error('routing benchmark aggregate gain is invalid');
  if (fixture.tasks.length < 2 || fixture.tasks.length > MAX_TASKS)
    throw new Error('routing benchmark task count is invalid');
  const ids = new Set<string>();
  for (const task of fixture.tasks) {
    if (!IDENTIFIER.test(task.id) || ids.has(task.id))
      throw new Error('routing benchmark task identity is invalid');
    ids.add(task.id);
    if (!['eco', 'auto', 'premium'].includes(task.profile))
      throw new Error(`${task.id} routing profile is invalid`);
    const fields = Object.keys(task.expected);
    if (fields.length < 1 || fields.length > MAX_EXPECTED_FIELDS)
      throw new Error(`${task.id} expected answer is invalid`);
    for (const [key, value] of Object.entries(task.expected)) {
      if (!EXPECTED_KEY.test(key)) throw new Error(`${task.id} expected answer is invalid`);
      validateExpectedValue(value, 0, task.id);
    }
    if (
      !Number.isSafeInteger(task.minimumQualityBasisPoints) ||
      task.minimumQualityBasisPoints < 0 ||
      task.minimumQualityBasisPoints > 10_000
    )
      throw new Error(`${task.id} minimum quality is invalid`);
    if (
      !Number.isSafeInteger(task.maximumCostRatioBasisPoints) ||
      task.maximumCostRatioBasisPoints < 1 ||
      task.maximumCostRatioBasisPoints > 100_000
    )
      throw new Error(`${task.id} cost ratio is invalid`);
    const request = snapshotRequest(task.request);
    if ('model' in request) throw new Error(`${task.id} benchmark request must omit model`);
    if (!Array.isArray(request['messages']) || request['messages'].length < 1)
      throw new Error(`${task.id} benchmark messages are invalid`);
    if (
      !Number.isSafeInteger(request['max_tokens']) ||
      Number(request['max_tokens']) < 1 ||
      Number(request['max_tokens']) > 1_000_000
    )
      throw new Error(`${task.id} benchmark max_tokens is invalid`);
    if (fixture.version === ROUTING_BENCHMARK_VERSION)
      benchmarkTaskRequest(task as RoutingBenchmarkTask);
  }
}

function validateCalibrationFixture(
  fixture: RoutingCalibrationFixture | ArchivedRoutingCalibrationFixture,
  allowArchive = false,
): void {
  if (
    fixture.version !== ROUTING_CALIBRATION_VERSION &&
    !(allowArchive && fixture.version === 'onchain-router-routing-calibration/v1')
  )
    throw new Error('routing calibration version is unsupported');
  if (!IDENTIFIER.test(fixture.name)) throw new Error('routing calibration identity is invalid');
  if (
    fixture.models.length < 2 ||
    fixture.models.length > MAX_MODELS ||
    fixture.models.some((model) => !MODEL.test(model)) ||
    new Set(fixture.models).size !== fixture.models.length
  )
    throw new Error('routing calibration model set is invalid');
  if (fixture.tasks.length < 2 || fixture.tasks.length > MAX_TASKS)
    throw new Error('routing calibration task count is invalid');
  const ids = new Set<string>();
  for (const task of fixture.tasks) {
    if (!IDENTIFIER.test(task.id) || ids.has(task.id))
      throw new Error('routing calibration task identity is invalid');
    ids.add(task.id);
    const fields = Object.keys(task.expected);
    if (fields.length < 1 || fields.length > MAX_EXPECTED_FIELDS)
      throw new Error(`${task.id} expected answer is invalid`);
    for (const [key, value] of Object.entries(task.expected)) {
      if (!EXPECTED_KEY.test(key)) throw new Error(`${task.id} expected answer is invalid`);
      validateExpectedValue(value, 0, task.id);
    }
    const request = snapshotRequest(task.request);
    if ('model' in request) throw new Error(`${task.id} calibration request must omit model`);
    if (!Array.isArray(request['messages']) || request['messages'].length < 1)
      throw new Error(`${task.id} calibration messages are invalid`);
    if (
      !Number.isSafeInteger(request['max_tokens']) ||
      Number(request['max_tokens']) < 1 ||
      Number(request['max_tokens']) > 1_000_000
    )
      throw new Error(`${task.id} calibration max_tokens is invalid`);
    if (fixture.version === ROUTING_CALIBRATION_VERSION)
      benchmarkTaskRequest(task as RoutingCalibrationTask);
  }
}

function validateExpectedValue(value: unknown, depth: number, taskId: string): void {
  if (depth > MAX_EXPECTED_DEPTH) throw new Error(`${taskId} expected answer is too deeply nested`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_COMPLETION_BYTES)
      throw new Error(`${taskId} expected answer is invalid`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${taskId} expected answer is invalid`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_EXPECTED_FIELDS) throw new Error(`${taskId} expected answer is invalid`);
    for (const item of value) validateExpectedValue(item, depth + 1, taskId);
    return;
  }
  if (typeof value !== 'object' || value === null)
    throw new Error(`${taskId} expected answer is invalid`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_EXPECTED_FIELDS) throw new Error(`${taskId} expected answer is invalid`);
  for (const [key, item] of entries) {
    if (!EXPECTED_KEY.test(key)) throw new Error(`${taskId} expected answer is invalid`);
    validateExpectedValue(item, depth + 1, taskId);
  }
}

function snapshotRequest(
  request: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(request);
  } catch {
    throw new Error('routing benchmark request is not serializable');
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_COMPLETION_BYTES)
    throw new Error('routing benchmark request is invalid');
  const parsed = JSON.parse(encoded) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('routing benchmark request is invalid');
  return Object.freeze(parsed as Readonly<Record<string, unknown>>);
}

function snapshotFixture<T extends RoutingBenchmarkFixture | RoutingCalibrationFixture>(
  fixture: T,
): T {
  const encoded = JSON.stringify(fixture);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 1024 * 1024)
    throw new Error('routing benchmark fixture size is invalid');
  return deepFreeze(JSON.parse(encoded) as T);
}

function validLatency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000)
    throw new Error('routing benchmark latency is invalid');
  return value;
}

function average(values: readonly number[]): number {
  return Math.floor(values.reduce((total, value) => total + value, 0) / values.length);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
