import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { cliInitPayload, evidence } from '@teamem/schema';
import { scanRepository, toRepoFileEvidence } from '../scan.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureRoot: string;

/**
 * Create a temporary git repository with a known set of files for testing.
 * Returns the path to the repository root.
 */
function createFixtureRepo(): string {
  const root = join(tmpdir(), `teamem-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });

  // Init git.
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@teamem.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Teamem Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/teamem-ai/test-repo.git'], { cwd: root, stdio: 'ignore' });

  // Create a .gitignore.
  writeFileSync(join(root, '.gitignore'), 'ignored/\n*.log\n');

  // Create directories.
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });

  // Create text files.
  writeFileSync(join(root, 'README.md'), '# Test Repo\n\nThis is a test repository.\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'src', 'utils.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-repo', version: '1.0.0' }, null, 2) + '\n');

  // Create binary-like file.
  writeFileSync(join(root, 'assets', 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  // Create ignored file.
  mkdirSync(join(root, 'ignored'), { recursive: true });
  writeFileSync(join(root, 'ignored', 'secret.txt'), 'secret content\n');

  // Create an empty file.
  writeFileSync(join(root, 'empty.txt'), '');

  // Commit all files so git ls-files --cached works.
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: root, stdio: 'ignore' });

  return root;
}

beforeAll(() => {
  fixtureRoot = createFixtureRepo();
});

afterAll(() => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanRepository', () => {
  // --- Success paths ---

  it('scans a fixture repo and produces validated events', () => {
    const result = scanRepository(fixtureRoot);

    // Result structure.
    expect(result.repo).toBe('teamem-ai/test-repo');
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.scannedAt).toBeTruthy();
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThanOrEqual(3); // README, src/index.ts, src/utils.ts, package.json

    for (const file of result.files) {
      // Every payload must pass cliInitPayload validation.
      const payload = {
        schemaVersion: 1 as const,
        repo: file.repo,
        commitSha: file.commitSha,
        path: file.path,
        content: file.content,
        truncated: file.truncated || undefined,
      };
      const parsed = cliInitPayload.safeParse(payload);
      expect(parsed.success, `Payload validation failed for ${file.path}: ${parsed.error?.message}`).toBe(true);

      // Evidence must contain repo + commitSha + path.
      expect(file.repo).toBeTruthy();
      expect(file.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(file.path.length).toBeGreaterThan(0);
      expect(file.content.length).toBeGreaterThan(0);

      // Idempotency key must be a 64-char hex string (sha256).
      expect(file.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

      // Verify idempotency key is sha256(repo + commitSha + path).
      const expectedKey = createHash('sha256')
        .update(file.repo)
        .update(file.commitSha)
        .update(file.path)
        .digest('hex');
      expect(file.idempotencyKey).toBe(expectedKey);
    }
  });

  it('produces file events with specific expected paths', () => {
    const result = scanRepository(fixtureRoot);
    const paths = result.files.map((f) => f.path).sort();

    expect(paths).toContain('README.md');
    expect(paths).toContain('package.json');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/utils.ts');
  });

  it('respects .gitignore by skipping ignored files', () => {
    const result = scanRepository(fixtureRoot);
    const paths = result.files.map((f) => f.path);

    // ignored/secret.txt should not appear.
    expect(paths).not.toContain('ignored/secret.txt');
    expect(paths.filter((p) => p.startsWith('ignored')).length).toBe(0);

    // .gitignore itself should be scanned (it's tracked).
    expect(paths).toContain('.gitignore');
  });

  it('skips binary files', () => {
    const result = scanRepository(fixtureRoot);
    const paths = result.files.map((f) => f.path);

    // PNG file should be skipped.
    expect(paths).not.toContain('assets/image.png');
  });

  it('skips empty files', () => {
    const result = scanRepository(fixtureRoot);
    const paths = result.files.map((f) => f.path);

    expect(paths).not.toContain('empty.txt');
  });

  it('skips .git directory contents (but allows .gitignore, .gitattributes)', () => {
    const result = scanRepository(fixtureRoot);
    const paths = result.files.map((f) => f.path);

    // Files inside .git/ should not appear.
    expect(paths.filter((p) => p.startsWith('.git/')).length).toBe(0);
    // .gitignore and similar root-level dot-git files should be scannable.
    expect(paths).toContain('.gitignore');
  });

  // --- Idempotency ---

  it('produces stable idempotency keys for the same file at the same commit', () => {
    const result1 = scanRepository(fixtureRoot);
    const result2 = scanRepository(fixtureRoot);

    expect(result1.commitSha).toBe(result2.commitSha);

    // Build lookup by path.
    const byPath1 = new Map(result1.files.map((f) => [f.path, f]));
    const byPath2 = new Map(result2.files.map((f) => [f.path, f]));

    for (const [path, file1] of byPath1) {
      const file2 = byPath2.get(path);
      expect(file2, `Missing file in second scan: ${path}`).toBeDefined();
      expect(file2!.idempotencyKey).toBe(file1.idempotencyKey);
      expect(file2!.repo).toBe(file1.repo);
      expect(file2!.commitSha).toBe(file1.commitSha);
    }
  });

  it('produces different idempotency keys for different files', () => {
    const result = scanRepository(fixtureRoot);
    const keys = new Set(result.files.map((f) => f.idempotencyKey));
    expect(keys.size).toBe(result.files.length);
  });

  // --- Failure paths ---

  it('throws when given a non-git directory', () => {
    const nonGitDir = join(tmpdir(), `teamem-no-git-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });
    try {
      expect(() => scanRepository(nonGitDir)).toThrow(/git repository/);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('throws when given a non-existent path', () => {
    expect(() => scanRepository('/nonexistent/path/that/does/not/exist')).toThrow();
  });

  it('handles repos with no files gracefully', () => {
    // Create a fresh repo with no committed files.
    const emptyRoot = join(tmpdir(), `teamem-empty-${Date.now()}`);
    mkdirSync(emptyRoot, { recursive: true });
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: emptyRoot, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@teamem.dev'], { cwd: emptyRoot, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Teamem Test'], { cwd: emptyRoot, stdio: 'ignore' });
      // No commits → git rev-parse HEAD fails → should throw.
      expect(() => scanRepository(emptyRoot)).toThrow(/commit/);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  // --- Boundary / safety ---

  it('truncates large files and sets truncated flag', () => {
    // Use a custom low limit to test truncation.
    const result = scanRepository(fixtureRoot, { maxFileBytes: 4 }); // very low limit forces truncation
    const truncatedFiles = result.files.filter((f) => f.truncated);
    expect(truncatedFiles.length).toBeGreaterThan(0);
    for (const f of truncatedFiles) {
      expect(f.truncated).toBe(true);
      // Content should be limited.
      expect(f.content.length).toBeLessThanOrEqual(4);
    }
  });

  it('toRepoFileEvidence builds valid repo_file evidence', () => {
    const result = scanRepository(fixtureRoot);
    expect(result.files.length).toBeGreaterThan(0);

    for (const file of result.files) {
      const ev = toRepoFileEvidence(file);
      expect(ev.kind).toBe('repo_file');
      expect(ev.repo).toBe(file.repo);
      expect(ev.commitSha).toBe(file.commitSha);
      expect(ev.path).toBe(file.path);
      expect(ev.at).toBeTruthy();

      // Validate against the full evidence schema.
      const parsed = evidence.safeParse(ev);
      expect(parsed.success, `Evidence validation failed for ${file.path}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('produces events whose payloads match the scanned file content', () => {
    const result = scanRepository(fixtureRoot);
    const readmeFile = result.files.find((f) => f.path === 'README.md');
    expect(readmeFile).toBeDefined();
    expect(readmeFile!.content).toContain('# Test Repo');
    expect(readmeFile!.truncated).toBe(false);
  });
});
