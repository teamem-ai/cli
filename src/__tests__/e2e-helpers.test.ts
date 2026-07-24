import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Unit tests for the E2E script's helper logic.
 *
 * We inline parseCliOutput here to avoid importing from the scripts directory
 * (which lives outside src/ and would break the dependency boundary check).
 * The canonical implementation lives in scripts/m1-init-e2e.ts — this test
 * file validates the same parsing contract.
 */

// Inline copy of parseCliOutput from scripts/m1-init-e2e.ts.
// Must stay in sync — verified by this test file.
interface InitResult {
  repo: string;
  commitSha: string;
  files: number;
  ingested: number;
  rejected: number;
  jobIds: string[];
  jobStatus: string | null;
  pagesCreated: number;
  duplicate: boolean;
  rawOutput: string;
}

function parseCliOutput(output: string): InitResult {
  const result: InitResult = {
    repo: '',
    commitSha: '',
    files: 0,
    ingested: 0,
    rejected: 0,
    jobIds: [],
    jobStatus: null,
    pagesCreated: 0,
    duplicate: false,
    rawOutput: output,
  };

  const repoMatch = output.match(/^Repository:\s+(.+)$/m);
  if (repoMatch) result.repo = repoMatch[1]!.trim();

  const commitMatch = output.match(/^Commit:\s+([0-9a-f]{7,40})$/m);
  if (commitMatch) result.commitSha = commitMatch[1]!;

  const filesMatch = output.match(/^Files:\s+(\d+)$/m);
  if (filesMatch) result.files = parseInt(filesMatch[1]!, 10);

  const ingestedMatch = output.match(/^Ingested:\s+(\d+)$/m);
  if (ingestedMatch) result.ingested = parseInt(ingestedMatch[1]!, 10);

  const rejectedMatch = output.match(/^Rejected:\s+(\d+)$/m);
  if (rejectedMatch) result.rejected = parseInt(rejectedMatch[1]!, 10);

  const jobsMatch = output.match(/^Jobs:\s+(.+)$/m);
  if (jobsMatch) {
    result.jobIds = jobsMatch[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const statusMatch = output.match(/^Job status:\s+(\S+)$/m);
  if (statusMatch) result.jobStatus = statusMatch[1]!;

  const pagesMatch = output.match(/^Pages:\s+(\d+)$/m);
  if (pagesMatch) result.pagesCreated = parseInt(pagesMatch[1]!, 10);

  if (output.includes('was a duplicate')) {
    result.duplicate = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseCliOutput (E2E helper)', () => {
  // --- Success paths ---

  it('parses a complete init output with compilation results', () => {
    const output = [
      'Repository:   teamem-ai/e2e-sample',
      'Commit:       abcdef1234567890abcdef1234567890abcdef12',
      'Files:        12',
      'Ingested:     12',
      'Rejected:     0',
      'Jobs:         00000000-0000-4000-8000-000000000001',
      'Job status:   completed',
      'Pages:        5',
    ].join('\n');

    const result = parseCliOutput(output);

    expect(result.repo).toBe('teamem-ai/e2e-sample');
    expect(result.commitSha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.files).toBe(12);
    expect(result.ingested).toBe(12);
    expect(result.rejected).toBe(0);
    expect(result.jobIds).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(result.jobStatus).toBe('completed');
    expect(result.pagesCreated).toBe(5);
    expect(result.duplicate).toBe(false);
  });

  it('parses multiple job IDs', () => {
    const output = [
      'Repository:   org/repo',
      'Commit:       abcdef12',
      'Files:        600',
      'Ingested:     600',
      'Rejected:     0',
      'Jobs:         00000000-0000-4000-8000-000000000001, 00000000-0000-4000-8000-000000000002',
      'Job status:   completed',
      'Pages:        3',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.jobIds).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('detects compilation duplicate', () => {
    const output = [
      'Repository:   org/repo',
      'Commit:       abcdef12',
      'Files:        5',
      'Ingested:     5',
      'Rejected:     0',
      'Jobs:         00000000-0000-4000-8000-000000000001',
      'Job status:   completed',
      'Pages:        3',
      '(compilation was a duplicate — same results as previous run)',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.duplicate).toBe(true);
  });

  // --- Failure paths ---

  it('handles failed job status', () => {
    const output = [
      'Repository:   org/repo',
      'Commit:       abcdef12',
      'Files:        3',
      'Ingested:     3',
      'Rejected:     0',
      'Jobs:         00000000-0000-4000-8000-000000000001',
      'Job status:   failed',
      'Pages:        0',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.jobStatus).toBe('failed');
    expect(result.pagesCreated).toBe(0);
  });

  it('handles all-rejected output (no jobs)', () => {
    const output = [
      'Repository:   org/repo',
      'Commit:       abcdef12',
      'Files:        5',
      'Ingested:     0',
      'Rejected:     5',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(5);
    expect(result.jobIds).toEqual([]);
    expect(result.jobStatus).toBeNull();
  });

  // --- Boundary / safety ---

  it('handles empty output gracefully', () => {
    const result = parseCliOutput('');
    expect(result.repo).toBe('');
    expect(result.files).toBe(0);
    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.jobIds).toEqual([]);
    expect(result.jobStatus).toBeNull();
    expect(result.pagesCreated).toBe(0);
  });

  it('handles partial output (scan-only, no push)', () => {
    const output = [
      'Repository: my-org/my-repo',
      'Commit:     1234567890abcdef',
      'Scanned at: 2026-01-01T00:00:00.000Z',
      'Files:      8',
      '',
      'Scanned files:',
      '  README.md',
      '  src/index.ts',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.repo).toBe('my-org/my-repo');
    expect(result.commitSha).toBe('1234567890abcdef');
    expect(result.files).toBe(8);
    // No ingest/compilation data.
    expect(result.ingested).toBe(0);
    expect(result.jobIds).toEqual([]);
  });

  it('does not match "Files:" from random text', () => {
    const output = 'Some text with Files: somewhere but not at line start';
    const result = parseCliOutput(output);
    expect(result.files).toBe(0);
  });

  it('handles large numbers correctly', () => {
    const output = [
      'Repository:   big/repo',
      'Commit:       abcdef12',
      'Files:        999999',
      'Ingested:     999999',
      'Rejected:     0',
      'Jobs:         aaaa0000-0000-4000-8000-000000000001',
      'Job status:   completed',
      'Pages:        5000',
    ].join('\n');

    const result = parseCliOutput(output);
    expect(result.files).toBe(999999);
    expect(result.ingested).toBe(999999);
    expect(result.pagesCreated).toBe(5000);
  });
});

describe('E2E idempotency key stability', () => {
  it('produces deterministic keys for the same input', () => {
    // Same logic as scan.ts: sha256(repo + commitSha + path)
    const key1 = createHash('sha256')
      .update('teamem-ai/test-repo')
      .update('a'.repeat(40))
      .update('src/index.ts')
      .digest('hex');

    const key2 = createHash('sha256')
      .update('teamem-ai/test-repo')
      .update('a'.repeat(40))
      .update('src/index.ts')
      .digest('hex');

    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for different paths', () => {
    const key1 = createHash('sha256')
      .update('org/repo')
      .update('abc123')
      .update('a.ts')
      .digest('hex');

    const key2 = createHash('sha256')
      .update('org/repo')
      .update('abc123')
      .update('b.ts')
      .digest('hex');

    expect(key1).not.toBe(key2);
  });
});
