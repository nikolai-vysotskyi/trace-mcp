import { describe, expect, it } from 'vitest';
import {
  FAILURE_SIGNAL,
  LIKELY_SECRET,
  LocalExtractiveReducer,
  MAX_EVIDENCE_ITEMS,
  MAX_QUOTE_CHARS,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  type EvidenceKind,
  type EvidenceReducer,
  type ReducerInput,
  reduceLongOutput,
  sha256,
  validateReceipt,
} from '../../src/tools/quality/evidence-reducer.js';
import { getDiagnostics, renderDiagnosticsBody } from '../../src/tools/quality/diagnostics.js';

function makeReceipt(
  body: string,
  opts: {
    status?: 'success' | 'failure';
    uncertain?: boolean;
    evidence?: Array<{ kind: EvidenceKind; quote: string }>;
    schema?: string;
    sourceSha256?: string;
  } = {},
): string {
  return JSON.stringify({
    schema: opts.schema ?? REDUCER_RECEIPT_SCHEMA,
    source_sha256: opts.sourceSha256 ?? sha256(body),
    status: opts.status ?? 'failure',
    uncertain: opts.uncertain ?? false,
    evidence: opts.evidence ?? [],
  });
}

function mockReducer(raw: string, name = 'mock'): EvidenceReducer {
  return {
    name,
    reduce: async (_input: ReducerInput) => raw,
  };
}

