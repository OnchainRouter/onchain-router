import { describe, expect, it, vi } from 'vitest';
import {
  DeterministicSmartRouter,
  ROUTING_BENCHMARK_VERSION,
  ROUTING_CALIBRATION_VERSION,
  createRoutingPolicy,
  routingModelPriorsHash,
  runRoutingCalibration,
  runRoutingBenchmark,
  type RouteModel,
  type RoutingBenchmarkFixture,
  type RoutingCalibrationFixture,
} from '../src/index.js';

const NOW = 1_800_000_000_000;
const models: readonly RouteModel[] = [
  {
    id: 'baseline',
    enabled: true,
    category: 'text_generation',
    capabilities: ['text', 'json'],
    maximumOutputTokens: 2_048,
    qualityBasisPoints: { general: 6_000, reasoning: 5_000 },
  },
  {
    id: 'strong',
    enabled: true,
    category: 'text_generation',
    capabilities: ['text', 'json'],
    maximumOutputTokens: 2_048,
    qualityBasisPoints: { general: 8_000, reasoning: 9_500 },
  },
];
const policy = createRoutingPolicy({
  allowedModels: models.map((model) => model.id),
  maximumCandidates: 2,
  maximumHealthAgeMs: 60_000,
  unknownHealthBasisPoints: 5_000,
});
const fixture: RoutingBenchmarkFixture = {
  version: ROUTING_BENCHMARK_VERSION,
  name: 'private-held-out-v1',
  baselineModel: 'baseline',
  minimumAggregateQualityGainBasisPoints: 1_000,
  tasks: [
    {
      id: 'reasoning-1',
      profile: 'premium',
      request: {
        messages: [{ role: 'user', content: 'Derive the result and return JSON.' }],
        max_tokens: 100,
        response_format: { type: 'json_object' },
      },
      expected: { answer: 42, valid: true },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'integer' }, valid: { type: 'boolean' } },
        required: ['answer', 'valid'],
        additionalProperties: false,
      },
      minimumQualityBasisPoints: 9_000,
      maximumCostRatioBasisPoints: 40_000,
    },
    {
      id: 'general-1',
      profile: 'auto',
      request: {
        messages: [{ role: 'user', content: 'Return the requested JSON fields.' }],
        max_tokens: 100,
        response_format: { type: 'json_object' },
      },
      expected: { answer: 'blue', count: 3 },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' }, count: { type: 'integer' } },
        required: ['answer', 'count'],
        additionalProperties: false,
      },
      minimumQualityBasisPoints: 9_000,
      maximumCostRatioBasisPoints: 40_000,
    },
  ],
};

