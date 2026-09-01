import { describe, expect, it } from 'vitest';
import { DeterministicSmartRouter, createRoutingPolicy, type RouteModel } from '../src/index.js';

const fixtures = [
  { prompt: 'Summarize this short paragraph', profile: 'eco' as const, expected: 'economy' },
  { prompt: 'Write a TypeScript parser with tests', profile: 'auto' as const, expected: 'quality' },
  {
    prompt: 'Derive and compare three architectures',
    profile: 'premium' as const,
    expected: 'quality',
  },
] as const;

const models: readonly RouteModel[] = [
  {
    id: 'economy',
    enabled: true,
    category: 'text_generation',
    capabilities: ['text'],
    maximumOutputTokens: 8_192,
    qualityBasisPoints: { general: 6_500, code: 6_000, reasoning: 6_000 },
  },
  {
    id: 'quality',
    enabled: true,
    category: 'text_generation',
    capabilities: ['text'],
    maximumOutputTokens: 8_192,
    qualityBasisPoints: { general: 8_000, code: 9_500, reasoning: 9_500 },
  },
];

describe('held-out routing acceptance fixture', () => {
  it.each(fixtures)('selects the expected bounded route for $profile', async (fixture) => {
    const now = 1_800_000_000_000;
    const router = new DeterministicSmartRouter(
      createRoutingPolicy({
        allowedModels: models.map((model) => model.id),
        maximumCandidates: 4,
        maximumHealthAgeMs: 60_000,
        unknownHealthBasisPoints: 5_000,
      }),
      {
        quote: async ({ model }) => ({
          model,
          maximumAtomic: model === 'economy' ? 100n : 500n,
          catalogVersion: 'fixture-catalog',
          expiresAt: now + 60_000,
        }),
      },
    );
    const decision = await router.route({
      endpoint: '/v1/chat/completions',
      kind: 'openai',
      profile: fixture.profile,
      body: { messages: [{ role: 'user', content: fixture.prompt }], max_tokens: 512 },
      models,
      localMaximumAtomic: 1_000n,
      now,
    });
    expect(decision.selectedModel).toBe(fixture.expected);
  });
});