describe('validateReceipt (SoL-Pi receipt.ts 1:1 port)', () => {
  const body = [
    "src/user.ts:14:7 error TS2322: Type 'string' is not assignable to type 'number'",
    'src/config.ts:5:1 warning TS6133: unused variable',
    'Build failed with 1 error',
  ].join('\n');

  it('accepts a valid failure receipt with verified quotes, lines, and hashes', () => {
    const quote = "Type 'string' is not assignable to type 'number'";
    const raw = makeReceipt(body, {
      evidence: [{ kind: 'failure', quote }],
    });
    const result = validateReceipt(raw, { hash: sha256(body) }, body, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('failure');
    expect(result.value.uncertain).toBe(false);
    expect(result.value.evidence).toHaveLength(1);
    expect(result.value.evidence[0]).toMatchObject({
      kind: 'failure',
      line: 1,
      quote,
      quoteSha256: sha256(quote),
    });
  });

  it('accepts a valid success receipt for a clean log', () => {
    const cleanBody = 'Build succeeded in 1.2s\nAll targets up to date';
    const quote = 'Build succeeded in 1.2s';
    const raw = makeReceipt(cleanBody, {
      status: 'success',
      evidence: [{ kind: 'summary', quote }],
    });
    const result = validateReceipt(raw, { hash: sha256(cleanBody) }, cleanBody, false);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed JSON as invalid-json', () => {
    expect(validateReceipt('not json{', { hash: 'x' }, body, true)).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });

  it.each([
    [
      'wrong schema',
      makeReceipt(body, {
        schema: 'other/1',
        evidence: [{ kind: 'failure', quote: 'Build failed with 1 error' }],
      }),
    ],
    [
      'wrong source hash',
      makeReceipt(body, {
        sourceSha256: '0'.repeat(64),
        evidence: [{ kind: 'failure', quote: 'Build failed with 1 error' }],
      }),
    ],
    [
      'wrong status',
      makeReceipt(body, {
        status: 'success',
        evidence: [{ kind: 'failure', quote: 'Build failed with 1 error' }],
      }),
    ],
    [
      'non-boolean uncertain',
      JSON.stringify({
        schema: REDUCER_RECEIPT_SCHEMA,
        source_sha256: sha256(body),
        status: 'failure',
        uncertain: 'no',
        evidence: [{ kind: 'failure', quote: 'Build failed with 1 error' }],
      }),
    ],
    [
      'too many evidence items',
      JSON.stringify({
        schema: REDUCER_RECEIPT_SCHEMA,
        source_sha256: sha256(body),
        status: 'failure',
        uncertain: false,
        // Length is checked on the raw array, before dedup.
        evidence: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => ({
          kind: 'failure',
          quote: 'Build failed with 1 error',
        })),
      }),
    ],
  ])('rejects %s as schema-mismatch', (_label, raw) => {
    expect(validateReceipt(raw, { hash: sha256(body) }, body, true)).toEqual({
      ok: false,
      reason: 'schema-mismatch',
    });
  });

  it.each([
    ['quote absent from body', 'something never logged anywhere'],
    ['empty quote', ''],
    ['over-long quote', 'x'.repeat(MAX_QUOTE_CHARS + 1)],
    ['unknown kind', "Type 'string' is not assignable to type 'number'"],
  ])('rejects %s as unverifiable-quote', (_label, quote) => {
    const longBody = `${body}\n${'x'.repeat(700)}`;
    const raw = makeReceipt(longBody, {
      evidence: [
        _label === 'unknown kind'
          ? { kind: 'bogus' as unknown as EvidenceKind, quote }
          : { kind: 'failure', quote },
      ],
    });
    expect(validateReceipt(raw, { hash: sha256(longBody) }, longBody, true)).toEqual({
      ok: false,
      reason: 'unverifiable-quote',
    });
  });

  it('accepts a quote of exactly MAX_QUOTE_CHARS', () => {
    const longBody = `${body}\n${'y'.repeat(MAX_QUOTE_CHARS + 50)}`;
    const quote = 'y'.repeat(MAX_QUOTE_CHARS);
    const raw = makeReceipt(longBody, {
      evidence: [{ kind: 'failure', quote }],
    });
    expect(validateReceipt(raw, { hash: sha256(longBody) }, longBody, true).ok).toBe(true);
  });

  it('rejects a failing log without fatal/failure evidence as missing-failure-evidence', () => {
    expect(FAILURE_SIGNAL.test(body)).toBe(true);
    const raw = makeReceipt(body, {
      evidence: [{ kind: 'warning', quote: 'unused variable' }],
    });
    expect(validateReceipt(raw, { hash: sha256(body) }, body, true)).toEqual({
      ok: false,
      reason: 'missing-failure-evidence',
    });
  });

  it('does not require failure evidence when the body carries no failure signal', () => {
    const plain = 'Done in 1.4s\nwarning: deprecated flag used';
    const raw = makeReceipt(plain, {
      status: 'failure',
      evidence: [{ kind: 'warning', quote: 'warning: deprecated flag used' }],
    });
    expect(validateReceipt(raw, { hash: sha256(plain) }, plain, true).ok).toBe(true);
  });

  it('deduplicates identical kind+quote pairs', () => {
    const quote = 'Build failed with 1 error';
    const raw = makeReceipt(body, {
      evidence: [
        { kind: 'failure', quote },
        { kind: 'failure', quote },
      ],
    });
    const result = validateReceipt(raw, { hash: sha256(body) }, body, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidence).toHaveLength(1);
  });

  it('computes 1-based line numbers for quotes', () => {
    const raw = makeReceipt(body, {
      evidence: [{ kind: 'failure', quote: 'Build failed with 1 error' }],
    });
    const result = validateReceipt(raw, { hash: sha256(body) }, body, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidence[0]?.line).toBe(3);
  });
});

