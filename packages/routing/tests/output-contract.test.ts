import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ROUTING_BENCHMARK_SCORER_VERSION,
  ROUTING_BENCHMARK_VERSION,
  benchmarkTaskRequest,
  benchmarkFixtureHash,
  calibrationFixtureHash,
  createRoutingPolicy,
  DeterministicSmartRouter,
  runRoutingBenchmark,
  runRoutingCalibration,
  type ArchivedRoutingBenchmarkFixture,
  type RouteModel,
  type RoutingBenchmarkFixture,
  type RoutingCalibrationFixture,
} from '../src/index.js';
import { scoreBenchmarkAnswer } from '../src/output-contract.js';

const fixture = JSON.parse(
  readFileSync(new URL('../benchmarks/provider-calibration.v3.json', import.meta.url), 'utf8'),
) as RoutingCalibrationFixture;
const models: RouteModel[] = fixture.models.map((id) => ({
  id,
  enabled: true,
  category: 'text_generation',
  capabilities: ['text', 'json'],
  maximumOutputTokens: 65_536,
  qualityBasisPoints: { code: 5_000, reasoning: 5_000 },
}));
const NOW = 1_800_000_000_000;
const task = fixture.tasks[1]!;
const response = (answer: unknown) => ({
  body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] },
  latencyMs: 1,
});
const quoteFor = (model: string) => ({
  model,
  maximumAtomic: 100n,
  catalogVersion: 'catalog-v3',
  expiresAt: NOW + 60_000,
});

