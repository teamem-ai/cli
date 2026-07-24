import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cliInitPayload } from '@teamem/schema';
import type { CliInitPayload as CliInitPayloadType } from '@teamem/schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single scanned file ready to become a cli_init ingestion event. */
export interface ScannedFile {
  /** org/repo identifier (derived from git remote or directory name). */
  repo: string;
  /** Full commit SHA (40 hex chars). */
  commitSha: string;
  /** Repository-relative file path using forward slashes. */
  path: string;
  /** File content as UTF-8 text. */
  content: string;
  /** True when content was truncated because the file exceeded the size limit. */
  truncated: boolean;
  /** SHA-256 hex digest of (repo + commitSha + path) — stable idempotency key. */
  idempotencyKey: string;
}

/** Result of a full repository scan. */
export interface ScanResult {
  repo: string;
  commitSha: string;
  scannedAt: string; // ISO-8601 timestamp
  files: ScannedFile[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size (bytes) before content is truncated. */
const MAX_FILE_BYTES = 100_000; // 100 KB

/** Binary file extensions to skip (lowercase). */
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.DS_Store',
  '.a',
  '.apk',
  '.app',
  '.avi',
  '.bmp',
  '.br',
  '.bz2',
  '.class',
  '.com',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.ear',
  '.eot',
  '.exe',
  '.flv',
  '.gif',
  '.gz',
  '.ico',
  '.ipa',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lock',
  '.lz',
  '.lz4',
  '.lzma',
  '.mdb',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.msi',
  '.o',
  '.obj',
  '.odt',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.psd',
  '.rar',
  '.rpm',
  '.so',
  '.svgz',
  '.tar',
  '.tiff',
  '.ttf',
  '.war',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
  '.zst',
]);

/** Paths relative to repo root to always skip. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.gitmodules']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in `cwd` and return stdout trimmed.
 * Throws on non-zero exit.
 */
function git(args: string[], cwd: string): string {
  const stdout = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

/**
 * Derive `org/repo` from the git remote `origin`, falling back to the
 * directory basename when the remote is missing or unparseable.
 */
function deriveRepo(cwd: string): string {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd);
    // HTTPS: https://github.com/org/repo.git
    const httpsMatch = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1]!;
    // SSH: git@github.com:org/repo.git
    const sshMatch = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1]!;
    // Generic: take last two path segments
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
    const segments = cleaned.split('/');
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    return basename(cleaned);
  } catch {
    return basename(resolve(cwd));
  }
}

/** Check whether a file is likely binary by reading the first 4KB. */
function isBinary(buffer: Buffer): boolean {
  // A null byte in the first chunk strongly signals binary content.
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a repository directory and produce a `ScanResult` containing one
 * `ScannedFile` per text file discovered (respecting `.gitignore` via
 * `git ls-files`).
 *
 * The function does **not** make any network requests — it only reads the
 * local filesystem and invokes `git`.
 *
 * @param repoPath  Absolute or relative path to the repository root.
 * @param options   Optional tuning knobs.
 * @returns         A validated scan result.
 */
export function scanRepository(
  repoPath: string,
  options?: {
    /** Maximum file size in bytes before truncation (default 100 KB). */
    maxFileBytes?: number;
  },
): ScanResult {
  const root = resolve(repoPath);
  const maxBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;

  // 1. Get the commit SHA.
  let commitSha: string;
  try {
    commitSha = git(['rev-parse', 'HEAD'], root);
  } catch {
    throw new Error(
      `Failed to get HEAD commit SHA in "${root}". Ensure the directory is a git repository with at least one commit.`,
    );
  }

  // 2. Derive repo identity.
  const repo = deriveRepo(root);

  // 3. List files respecting .gitignore.
  let filePaths: string[];
  try {
    const raw = git(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      root,
    );
    filePaths = raw
      .split('\0')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  } catch {
    throw new Error(
      `Failed to list files in "${root}". Ensure the directory is a git repository.`,
    );
  }

  // 4. Collect scanned files.
  const scannedAt = new Date().toISOString();
  const files: ScannedFile[] = [];

  for (const relPath of filePaths) {
    // Normalize to forward slashes.
    const normalized = relPath.replace(/\\/g, '/');

    // Skip always-excluded paths and their descendants.
    const topDir = normalized.split('/')[0]!;
    if (ALWAYS_SKIP.has(topDir)) continue;

    // Skip well-known binary extensions.
    const lowerName = normalized.toLowerCase();
    const ext = lowerName.substring(lowerName.lastIndexOf('.'));
    if (BINARY_EXTENSIONS.has(ext)) continue;

    const absPath = join(root, normalized);

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      // File disappeared (maybe a broken symlink or race); skip.
      continue;
    }

    if (!stat.isFile()) continue;

    // Read content.
    let content: string;
    let truncated = false;

    try {
      if (stat.size > maxBytes) {
        // Read only the first maxBytes.
        const fd = readFileSync(absPath);
        const slice = fd.subarray(0, maxBytes);
        content = slice.toString('utf8');
        truncated = true;
      } else {
        const fd = readFileSync(absPath);
        // Binary check only for files within size limit (large files are
        // auto-truncated so we keep them).
        if (isBinary(fd)) continue;
        content = fd.toString('utf8');
      }
    } catch {
      // Permission errors, etc. — skip the file.
      continue;
    }

    // Skip empty files — they carry no useful knowledge.
    if (content.length === 0) continue;

    // 5. Compute idempotency key: sha256(repo + commitSha + path).
    const idempotencyKey = createHash('sha256')
      .update(repo)
      .update(commitSha)
      .update(normalized)
      .digest('hex');

    // Validate payload shape against the published schema contract.
    const payload = { schemaVersion: 1 as const, repo, commitSha, path: normalized, content, truncated: truncated || undefined };
    const parsed = cliInitPayload.safeParse(payload);
    if (!parsed.success) {
      // This should not happen for well-formed inputs, but we guard anyway.
      throw new Error(
        `cliInitPayload validation failed for "${normalized}": ${parsed.error.message}`,
      );
    }

    files.push({
      repo,
      commitSha,
      path: normalized,
      content,
      truncated,
      idempotencyKey,
    });
  }

  return { repo, commitSha, scannedAt, files };
}

/**
 * Build a `repo_file` evidence object from a `ScannedFile`.
 * This evidence is suitable for inclusion in a concept page's evidence array.
 */
export function toRepoFileEvidence(file: ScannedFile): {
  kind: 'repo_file';
  repo: string;
  commitSha: string;
  path: string;
  at: string;
} {
  return {
    kind: 'repo_file',
    repo: file.repo,
    commitSha: file.commitSha,
    path: file.path,
    at: new Date().toISOString(),
  };
}

/**
 * Re-export the `cliInitPayload` schema from `@teamem/schema` for consumers
 * that want to validate payloads without importing the schema package directly.
 */
export { cliInitPayload };
export type CliInitPayload = CliInitPayloadType;