describe('reduceLongOutput orchestration (SoL-Pi index.ts gate order)', () => {
  const bigBody = Array.from(
    { length: 120 },
    (_, i) =>
      `src/f${i % 8}.ts:${i + 1}:1 error TS2322: Type 'x' is not assignable to type 'number' [${i}]`,
  ).join('\n');

  it('skips small outputs as source-too-small, leaving the original untouched', async () => {
    const outcome = await reduceLongOutput({
      body: 'short log\nerror: boom',
      command: 'get_diagnostics:tsc',
      isError: true,
    });
    expect(outcome).toEqual({ applied: false, reason: 'source-too-small' });
  });

  it('skips over-long outputs as source-over-max-chars', async () => {
    const outcome = await reduceLongOutput({
      body: bigBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      maxChars: 100,
    });
    expect(outcome).toEqual({ applied: false, reason: 'source-over-max-chars' });
  });

  it('gates secrets before reduction, even when the reducer would succeed', async () => {
    const secretLine = 'api_key = "sk-test-1234567890abcdef"';
    const secretBody = `${bigBody}\n${secretLine}`;
    expect(LIKELY_SECRET.test(secretBody)).toBe(true);
    const valid = makeReceipt(secretBody, {
      evidence: [{ kind: 'failure', quote: secretLine }],
    });
    const outcome = await reduceLongOutput({
      body: secretBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      reducer: mockReducer(valid),
    });
    expect(outcome).toEqual({ applied: false, reason: 'likely-secret' });
  });

  it('maps a throwing reducer to reducer-error without throwing', async () => {
    const outcome = await reduceLongOutput({
      body: bigBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      reducer: {
        name: 'exploding',
        reduce: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(outcome).toEqual({ applied: false, reason: 'reducer-error' });
  });

  it('passes receipt validation failures through with their reason', async () => {
    for (const [raw, reason] of [
      ['{nope', 'invalid-json'],
      [
        makeReceipt(bigBody, {
          evidence: [{ kind: 'summary', quote: bigBody.split('\n')[0] ?? '' }],
        }),
        'missing-failure-evidence',
      ],
      [
        makeReceipt(bigBody, { evidence: [{ kind: 'failure', quote: 'never logged' }] }),
        'unverifiable-quote',
      ],
    ] as const) {
      const outcome = await reduceLongOutput({
        body: bigBody,
        command: 'get_diagnostics:tsc',
        isError: true,
        reducer: mockReducer(raw),
      });
      expect(outcome).toEqual({ applied: false, reason });
    }
  });

  it('rejects a valid-but-larger receipt as receipt-not-smaller', async () => {
    // 12 distinct in-body quotes (~60 chars each) + receipt framing > source.
    const lines = Array.from(
      { length: 24 },
      (_, i) => `error TS${1000 + i}: something failed in module ${i} details ${(i * 7) % 13}`,
    );
    const smallBody = lines.join('\n');
    expect(Buffer.byteLength(smallBody, 'utf8')).toBeGreaterThanOrEqual(1000);
    const distinct = [...new Set(lines)].slice(0, 12);
    const raw = makeReceipt(smallBody, {
      evidence: distinct.map((quote) => ({ kind: 'failure' as const, quote })),
    });
    const withMock = await reduceLongOutput({
      body: smallBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      minBytes: 1000,
      reducer: mockReducer(raw),
    });
    expect(withMock).toEqual({ applied: false, reason: 'receipt-not-smaller' });
  });

  it('applies a valid smaller receipt from a mock (zero-spend path)', async () => {
    const quote = bigBody.split('\n')[0] ?? '';
    const raw = makeReceipt(bigBody, { evidence: [{ kind: 'failure', quote }] });
    const outcome = await reduceLongOutput({
      body: bigBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      reducer: mockReducer(raw),
    });
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    expect(outcome.receipt).toContain(REDUCER_RECEIPT_PREFIX);
    expect(outcome.receipt).toContain(`source_sha256=${sha256(bigBody)}`);
    expect(outcome.receipt).toContain(JSON.stringify(quote));
    expect(outcome.receiptBytes).toBeLessThan(outcome.sourceBytes);
    expect(outcome.evidenceCount).toBe(1);
    expect(outcome.uncertain).toBe(false);
  });
});

describe('LocalExtractiveReducer (zero-spend suite: no model, no network, no subprocess)', () => {
  const reducer = new LocalExtractiveReducer();
  const bigBody = Array.from(
    { length: 120 },
    (_, i) =>
      `src/f${i % 8}.ts:${i + 1}:1 error TS2322: Type 'x' is not assignable to type 'number' [${i}]`,
  ).join('\n');

  it('produces an applicable receipt whose every quote is byte-for-byte in the log', async () => {
    const outcome = await reduceLongOutput({
      body: bigBody,
      command: 'get_diagnostics:tsc',
      isError: true,
      reducer,
    });
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;
    const checked = validateReceipt(
      await reducer.reduce({ command: 'get_diagnostics:tsc', isError: true, body: bigBody }),
      { hash: sha256(bigBody) },
      bigBody,
      true,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.evidence.length).toBeGreaterThan(0);
      expect(checked.value.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
      for (const item of checked.value.evidence) {
        expect(bigBody.includes(item.quote)).toBe(true);
      }
      expect(checked.value.evidence.some((e) => e.kind === 'failure' || e.kind === 'fatal')).toBe(
        true,
      );
    }
  });

  it('marks a clean log as success with uncertain=true', async () => {
    const cleanLines = Array.from({ length: 120 }, (_, i) => `checked src/f${i}.ts ok`);
    const cleanBody = cleanLines.join('\n');
    const raw = await reducer.reduce({
      command: 'get_diagnostics:tsc',
      isError: false,
      body: cleanBody,
    });
    const checked = validateReceipt(raw, { hash: sha256(cleanBody) }, cleanBody, false);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.status).toBe('success');
      expect(checked.value.uncertain).toBe(true);
    }
  });

  it('caps evidence at MAX_EVIDENCE_ITEMS and quotes at MAX_QUOTE_CHARS', async () => {
    const raw = await reducer.reduce({ command: 'cmd', isError: true, body: bigBody });
    const parsed = JSON.parse(raw) as { evidence: Array<{ quote: string }> };
    expect(parsed.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
    for (const item of parsed.evidence) {
      expect(item.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    }
  });
});

describe('get_diagnostics reduce_output integration', () => {
  function tscOutput(errors: number, files = 4): string {
    return Array.from(
      { length: errors },
      (_, i) =>
        `src/f${i % files}.ts(${(i % 50) + 1},${(i % 20) + 1}): error TS2322: Type 'x${i}' is not assignable to type 'number'.`,
    ).join('\n');
  }

  const longOutput = tscOutput(80);
  const runLong = () => async () => ({ stdout: longOutput, stderr: '', exitCode: 1 as const });

  it('reduces a long output to a receipt, keeping counts and dropping the bulk', async () => {
    const result = await getDiagnostics(null, '/proj', {
      checker: 'tsc',
      runCommand: runLong(),
      reduceOutput: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.total_errors).toBe(80);
    expect(result.value.files_with_errors).toBe(4);
    expect(result.value.files).toEqual([]);
    expect(result.value.truncated_errors).toBe(80);
    expect(result.value.reduction?.applied).toBe(true);
    expect(result.value.reduction?.receipt).toContain(REDUCER_RECEIPT_PREFIX);
    expect(result.value.reduction?.receipt_bytes).toBeLessThan(
      result.value.reduction?.source_bytes ?? 0,
    );
  });

  it('leaves small outputs untouched with source-too-small', async () => {
    const result = await getDiagnostics(null, '/proj', {
      checker: 'tsc',
      runCommand: async () => ({ stdout: tscOutput(2), stderr: '', exitCode: 1 }),
      reduceOutput: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.reduction).toEqual({ applied: false, reason: 'source-too-small' });
    expect(result.value.files.length).toBeGreaterThan(0);
  });

  it('keeps the original output when it looks secret-bearing', async () => {
    // The secret must survive checker parsing, so it rides inside a diagnostic message.
    const secretStdout = `${longOutput}\nsrc/secret.ts(9,9): error TS9999: leaked api_key = "sk-test-1234567890abcdef"`;
    const result = await getDiagnostics(null, '/proj', {
      checker: 'tsc',
      runCommand: async () => ({ stdout: secretStdout, stderr: '', exitCode: 1 }),
      reduceOutput: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    // Secret gate runs on the rendered diagnostics body, which carries the message.
    expect(result.value.reduction).toEqual({ applied: false, reason: 'likely-secret' });
    expect(result.value.files.length).toBeGreaterThan(0);
  });

  it('keeps the original output when the reducer receipt fails verification', async () => {
    const result = await getDiagnostics(null, '/proj', {
      checker: 'tsc',
      runCommand: runLong(),
      reduceOutput: true,
      reducer: mockReducer('{invalid receipt json'),
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.reduction).toEqual({ applied: false, reason: 'invalid-json' });
    expect(result.value.files.length).toBeGreaterThan(0);
  });

  it('is opt-in: without reduce_output the response has no reduction field', async () => {
    const result = await getDiagnostics(null, '/proj', {
      checker: 'tsc',
      runCommand: runLong(),
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.reduction).toBeUndefined();
    expect(result.value.files.length).toBeGreaterThan(0);
  });

  it('renders one line per diagnostic for the reducer body', () => {
    const body = renderDiagnosticsBody(
      [
        {
          file: 'src/a.ts',
          line: 3,
          column: 5,
          severity: 'error',
          code: 'TS2322',
          message: 'boom',
        },
      ],
      null,
    );
    expect(body).toBe('src/a.ts:3:5 error TS2322: boom');
  });
});
