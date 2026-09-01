import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  calibrationFixtureHash,
  type RoutingCalibrationFixture,
  type RoutingCalibrationReport,
} from '../src/index.js';

interface CalibrationEvidence {
  version: string;
  date: string;
  sourceCommit: string;
  reportSha256: string;
  execution: {
    authorizedProviderCalls: number;
    automaticRetries: number;
    providerCreditOnly: boolean;
    productionChanged: boolean;
    routingPriorsChanged: boolean;
    heldOutSuiteCreated: boolean;
  };
  financialStateBefore: Record<string, number>;
  financialStateAfter: Record<string, number>;
  facilitatorBefore: Record<string, number>;
  facilitatorAfter: Record<string, number>;
  report: RoutingCalibrationReport;
}

const evidence = JSON.parse(
  readFileSync(
    new URL('../benchmarks/results/provider-calibration.v3.json', import.meta.url),
    'utf8',
  ),
) as CalibrationEvidence;
const fixture = JSON.parse(
  readFileSync(new URL('../benchmarks/provider-calibration.v3.json', import.meta.url), 'utf8'),
) as RoutingCalibrationFixture;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('evidence is not JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

describe('consumed development-v3 evidence', () => {
  it('locks the content-free report to its original fixture, scorer, catalog, and run', () => {
    expect(evidence.version).toBe('onchain-router-routing-calibration-evidence/v1');
    expect(evidence.date).toBe('2026-08-31');
    expect(evidence.sourceCommit).toBe('fe221ef7d7f7e788c0339bf2a5af1aebe17bbda6');
    expect(evidence.reportSha256).toBe(
      '815f48dfbd684a902ee617b2a9973a78d4b1037cde538f6355f8778353e2838d',
    );
    expect(createHash('sha256').update(canonicalJson(evidence.report)).digest('hex')).toBe(
      evidence.reportSha256,
    );
    expect(evidence.report).toMatchObject({
      version: 'onchain-router-routing-calibration-report/v2',
      calibrationVersion: fixture.version,
      scorerVersion: 'onchain-router-json-field-score/v2',
      suiteHash: calibrationFixtureHash(fixture),
      catalogVersion: '2be9314ecba4b90b0ad617b0736ae439e75aa228614ab23170337bff9094ebd7',
      providerCalls: 8,
      taskCount: 4,
      modelCount: 2,
    });
    expect(evidence.report.tasks.map(({ taskId, model }) => `${taskId}:${model}`)).toEqual(
      fixture.tasks.flatMap((task) => fixture.models.map((model) => `${task.id}:${model}`)),
    );
    for (const task of evidence.report.tasks) {
      expect(Object.keys(task).sort()).toEqual(
        [
          'taskId',
          'model',
          'maximumAtomic',
          'qualityBasisPoints',
          'matchedFields',
          'expectedFields',
          'outputContractSatisfied',
          'latencyMs',
        ].sort(),
      );
      expect(task.outputContractSatisfied).toBe(true);
      expect(BigInt(task.maximumAtomic)).toBeGreaterThan(0n);
      expect(BigInt(task.maximumAtomic)).toBeLessThanOrEqual(500_000n);
      expect(task.qualityBasisPoints).toBe(
        Number((9_000n * BigInt(task.matchedFields)) / BigInt(task.expectedFields)) + 1_000,
      );
    }
  });

  it('retains equal measured quality without manufacturing a stronger-model prior', () => {
    for (const model of evidence.report.models) {
      const tasks = evidence.report.tasks.filter((task) => task.model === model.model);
      expect(model.aggregateQualityBasisPoints).toBe(8_425);
      expect(model.aggregateQualityBasisPoints).toBe(
        Number(tasks.reduce((sum, task) => sum + BigInt(task.qualityBasisPoints), 0n) / 4n),
      );
      expect(model.totalMaximumAtomic).toBe(
        tasks.reduce((sum, task) => sum + BigInt(task.maximumAtomic), 0n).toString(),
      );
      for (const [kind, expected] of [
        ['code', 7_750],
        ['reasoning', 9_100],
      ] as const) {
        const subset = tasks.filter((task) => task.taskId.startsWith(`calibration-${kind}-`));
        expect(subset).toHaveLength(2);
        expect(
          Number(subset.reduce((sum, task) => sum + BigInt(task.qualityBasisPoints), 0n) / 2n),
        ).toBe(expected);
      }
    }
    expect(evidence.report.models.map((model) => model.totalMaximumAtomic)).toEqual([
      '59724',
      '96899',
    ]);
    expect(
      fixture.models.map((model) =>
        evidence.report.tasks
          .filter((task) => task.model === model)
          .reduce((sum, task) => sum + task.latencyMs, 0),
      ),
    ).toEqual([4_921, 3_321]);
  });

  it('records zero payment-path effects and no unapproved follow-up execution', () => {
    expect(evidence.execution).toEqual({
      authorizedProviderCalls: 8,
      automaticRetries: 0,
      providerCreditOnly: true,
      productionChanged: false,
      routingPriorsChanged: false,
      heldOutSuiteCreated: false,
    });
    expect(evidence.financialStateBefore).toEqual(
      Object.fromEntries(
        [
          'operations',
          'payment_attempts',
          'settlement_intents',
          'receipts',
          'reconciliation_items',
          'ledger_transactions',
          'provider_attempts',
          'usage_records',
        ].map((table) => [table, 0]),
      ),
    );
    expect(evidence.financialStateAfter).toEqual(evidence.financialStateBefore);
    expect(evidence.facilitatorBefore).toEqual({
      verifyCalls: 0,
      settleCalls: 0,
      externalEffects: 0,
    });
    expect(evidence.facilitatorAfter).toEqual(evidence.facilitatorBefore);
  });
});