describe('versioned output contract', () => {
  it('provides exact keys/types without deriving or leaking expected values', () => {
    for (const item of fixture.tasks) {
      const request = benchmarkTaskRequest(item);
      const messages = request['messages'] as { role: string; content: string }[];
      const schema = JSON.parse(messages[0]!.content.split('Output schema: ')[1]!) as unknown;
      expect(schema).toEqual(item.outputSchema);
      expect(request['response_format']).toEqual({ type: 'json_object' });
      expect(JSON.stringify(request)).not.toContain(JSON.stringify(item.expected));
      expect(Object.keys(item.outputSchema.properties).sort()).toEqual(
        Object.keys(item.expected).sort(),
      );
      expect(Object.isFrozen(messages)).toBe(true);
      expect(Object.isFrozen(messages[0])).toBe(true);
    }
    const changedAnswer = {
      ...task,
      expected: { order: ['different-answer-canary'], j_slot: 99, m_slot: 98, n_slot: 97 },
    };
    expect(benchmarkTaskRequest(changedAnswer)).toEqual(benchmarkTaskRequest(task));
  });

  it.each([
    [{ order: ['N', 'J', 'K', 'M', 'L'], j_slot: 2, m_slot: 4, n_slot: 1 }, 10_000, 4, true],
    [{ order: ['N', 'J', 'K', 'M', 'L'], J: 2, M: 4, N: 1 }, 2_250, 1, false],
    [{ order: ['N', 'J', 'K', 'M', 'L'], j_slot: 2, m_slot: 4 }, 6_750, 3, false],
    [{ ...task.expected, extra: 'do not record this' }, 9_000, 4, false],
    [{ ...task.expected, j_slot: '2' }, 6_750, 3, false],
    [{ ...task.expected, order: ['J', 'N', 'K', 'M', 'L'] }, 7_750, 3, true],
  ])(
    'scores exact names and types independently from answer correctness',
    (answer, quality, matched, satisfies) => {
      expect(scoreBenchmarkAnswer(answer, task.expected, task.outputSchema)).toEqual({
        qualityBasisPoints: quality,
        matchedFields: matched,
        expectedFields: 4,
        outputContractSatisfied: satisfies,
      });
    },
  );

  it('does not treat inherited keys or nested wrong types as schema matches', () => {
    const inherited = Object.create(task.expected) as Record<string, unknown>;
    expect(
      scoreBenchmarkAnswer(inherited, task.expected, task.outputSchema).qualityBasisPoints,
    ).toBe(0);
    const schema = {
      type: 'object' as const,
      properties: {
        payload: {
          type: 'object' as const,
          properties: { values: { type: 'array' as const, items: { type: 'integer' as const } } },
          required: ['values'],
          additionalProperties: false as const,
        },
      },
      required: ['payload'],
      additionalProperties: false as const,
    };
    expect(
      scoreBenchmarkAnswer({ payload: { values: ['1'] } }, { payload: { values: [1] } }, schema),
    ).toMatchObject({
      qualityBasisPoints: 0,
      outputContractSatisfied: false,
    });
  });

  it.each([
    (value: Record<string, unknown>) => {
      delete value['outputSchema'];
    },
    (value: Record<string, unknown>) => {
      value['expected'] = { wrong: 1 };
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as Record<string, unknown>)['additionalProperties'] = true;
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as Record<string, unknown>)['required'] = ['order'];
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as Record<string, unknown>)['examples'] = [task.expected];
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as { properties: Record<string, unknown> }).properties['j_slot'] = {
        type: 'integer',
        const: 2,
      };
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as { properties: Record<string, unknown> }).properties['j_slot'] = {
        type: 'number',
      };
    },
    (value: Record<string, unknown>) => {
      (value['request'] as Record<string, unknown>)['response_format'] = { type: 'text' };
    },
    (value: Record<string, unknown>) => {
      (value['request'] as Record<string, unknown>)['temperature'] = 0;
    },
    (value: Record<string, unknown>) => {
      (value['request'] as Record<string, unknown>)['messages'] = [
        { role: 'user', content: [{ type: 'image_url', image_url: 'private-canary' }] },
      ];
    },
    (value: Record<string, unknown>) => {
      (value['outputSchema'] as Record<string, unknown>)['required'] = [
        'order',
        'j_slot',
        'm_slot',
        'm_slot',
      ];
    },
    (value: Record<string, unknown>) => {
      (value['expected'] as Record<string, unknown>)['j_slot'] = 2.5;
    },
    (value: Record<string, unknown>) => {
      (value['request'] as Record<string, unknown>)['messages'] = [
        { role: 'user', content: 'x'.repeat(64 * 1024) },
      ];
    },
    (value: Record<string, unknown>) => {
      let nested: unknown = { type: 'integer' };
      for (let index = 0; index < 9; index += 1) nested = { type: 'array', items: nested };
      (value['outputSchema'] as { properties: Record<string, unknown> }).properties['j_slot'] =
        nested;
    },
  ])(
    'rejects malformed contracts before any quotation or completion, even on the last task',
    async (mutate) => {
      const invalid = {
        ...fixture,
        tasks: [
          ...fixture.tasks.slice(0, -1),
          { ...structuredClone(task), id: 'last-contract-regression' },
        ],
      };
      mutate(invalid.tasks.at(-1)! as unknown as Record<string, unknown>);
      const quote = vi.fn();
      const complete = vi.fn();
      await expect(
        runRoutingCalibration({
          fixture: invalid,
          models,
          quotes: { quote },
          provider: { complete },
          localMaximumAtomic: 500_000n,
        }),
      ).rejects.toThrow();
      expect(quote).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it('quotes and completes the identical schema-bearing matrix without recording answers', async () => {
    const quote = vi.fn(
      async ({ model }: { model: string; request: Readonly<Record<string, unknown>> }) =>
        quoteFor(model),
    );
    const complete = vi.fn(
      async ({ taskId }: { taskId: string; request: Readonly<Record<string, unknown>> }) => {
        expect(quote).toHaveBeenCalledTimes(8);
        return response(fixture.tasks.find((item) => item.id === taskId)!.expected);
      },
    );
    const report = await runRoutingCalibration({
      fixture,
      models,
      quotes: { quote },
      provider: { complete },
      localMaximumAtomic: 500_000n,
      now: () => NOW,
    });
    expect(complete).toHaveBeenCalledTimes(8);
    for (const [index, call] of complete.mock.calls.entries())
      expect(call[0].request).toEqual(quote.mock.calls[index]![0].request);
    expect(report.scorerVersion).toBe(ROUTING_BENCHMARK_SCORER_VERSION);
    expect(report.models.every((model) => model.aggregateQualityBasisPoints === 10_000)).toBe(true);
    expect(
      report.tasks.every(
        (result) =>
          result.outputContractSatisfied && result.matchedFields === result.expectedFields,
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('outputSchema');
    for (const item of fixture.tasks) {
      expect(JSON.stringify(report)).not.toContain(JSON.stringify(item.expected));
      expect(JSON.stringify(report)).not.toContain('Output schema:');
    }
  });

  it('uses one output contract for selected and baseline models, retaining existing thresholds', async () => {
    const benchmark: RoutingBenchmarkFixture = {
      version: ROUTING_BENCHMARK_VERSION,
      name: 'offline-contract-only',
      baselineModel: models[0]!.id,
      minimumAggregateQualityGainBasisPoints: 250,
      tasks: fixture.tasks.map((item) => ({
        ...item,
        profile: 'premium',
        minimumQualityBasisPoints: 7_500,
        maximumCostRatioBasisPoints: 40_000,
      })),
    };
    const policy = createRoutingPolicy({
      allowedModels: fixture.models,
      maximumCandidates: 2,
      maximumHealthAgeMs: 60_000,
      unknownHealthBasisPoints: 5_000,
    });
    const quote = vi.fn(
      async ({ model }: { model: string; request: Readonly<Record<string, unknown>> }) =>
        quoteFor(model),
    );
    const complete = vi.fn(
      async ({ taskId }: { taskId: string; request: Readonly<Record<string, unknown>> }) =>
        response(fixture.tasks.find((item) => item.id === taskId)!.expected),
    );
    const report = await runRoutingBenchmark({
      fixture: benchmark,
      router: new DeterministicSmartRouter(policy, { quote }),
      policy,
      models: models.map((model, index) => ({
        ...model,
        qualityBasisPoints: { code: index * 9_000, reasoning: index * 9_000 },
      })),
      localMaximumAtomic: 500_000n,
      provider: { complete },
      now: () => NOW,
    });
    expect(complete).toHaveBeenCalledTimes(8);
    for (const [index, item] of fixture.tasks.entries()) {
      const selected = complete.mock.calls[index * 2]![0].request;
      const baseline = complete.mock.calls[index * 2 + 1]![0].request;
      expect(selected['messages']).toEqual(benchmarkTaskRequest(item)['messages']);
      expect(selected['messages']).toEqual(baseline['messages']);
      expect(
        quote.mock.calls.some(
          ([call]) => JSON.stringify(call.request) === JSON.stringify(selected),
        ),
      ).toBe(true);
    }
    expect(report.scorerVersion).toBe(ROUTING_BENCHMARK_SCORER_VERSION);
    expect(report.minimumAggregateQualityGainBasisPoints).toBe(250);
    expect(report.passed).toBe(false); // Both models answer correctly: no manufactured gain.
    expect(
      report.tasks.every(
        (result) =>
          result.selectedOutputContractSatisfied && result.baselineOutputContractSatisfied,
      ),
    ).toBe(true);
  });

  it('snapshots fixture content so a caller cannot change answers or hashes during a run', async () => {
    const mutable = structuredClone(fixture);
    const originalHash = calibrationFixtureHash(mutable);
    const report = await runRoutingCalibration({
      fixture: mutable,
      models,
      quotes: {
        quote: async ({ model }) => {
          (mutable.tasks[0]!.expected as Record<string, unknown>)['comparison'] =
            'changed-during-await';
          return quoteFor(model);
        },
      },
      provider: {
        complete: async ({ taskId }) =>
          response(fixture.tasks.find((item) => item.id === taskId)!.expected),
      },
      localMaximumAtomic: 500_000n,
      now: () => NOW,
    });
    expect(report.suiteHash).toBe(originalHash);
    expect(report.models.every((model) => model.aggregateQualityBasisPoints === 10_000)).toBe(true);
  });

  it('refuses executable archived calibration and qualification fixtures before side effects', async () => {
    const quote = vi.fn();
    const complete = vi.fn();
    const calibration = JSON.parse(
      readFileSync(new URL('../benchmarks/provider-calibration.v2.json', import.meta.url), 'utf8'),
    ) as RoutingCalibrationFixture;
    const benchmark = JSON.parse(
      readFileSync(new URL('../benchmarks/provider-held-out.v2.json', import.meta.url), 'utf8'),
    ) as RoutingBenchmarkFixture;
    const policy = createRoutingPolicy({
      allowedModels: fixture.models,
      maximumCandidates: 2,
      maximumHealthAgeMs: 60_000,
      unknownHealthBasisPoints: 5_000,
    });
    await expect(
      runRoutingCalibration({
        fixture: calibration,
        models,
        quotes: { quote },
        provider: { complete },
        localMaximumAtomic: 500_000n,
      }),
    ).rejects.toThrow('version is unsupported');
    await expect(
      runRoutingBenchmark({
        fixture: benchmark,
        models,
        router: new DeterministicSmartRouter(policy, { quote }),
        policy,
        provider: { complete },
        localMaximumAtomic: 500_000n,
      }),
    ).rejects.toThrow('version is unsupported');
    expect(quote).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['```json\n{}\n```', '{}\n{}', 'Here is the answer: {}'])(
    'rejects non-contract JSON presentation once without retry',
    async (content) => {
      const complete = vi.fn(async () => ({
        body: { choices: [{ message: { content } }] },
        latencyMs: 1,
      }));
      await expect(
        runRoutingCalibration({
          fixture,
          models,
          quotes: { quote: async ({ model }) => quoteFor(model) },
          provider: { complete },
          localMaximumAtomic: 500_000n,
          now: () => NOW,
        }),
      ).rejects.toThrow('not one JSON object');
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );
});

function permutations(values: string[]): string[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]),
      );
}

describe('independent offline answer checks', () => {
  it('preserves the original held-out v1 fixture hash', () => {
    const archived = JSON.parse(
      readFileSync(new URL('../benchmarks/provider-held-out.v1.json', import.meta.url), 'utf8'),
    ) as ArchivedRoutingBenchmarkFixture & { modelPriors: unknown };
    const { modelPriors, ...suite } = archived;
    expect(Array.isArray(modelPriors)).toBe(true);
    expect(benchmarkFixtureHash(suite)).toBe(
      '44b517e4eadfe28cea2516fb87c1f622a6d58620d73d28484679db01c6be720f',
    );
  });

  it('proves the archived workshop solution is unique without rewriting or rescoring the run', () => {
    const archived = JSON.parse(
      readFileSync(new URL('../benchmarks/provider-held-out.v2.json', import.meta.url), 'utf8'),
    ) as ArchivedRoutingBenchmarkFixture;
    const workshop = archived.tasks.find((item) => item.id === 'heldout-reasoning-workshops-02')!;
    const candidates = permutations(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(candidates).toHaveLength(720);
    const solutions = candidates.filter((order) => {
      const slot = (id: string) => order.indexOf(id);
      return (
        slot('C') === slot('A') + 1 &&
        slot('F') === slot('C') + 1 &&
        slot('B') < slot('A') &&
        slot('D') === slot('E') - 1 &&
        slot('E') > slot('F')
      );
    });
    expect(solutions).toHaveLength(1);
    const order = solutions[0]!;
    expect(workshop.expected).toEqual({
      order,
      a_slot: order.indexOf('A') + 1,
      d_slot: order.indexOf('D') + 1,
      f_slot: order.indexOf('F') + 1,
    });
    // The missing key instruction is real, but provider output was not retained: no retrospective pass.
    expect(JSON.stringify(workshop.request)).not.toContain('a_slot');
  });

  it('derives every development answer from independent algorithms, not model output', () => {
    for (const item of fixture.tasks) {
      const content = (item.request['messages'] as { content: string }[])[0]!.content;
      let answer: unknown;
      if (item.id === 'calibration-code-lower-bound-03') {
        const input = JSON.parse(content.split('Input: ')[1]!) as {
          values: number[];
          targets: number[];
        };
        answer = {
          comparison: '<',
          indices: input.targets.map((target) => {
            const index = input.values.findIndex((value) => value >= target);
            return index === -1 ? input.values.length : index;
          }),
        };
      } else if (item.id === 'calibration-code-window-state-03') {
        const input = JSON.parse(content.split('Input: ')[1]!) as { values: number[]; k: number };
        const sums = input.values
          .slice(0, input.values.length - input.k + 1)
          .map((_, start) =>
            input.values.slice(start, start + input.k).reduce((total, value) => total + value, 0),
          );
        const best = Math.max(...sums);
        answer = {
          offset: 0,
          window_sums: sums,
          best_sum: best,
          earliest_start: sums.indexOf(best),
        };
      } else if (item.id === 'calibration-reasoning-ledger-03') {
        const input = JSON.parse(content.split('Input: ')[1]!) as {
          starting_balance: number;
          events: number[];
          threshold: number;
          fee: number;
        };
        let balance = BigInt(input.starting_balance);
        let fees = 0n;
        for (const event of input.events) {
          balance += BigInt(event);
          if (event < 0 && balance < BigInt(input.threshold)) {
            balance -= BigInt(input.fee);
            fees += 1n;
          }
        }
        answer = {
          final_balance: Number(balance),
          debit_total: input.events
            .filter((event) => event < 0)
            .reduce((sum, event) => sum - event, 0),
          credit_total: input.events
            .filter((event) => event > 0)
            .reduce((sum, event) => sum + event, 0),
          fee_count: Number(fees),
          fee_total: Number(fees * BigInt(input.fee)),
        };
      } else if (item.id === 'calibration-reasoning-deliveries-03') {
        const solutions = permutations(['J', 'K', 'L', 'M', 'N']).filter((order) => {
          const slot = (id: string) => order.indexOf(id);
          return (
            slot('K') === slot('J') + 1 &&
            slot('M') > slot('K') &&
            slot('N') < slot('J') &&
            slot('M') === slot('L') - 1
          );
        });
        expect(solutions).toHaveLength(1);
        const order = solutions[0]!;
        answer = {
          order,
          j_slot: order.indexOf('J') + 1,
          m_slot: order.indexOf('M') + 1,
          n_slot: order.indexOf('N') + 1,
        };
      } else throw new Error('Every development task needs an independent oracle');
      expect(item.expected).toEqual(answer);
    }
  });
});