const calibrationFixture: RoutingCalibrationFixture = {
  version: ROUTING_CALIBRATION_VERSION,
  name: 'private-calibration-v1',
  models: ['baseline', 'strong'],
  tasks: [
    {
      id: 'calibration-code-1',
      request: {
        messages: [{ role: 'user', content: 'Debug this and return JSON.' }],
        max_tokens: 100,
        response_format: { type: 'json_object' },
      },
      expected: { answer: 'fixed' },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    {
      id: 'calibration-reasoning-1',
      request: {
        messages: [{ role: 'user', content: 'Reason and return JSON.' }],
        max_tokens: 100,
        response_format: { type: 'json_object' },
      },
      expected: { answer: 42 },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'integer' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
  ],
};

function response(content: unknown) {
  return { body: { choices: [{ message: { content: JSON.stringify(content) } }] }, latencyMs: 12 };
}

describe('provider-backed routing benchmark contract', () => {
  it('does not award a shape bonus for equally many incorrectly named keys', async () => {
    const report = await runRoutingCalibration({
      fixture: {
        ...calibrationFixture,
        tasks: calibrationFixture.tasks.map((task) => ({
          ...task,
          outputSchema: {
            type: 'object' as const,
            properties: { answer: { type: 'integer' as const } },
            required: ['answer'],
            additionalProperties: false as const,
          },
          expected: { answer: 42 },
        })),
      },
      models,
      quotes: {
        quote: async ({ model }) => ({
          model,
          maximumAtomic: 100n,
          catalogVersion: 'catalog-v1',
          expiresAt: NOW + 60_000,
        }),
      },
      localMaximumAtomic: 500n,
      provider: { complete: async () => response({ result: 42 }) },
      now: () => NOW,
    });
    expect(report.tasks.map((task) => task.qualityBasisPoints)).toEqual([0, 0, 0, 0]);
  });

  it('calibrates a declared model matrix once and emits no completion content', async () => {
    const quote = vi.fn(async ({ model }: { model: string }) => ({
      model,
      maximumAtomic: model === 'baseline' ? 100n : 250n,
      catalogVersion: 'catalog-v1',
      expiresAt: NOW + 60_000,
    }));
    const complete = vi.fn(async ({ taskId, model }: { taskId: string; model: string }) =>
      response({
        answer:
          taskId === 'calibration-code-1'
            ? model === 'strong'
              ? 'fixed'
              : 'broken'
            : model === 'strong'
              ? 42
              : 41,
      }),
    );
    const report = await runRoutingCalibration({
      fixture: calibrationFixture,
      models,
      quotes: { quote },
      localMaximumAtomic: 500n,
      provider: { complete },
      now: () => NOW,
    });

    expect(quote).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(report).toMatchObject({
      providerCalls: 4,
      taskCount: 2,
      modelCount: 2,
      catalogVersion: 'catalog-v1',
    });
    expect(report.models.find((model) => model.model === 'strong')).toMatchObject({
      aggregateQualityBasisPoints: 10_000,
      totalMaximumAtomic: '500',
    });
    expect(JSON.stringify(report)).not.toContain('fixed');
    expect(JSON.stringify(report)).not.toContain('Debug this');
  });

  it('binds benchmark evidence to the exact local model priors', () => {
    const original = routingModelPriorsHash(models);
    const changed = routingModelPriorsHash(
      models.map((model) =>
        model.id === 'strong'
          ? { ...model, qualityBasisPoints: { ...model.qualityBasisPoints, reasoning: 9_999 } }
          : model,
      ),
    );

    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(original);
  });

  it('stops calibration on the first ambiguous provider result without retrying', async () => {
    const complete = vi.fn(async () => ({ body: { choices: [] }, latencyMs: 12 }));

    await expect(
      runRoutingCalibration({
        fixture: calibrationFixture,
        models,
        quotes: {
          quote: async ({ model }) => ({
            model,
            maximumAtomic: 100n,
            catalogVersion: 'catalog-v1',
            expiresAt: NOW + 60_000,
          }),
        },
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('benchmark response must contain exactly one choice');

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects calibration output beyond a candidate limit before quotes or provider calls', async () => {
    const quote = vi.fn();
    const complete = vi.fn();

    await expect(
      runRoutingCalibration({
        fixture: calibrationFixture,
        models: models.map((model) =>
          model.id === 'strong' ? { ...model, maximumOutputTokens: 50 } : model,
        ),
        quotes: { quote },
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('routing calibration request exceeds the model output limit');

    expect(quote).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('compares one selected route with a fixed baseline without retaining content', async () => {
    const complete = vi.fn(async ({ taskId, model }: { taskId: string; model: string }) => {
      if (model === 'strong')
        return response(
          taskId === 'reasoning-1' ? { answer: 42, valid: true } : { answer: 'blue', count: 3 },
        );
      return response(
        taskId === 'reasoning-1' ? { answer: 41, valid: false } : { answer: 'red', count: 3 },
      );
    });
    const router = new DeterministicSmartRouter(policy, {
      quote: async ({ model }) => ({
        model,
        maximumAtomic: model === 'baseline' ? 100n : 300n,
        catalogVersion: 'catalog-v1',
        expiresAt: NOW + 60_000,
      }),
    });
    const report = await runRoutingBenchmark({
      fixture,
      router,
      policy,
      models,
      localMaximumAtomic: 500n,
      provider: { complete },
      now: () => NOW,
    });

    expect(report).toMatchObject({
      passed: true,
      providerCalls: 4,
      aggregateSelectedQualityBasisPoints: 10_000,
      baselineModel: 'baseline',
      catalogVersion: 'catalog-v1',
      modelPriorsHash: routingModelPriorsHash(models),
    });
    expect(report.aggregateQualityGainBasisPoints).toBeGreaterThanOrEqual(1_000);
    expect(JSON.stringify(report)).not.toContain('blue');
    expect(JSON.stringify(report)).not.toContain('Derive the result');
  });

  it('reuses one provider result when routing selects the baseline and reports a failed gain', async () => {
    const complete = vi.fn(async () => response({ answer: 42, valid: true }));
    const ecoFixture: RoutingBenchmarkFixture = {
      ...fixture,
      minimumAggregateQualityGainBasisPoints: 1,
      tasks: fixture.tasks.map((task) => ({ ...task, profile: 'eco' as const })),
    };
    const router = new DeterministicSmartRouter(policy, {
      quote: async ({ model }) => ({
        model,
        maximumAtomic: model === 'baseline' ? 100n : 1_000n,
        catalogVersion: 'catalog-v1',
        expiresAt: NOW + 60_000,
      }),
    });
    const report = await runRoutingBenchmark({
      fixture: ecoFixture,
      router,
      policy,
      models,
      localMaximumAtomic: 2_000n,
      provider: { complete },
      now: () => NOW,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(report.providerCalls).toBe(2);
    expect(report.aggregateQualityGainBasisPoints).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('makes one non-retried provider attempt and rejects malformed output', async () => {
    const complete = vi.fn(async () => ({
      body: { choices: [{ message: { content: 'not-json' } }] },
      latencyMs: 1,
    }));
    const router = new DeterministicSmartRouter(policy, {
      quote: async ({ model }) => ({
        model,
        maximumAtomic: model === 'baseline' ? 100n : 300n,
        catalogVersion: 'catalog-v1',
        expiresAt: NOW + 60_000,
      }),
    });
    await expect(
      runRoutingBenchmark({
        fixture,
        router,
        policy,
        models,
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('not one JSON object');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('makes one non-retried provider attempt and identifies output-budget truncation', async () => {
    const complete = vi.fn(async () => ({
      body: {
        choices: [{ finish_reason: 'length', message: { content: '{"answer":' } }],
      },
      latencyMs: 1,
    }));
    const router = new DeterministicSmartRouter(policy, {
      quote: async ({ model }) => ({
        model,
        maximumAtomic: model === 'baseline' ? 100n : 300n,
        catalogVersion: 'catalog-v1',
        expiresAt: NOW + 60_000,
      }),
    });
    await expect(
      runRoutingBenchmark({
        fixture,
        router,
        policy,
        models,
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('response was truncated');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects fixture attempts to preselect a model before quotes or provider work', async () => {
    const complete = vi.fn();
    const router = new DeterministicSmartRouter(policy, {
      quote: vi.fn(async () => {
        throw new Error('quote must not run');
      }),
    });
    const invalid: RoutingBenchmarkFixture = {
      ...fixture,
      tasks: fixture.tasks.map((task, index) =>
        index === 0 ? { ...task, request: { ...task.request, model: 'strong' } } : task,
      ),
    };
    await expect(
      runRoutingBenchmark({
        fixture: invalid,
        router,
        policy,
        models,
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('must omit model');
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an unbounded candidate set before quotes or provider work', async () => {
    const complete = vi.fn();
    const quote = vi.fn();
    const oversizedModels = Array.from(
      { length: 17 },
      (_, index): RouteModel => ({
        ...models[0]!,
        id: `candidate-${index}`,
      }),
    );
    await expect(
      runRoutingBenchmark({
        fixture,
        router: new DeterministicSmartRouter(
          createRoutingPolicy({
            allowedModels: oversizedModels.map((model) => model.id),
            maximumCandidates: 16,
            maximumHealthAgeMs: 60_000,
            unknownHealthBasisPoints: 5_000,
          }),
          { quote },
        ),
        policy: createRoutingPolicy({
          allowedModels: oversizedModels.map((model) => model.id),
          maximumCandidates: 16,
          maximumHealthAgeMs: 60_000,
          unknownHealthBasisPoints: 5_000,
        }),
        models: oversizedModels,
        localMaximumAtomic: 500n,
        provider: { complete },
        now: () => NOW,
      }),
    ).rejects.toThrow('candidate count is invalid');
    expect(quote).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
