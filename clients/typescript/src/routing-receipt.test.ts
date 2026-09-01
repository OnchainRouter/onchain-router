import { describe, expect, it } from 'vitest';
import {
  ROUTING_RECEIPT_EVIDENCE_VERSION,
  formatRoutingReceiptEvidence,
  type RoutingReceiptEvidence,
} from './index.js';

describe('routing receipt presentation', () => {
  it('renders verified payment and selection evidence without request or response content', () => {
    const evidence: RoutingReceiptEvidence = {
      version: ROUTING_RECEIPT_EVIDENCE_VERSION,
      associationStatus: 'verified',
      receiptId: 'receipt-1',
      model: 'gemini-3.6-flash',
      receiptModel: 'gemini-3.6-flash',
      modelMatches: true,
      quoteCatalogVersion: 'catalog-v1',
      receiptCatalogVersion: 'catalog-v1',
      catalogVersionsMatch: true,
      policyVersion: 'onchain-router-routing/v1',
      policyHash: 'a'.repeat(64),
      explanation:
        'Selected gemini-3.6-flash for code/auto; 2 bounded routes; catalog catalog-v1; fallback disabled.',
      payment: {
        network: 'eip155:8453',
        maximumAtomic: '5000',
        actualAtomic: '1234',
        transaction: '0xsettlement',
      },
    };
    const view = formatRoutingReceiptEvidence(evidence);
    expect(view).toContain('Association: verified');
    expect(view).toContain('Payment: 1234/5000 atomic USDC on eip155:8453');
    expect(view).toContain('fallback disabled');
    expect(view).not.toContain('secret prompt');
    expect(view).not.toContain('receipt-token');
  });

  it('labels catalog drift instead of claiming a verified association', () => {
    const evidence: RoutingReceiptEvidence = {
      version: ROUTING_RECEIPT_EVIDENCE_VERSION,
      associationStatus: 'catalog_mismatch',
      receiptId: 'receipt-2',
      model: 'gemini-3.6-flash',
      receiptModel: 'gemini-3.6-flash',
      modelMatches: true,
      quoteCatalogVersion: 'catalog-v1',
      receiptCatalogVersion: 'catalog-v2',
      catalogVersionsMatch: false,
      policyVersion: 'onchain-router-routing/v1',
      policyHash: 'b'.repeat(64),
      explanation:
        'Selected gemini-3.6-flash for general/eco; 1 bounded route; catalog catalog-v1; fallback disabled.',
      payment: {
        network: 'eip155:8453',
        maximumAtomic: '2000',
        actualAtomic: '1000',
        transaction: '0xsettlement2',
      },
    };
    expect(formatRoutingReceiptEvidence(evidence)).toContain('Association: catalog_mismatch');
  });
});
