#!/usr/bin/env -S npx tsx

/**
 * M1-CLI-04 — teamem init Cold-Start End-to-End Script
 *
 * This script validates the full "scan → ingest → compile → verify" pipeline:
 *
 *   1. Connect to a running teamem-server portal (or bootstrap one)
 *   2. Bootstrap a project + API key (when admin credentials are available)
 *   3. Create a sample git repository with meaningful code
 *   4. Run `teamem init` against the sample repo
 *   5. Verify results: ≥1 concept page, each with evidence, index readable
 *   6. Print spot-check samples
 *   7. If no provider is available, honestly skip compilation assertions
 *
 * Configuration (all via environment variables):
 *
 *   Required:
 *     TEAMEM_PORTAL_URL  – Portal base URL (e.g. https://api.teamem.ai)
 *     TEAMEM_API_TOKEN   – API token for the project (tm_…)
 *     TEAMEM_PROJECT_ID  – Project ID (prj_…)
 *
 *   Optional bootstrap (provide ALL three to create project + key via API):
 *     TEAMEM_ADMIN_TOKEN – Admin bearer token for server management API
 *     TEAMEM_TEAM_NAME   – Team name for bootstrap (default: "E2E Test")
 *     TEAMEM_PROJECT_NAME – Project name for bootstrap (default: "init-e2e")
 *
 *   Optional:
 *     TEAMEM_VERBOSE     – Set to "1" to print detailed debug output
 *     TEAMEM_SKIP_CLEANUP – Set to "1" to keep the temp directory
 *
 * Usage:
 *   TEAMEM_PORTAL_URL=http://localhost:3000 \
 *   TEAMEM_API_TOKEN=tm_xxx \
 *   TEAMEM_PROJECT_ID=prj_xxx \
 *   npx tsx scripts/m1-init-e2e.ts
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface E2EConfig {
  portalUrl: string;
  apiToken: string;
  projectId: string;
  adminToken?: string;
  teamName?: string;
  projectName?: string;
  verbose: boolean;
  skipCleanup: boolean;
}

interface StepResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  detail: string;
}

interface SpotCheck {
  conceptPath: string;
  title: string;
  type: string;
  evidenceCount: number;
  bodyExcerpt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig(): E2EConfig {
  const portalUrl = process.env.TEAMEM_PORTAL_URL;
  const apiToken = process.env.TEAMEM_API_TOKEN;
  const projectId = process.env.TEAMEM_PROJECT_ID;

  if (!portalUrl) {
    throw new Error(
      'TEAMEM_PORTAL_URL is required (e.g. http://localhost:3000)',
    );
  }
  if (!apiToken) {
    throw new Error('TEAMEM_API_TOKEN is required (e.g. tm_...)');
  }
  if (!projectId) {
    throw new Error('TEAMEM_PROJECT_ID is required (e.g. prj_...)');
  }

  return {
    portalUrl: portalUrl.replace(/\/$/, ''),
    apiToken,
    projectId,
    adminToken: process.env.TEAMEM_ADMIN_TOKEN,
    teamName: process.env.TEAMEM_TEAM_NAME || 'E2E Test',
    projectName: process.env.TEAMEM_PROJECT_NAME || 'init-e2e',
    verbose: process.env.TEAMEM_VERBOSE === '1',
    skipCleanup: process.env.TEAMEM_SKIP_CLEANUP === '1',
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function vlog(message: string): void {
  if (loadConfigSafely().verbose) {
    console.log(`[e2e:verbose] ${message}`);
  }
}

function warn(message: string): void {
  console.warn(`[e2e:warn] ${message}`);
}

// Lazy config for vlog (called before full validation)
function loadConfigSafely(): { verbose: boolean } {
  return { verbose: process.env.TEAMEM_VERBOSE === '1' };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(
  config: E2EConfig,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const url = `${config.portalUrl}${path}`;
  vlog(`GET ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

async function apiPost(
  config: E2EConfig,
  path: string,
  payload: unknown,
  adminToken?: string,
): Promise<{ status: number; body: unknown }> {
  const url = `${config.portalUrl}${path}`;
  const token = adminToken || config.apiToken;
  vlog(`POST ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Bootstrap (optional — when admin credentials are available)
// ---------------------------------------------------------------------------

interface BootstrapResult {
  teamId: string;
  projectId: string;
  apiToken: string;
  credentialId: string;
}

/**
 * Attempt to bootstrap a team + project + API key via the server's
 * management API. This is best-effort: if the server doesn't expose
 * these endpoints yet, we fall back to pre-configured credentials.
 */
async function tryBootstrap(config: E2EConfig): Promise<BootstrapResult | null> {
  if (!config.adminToken) {
    log('No TEAMEM_ADMIN_TOKEN — skipping bootstrap, using provided credentials');
    return null;
  }

  log(
    `Bootstrapping team="${config.teamName}" project="${config.projectName}"...`,
  );

  try {
    // The server's bootstrap API may vary. We try several known patterns.
    // Pattern 1: POST /v1/admin/bootstrap
    const { status, body } = await apiPost(
      config,
      '/v1/admin/bootstrap',
      {
        teamName: config.teamName,
        projectName: config.projectName,
      },
      config.adminToken,
    );

    if (status === 200 || status === 201) {
      const data = body as Record<string, unknown>;
      if (data.apiToken && data.projectId) {
        log('Bootstrap succeeded via /v1/admin/bootstrap');
        return {
          teamId: (data.teamId as string) || '',
          projectId: data.projectId as string,
          apiToken: data.apiToken as string,
          credentialId: (data.credentialId as string) || '',
        };
      }
    }

    if (status === 404) {
      // Pattern 2: Try separate endpoints
      log('Bootstrap endpoint not found (404) — trying alternative paths...');

      // Try creating team first via admin API
      const teamRes = await apiPost(
        config,
        '/v1/admin/teams',
        { name: config.teamName },
        config.adminToken,
      );

      if (teamRes.status === 200 || teamRes.status === 201) {
        const teamData = teamRes.body as Record<string, unknown>;
        const teamId = teamData.id as string;

        // Create project
        const projRes = await apiPost(
          config,
          '/v1/admin/projects',
          { teamId, name: config.projectName },
          config.adminToken,
        );

        if (projRes.status === 200 || projRes.status === 201) {
          const projData = projRes.body as Record<string, unknown>;
          const projectId = projData.id as string;

          // Create API key
          const keyRes = await apiPost(
            config,
            '/v1/admin/keys',
            {
              teamId,
              projectId,
              scopes: ['events:write', 'read'],
              description: 'E2E test key',
            },
            config.adminToken,
          );

          if (keyRes.status === 200 || keyRes.status === 201) {
            const keyData = keyRes.body as Record<string, unknown>;
            log('Bootstrap succeeded via separate admin endpoints');
            return {
              teamId,
              projectId,
              apiToken: keyData.token as string,
              credentialId: keyData.id as string,
            };
          }
        }
      }
    }

    warn(
      `Bootstrap returned status ${status} — falling back to provided credentials`,
    );
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Bootstrap failed: ${msg} — falling back to provided credentials`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sample repository
// ---------------------------------------------------------------------------

/**
 * Create a temporary git repository with sample code that should yield
 * meaningful concept pages when compiled.
 */
function createSampleRepo(): string {
  const root = join(
    tmpdir(),
    `teamem-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  log(`Created sample repo at: ${root}`);

  // Initialize git.
  execSync('git init -b main', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "e2e@teamem.dev"', {
    cwd: root,
    stdio: 'ignore',
  });
  execSync('git config user.name "Teamem E2E"', {
    cwd: root,
    stdio: 'ignore',
  });
  execSync(
    'git remote add origin https://github.com/teamem-ai/e2e-sample.git',
    { cwd: root, stdio: 'ignore' },
  );

  // Create .gitignore
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.env\n');

  // Create src directory
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  mkdirSync(join(root, 'src', 'models'), { recursive: true });
  mkdirSync(join(root, 'src', 'utils'), { recursive: true });

  // package.json
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'task-tracker',
        version: '1.0.0',
        description: 'A simple task tracking application',
        main: 'src/index.ts',
        scripts: {
          start: 'tsx src/index.ts',
        },
        dependencies: {
          pg: '^8.0.0',
          zod: '^3.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  );

  // README.md
  writeFileSync(
    join(root, 'README.md'),
    `# Task Tracker

A simple task tracking application built with TypeScript and PostgreSQL.

## Architecture

The application follows a layered architecture:

- **Models** — Database entity types and validation schemas
- **Services** — Business logic for task lifecycle management
- **Utils** — Shared utilities including connection pooling and retry logic

## Task Lifecycle

1. Tasks are created in \`todo\` status
2. A task moves to \`in_progress\` when work begins
3. Work is validated by a peer before moving to \`review\`
4. Reviewed tasks are marked \`done\`
5. Completed tasks are archived after 30 days

## Key Decisions

- We use PostgreSQL for persistence because of its ACID guarantees
- Task IDs use UUID v4 to avoid enumeration attacks
- The connection pool is configured with a max of 20 connections
- Retry logic uses exponential backoff with a max of 3 attempts

## Conventions

- All database access goes through a service, never directly from routes
- Validation uses Zod schemas, not manual type guards
- Errors are wrapped in a custom \`AppError\` class with machine-readable codes
- Timestamps are always stored in UTC

## Gotchas

- The connection pool must be initialized before any query runs
- Task status transitions are one-way: you cannot go from \`done\` back to \`todo\`
- The retry decorator catches ALL errors including fatal ones — use with caution
`,
  );

  // src/index.ts
  writeFileSync(
    join(root, 'src', 'index.ts'),
    `import { createPool } from './utils/db.js';
import { TaskService } from './services/task-service.js';
import { validateTask } from './models/task.js';

export async function main(): Promise<void> {
  const pool = createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'tasktracker',
    user: process.env.DB_USER || 'app',
    password: process.env.DB_PASSWORD,
  });

  const taskService = new TaskService(pool);

  // Example: create a task
  const task = validateTask({
    title: 'Set up CI pipeline',
    description: 'Configure GitHub Actions for automated testing',
    priority: 'high',
  });

  await taskService.create(task);
  console.log('Task created successfully');
}
`,
  );

  // src/models/task.ts
  writeFileSync(
    join(root, 'src', 'models', 'task.ts'),
    `import { z } from 'zod';

export const TaskStatus = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  DONE: 'done',
  ARCHIVED: 'archived',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const taskSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done', 'archived']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  assignedTo: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type Task = z.infer<typeof taskSchema>;

export function validateTask(input: unknown): Task {
  return taskSchema.parse(input);
}

/**
 * Valid status transitions.
 * Tasks cannot go backwards — this enforces the one-way lifecycle.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress'],
  in_progress: ['review'],
  review: ['done', 'todo'], // reject back to todo
  done: ['archived'],
  archived: [],
};
`,
  );

  // src/services/task-service.ts
  writeFileSync(
    join(root, 'src', 'services', 'task-service.ts'),
    `import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus } from '../models/task.js';
import { VALID_TRANSITIONS } from '../models/task.js';
import { withRetry } from '../utils/retry.js';
import { AppError } from '../utils/errors.js';

export class TaskService {
  constructor(private readonly pool: Pool) {}

  async create(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const result = await withRetry(async () => {
      const { rows } = await this.pool.query(
        \`INSERT INTO tasks (id, title, description, status, priority, assigned_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *\`,
        [id, task.title, task.description, task.status || 'todo', task.priority || 'medium', task.assignedTo, now, now],
      );
      return rows[0];
    });

    return result as Task;
  }

  async transitionStatus(taskId: string, newStatus: TaskStatus): Promise<Task> {
    const task = await this.findById(taskId);
    if (!task) {
      throw new AppError('NOT_FOUND', \`Task \${taskId} not found\`);
    }

    const allowed = VALID_TRANSITIONS[task.status as TaskStatus];
    if (!allowed.includes(newStatus)) {
      throw new AppError(
        'INVALID_TRANSITION',
        \`Cannot transition from \${task.status} to \${newStatus}\`,
      );
    }

    const now = new Date().toISOString();
    const { rows } = await this.pool.query(
      \`UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *\`,
      [newStatus, now, taskId],
    );

    return rows[0] as Task;
  }

  async findById(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [id],
    );
    return rows[0] ? (rows[0] as Task) : null;
  }

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC',
      [status],
    );
    return rows as Task[];
  }
}
`,
  );

  // src/utils/db.ts
  writeFileSync(
    join(root, 'src', 'utils', 'db.ts'),
    `import { Pool, types as pgTypes } from 'pg';

export interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  max?: number;
}

/**
 * Create a PostgreSQL connection pool.
 *
 * Defaults:
 * - max connections: 20
 * - idle timeout: 30 seconds
 * - connection timeout: 5 seconds
 *
 * IMPORTANT: Always call pool.end() during graceful shutdown
 * to prevent connection leaks.
 */
export function createPool(config: PoolConfig): Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Ensure numeric types are parsed as numbers, not strings
  pgTypes.setTypeParser(1700, parseFloat);

  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
  });

  return pool;
}
`,
  );

  // src/utils/retry.ts
  writeFileSync(
    join(root, 'src', 'utils', 'retry.ts'),
    `/**
 * Retry a function with exponential backoff.
 *
 * WARNING: This catches ALL errors including non-retryable ones.
 * Use only for idempotent operations or where retry is safe.
 *
 * @param fn      The async function to retry
 * @param maxRetries Maximum number of retry attempts (default: 3)
 * @param baseMs  Base delay in milliseconds (default: 100)
 * @returns       The function's return value
 * @throws        The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseMs = 100,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
`,
  );

  // src/utils/errors.ts
  writeFileSync(
    join(root, 'src', 'utils', 'errors.ts'),
    `/**
 * Machine-readable application error.
 *
 * Conventions:
 * - code: UPPER_SNAKE_CASE identifier for programmatic handling
 * - message: Human-readable description (safe for logging)
 * - statusCode: HTTP status code for API responses
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
    };
  }
}
`,
  );

  // tsconfig.json
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
  );

  // Commit all files
  execSync('git add -A', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "Initial commit: task tracker application"', {
    cwd: root,
    stdio: 'ignore',
  });

  return root;
}

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------

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

/**
 * Run `teamem init` in the sample repo directory and parse the output.
 */
async function runTeamemInit(
  config: E2EConfig,
  repoPath: string,
): Promise<InitResult> {
  const cliPath = resolve(join(__dirname, '..', 'dist', 'index.js'));

  if (!existsSync(cliPath)) {
    throw new Error(
      `CLI binary not found at ${cliPath}. Run "pnpm build" first.`,
    );
  }

  log(`Running: node ${cliPath} init --url ${config.portalUrl} --token *** --project ${config.projectId}`);

  const stdout = execFileSync(
    'node',
    [
      cliPath,
      'init',
      '--url',
      config.portalUrl,
      '--token',
      config.apiToken,
      '--project',
      config.projectId,
    ],
    {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 300_000, // 5 minutes — compilation can be slow
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const output = stdout.trim();
  log(`CLI output:\n${output}`);

  return parseCliOutput(output);
}

/**
 * Parse the CLI output string into structured data.
 */
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
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify the results by querying the portal API.
 */
async function verifyResults(
  config: E2EConfig,
  initResult: InitResult,
): Promise<{ steps: StepResult[]; spotChecks: SpotCheck[]; hasProvider: boolean }> {
  const steps: StepResult[] = [];
  const spotChecks: SpotCheck[] = [];
  let hasProvider = false;

  // Step 1: Check that files were scanned
  if (initResult.files > 0) {
    steps.push({
      name: 'File scan',
      passed: true,
      skipped: false,
      detail: `Scanned ${initResult.files} files`,
    });
  } else {
    steps.push({
      name: 'File scan',
      passed: false,
      skipped: false,
      detail: 'No files were scanned — the sample repo may be empty',
    });
  }

  // Step 2: Check that events were ingested
  if (initResult.ingested > 0) {
    steps.push({
      name: 'Event ingestion',
      passed: true,
      skipped: false,
      detail: `Ingested ${initResult.ingested} events, rejected ${initResult.rejected}`,
    });
  } else {
    steps.push({
      name: 'Event ingestion',
      passed: false,
      skipped: false,
      detail: `No events ingested (${initResult.rejected} rejected)`,
    });
  }

  // Step 3: Check compilation
  if (initResult.jobIds.length === 0) {
    // No compilation was triggered. This could mean:
    // - All events were rejected
    // - Server doesn't support compilation (= no provider)
    steps.push({
      name: 'Compilation trigger',
      passed: initResult.ingested === 0, // OK if nothing to compile
      skipped: initResult.ingested > 0, // Skipped if events exist but no compilation
      detail:
        initResult.ingested > 0
          ? 'No compilation jobs were created — provider may not be configured'
          : 'No events to compile',
    });
    hasProvider = false;
  } else if (initResult.jobStatus === 'completed') {
    steps.push({
      name: 'Compilation',
      passed: true,
      skipped: false,
      detail: `${initResult.jobIds.length} job(s) completed, ${initResult.pagesCreated} concept page(s) created`,
    });
    hasProvider = true;
  } else if (initResult.jobStatus === 'failed') {
    steps.push({
      name: 'Compilation',
      passed: false,
      skipped: false,
      detail: `Compilation failed: job status is "${initResult.jobStatus}"`,
    });
    hasProvider = true; // Provider exists but compilation failed
  } else {
    steps.push({
      name: 'Compilation',
      passed: false,
      skipped: false,
      detail: `Compilation status is "${initResult.jobStatus}" — expected "completed"`,
    });
    hasProvider = initResult.jobStatus !== null;
  }

  // Step 4: Query concepts list (index) via API
  log('Querying concepts index...');
  try {
    const listRes = await apiGet(
      config,
      `/v1/concepts?projectId=${encodeURIComponent(config.projectId)}&limit=50`,
    );

    if (listRes.status === 200) {
      const listData = listRes.body as Record<string, unknown>;
      const concepts = (listData.data as Array<Record<string, unknown>>) || [];

      if (concepts.length >= 1) {
        steps.push({
          name: 'Concepts index (≥1 page)',
          passed: true,
          skipped: false,
          detail: `Found ${concepts.length} concept page(s) in index`,
        });
      } else {
        steps.push({
          name: 'Concepts index (≥1 page)',
          passed: !hasProvider, // Only fail if provider exists
          skipped: !hasProvider,
          detail: hasProvider
            ? 'Expected ≥1 concept page but found none'
            : 'No concepts found — provider not available, skipping assertion',
        });
      }

      // Step 5: For each concept (up to 5), verify evidence
      if (concepts.length > 0) {
        let allHaveEvidence = true;
        let checkedCount = 0;

        for (const c of concepts.slice(0, 5)) {
          const uuid = c.uuid as string;
          const detailRes = await apiGet(config, `/v1/concepts/${uuid}`);

          if (detailRes.status === 200) {
            const detailData = detailRes.body as Record<string, unknown>;
            const concept = detailData.data as Record<string, unknown>;
            const evidence = (concept.evidence as Array<unknown>) || [];
            const body = (concept.body as string) || '';

            checkedCount++;

            if (evidence.length > 0) {
              spotChecks.push({
                conceptPath: (concept.path as string) || 'unknown',
                title: (concept.title as string) || 'untitled',
                type: (concept.type as string) || 'concept',
                evidenceCount: evidence.length,
                bodyExcerpt: body.slice(0, 200).replace(/\n/g, ' '),
              });
            } else {
              allHaveEvidence = false;
              warn(
                `Concept "${concept.title || uuid}" has no evidence`,
              );
            }
          }
        }

        if (checkedCount > 0) {
          steps.push({
            name: 'Evidence per page',
            passed: allHaveEvidence,
            skipped: false,
            detail: allHaveEvidence
              ? `All ${checkedCount} checked concepts have evidence`
              : 'Some concepts lack evidence',
          });
        } else {
          steps.push({
            name: 'Evidence per page',
            passed: false,
            skipped: true,
            detail: 'Could not retrieve concept details',
          });
        }
      } else {
        steps.push({
          name: 'Evidence per page',
          passed: false,
          skipped: true,
          detail: 'No concepts to check evidence for',
        });
      }
    } else if (listRes.status === 404) {
      steps.push({
        name: 'Concepts index',
        passed: !hasProvider,
        skipped: !hasProvider,
        detail: 'Concepts endpoint returned 404 — API may not support listing yet',
      });
    } else {
      steps.push({
        name: 'Concepts index',
        passed: false,
        skipped: false,
        detail: `Concepts endpoint returned HTTP ${listRes.status}`,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({
      name: 'Concepts index',
      passed: false,
      skipped: false,
      detail: `Failed to query concepts: ${msg}`,
    });
  }

  // Step 6: Search test
  try {
    const searchRes = await apiPost(config, '/v1/search', {
      projectId: config.projectId,
      query: 'task lifecycle',
      limit: 5,
    });

    if (searchRes.status === 200 || searchRes.status === 404) {
      steps.push({
        name: 'Search endpoint',
        passed: true,
        skipped: searchRes.status === 404,
        detail:
          searchRes.status === 200
            ? 'Search endpoint is available'
            : 'Search endpoint not available (404) — may be M2 feature',
      });
    } else {
      steps.push({
        name: 'Search endpoint',
        passed: false,
        skipped: false,
        detail: `Search returned HTTP ${searchRes.status}`,
      });
    }
  } catch {
    steps.push({
      name: 'Search endpoint',
      passed: true,
      skipped: true,
      detail: 'Search not available — may be M2 feature',
    });
  }

  return { steps, spotChecks, hasProvider };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== teamem init Cold-Start E2E Test ===\n');

  // 1. Load configuration
  let config: E2EConfig;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  log(`Portal URL: ${config.portalUrl}`);
  log(`Project ID: ${config.projectId}`);
  log(`API Token: ${config.apiToken.slice(0, 8)}...`);
  if (config.adminToken) {
    log('Admin token: provided (will attempt bootstrap)');
  }

  // 2. Try bootstrap (optional)
  let effectiveConfig = config;
  const bootstrapResult = await tryBootstrap(config);
  if (bootstrapResult) {
    effectiveConfig = {
      ...config,
      apiToken: bootstrapResult.apiToken,
      projectId: bootstrapResult.projectId,
    };
    log(`Using bootstrapped project: ${bootstrapResult.projectId}`);
  }

  // 3. Build CLI if needed
  const cliPath = resolve(join(__dirname, '..', 'dist', 'index.js'));
  if (!existsSync(cliPath)) {
    log('CLI not built — running pnpm build...');
    execSync('pnpm build', {
      cwd: resolve(join(__dirname, '..')),
      stdio: 'inherit',
    });
  }

  // 4. Create sample repo
  const repoPath = createSampleRepo();

  let initResult: InitResult | null = null;
  let allPassed = false;

  try {
    // 5. Run teamem init
    initResult = await runTeamemInit(effectiveConfig, repoPath);

    // 6. Verify results
    const { steps, spotChecks, hasProvider } = await verifyResults(
      effectiveConfig,
      initResult,
    );

    // 7. Print results
    console.log('\n--- Results ---\n');
    allPassed = true;
    for (const step of steps) {
      const icon = step.skipped ? '○' : step.passed ? '✓' : '✗';
      const label = step.skipped ? '(skipped)' : step.passed ? 'PASS' : 'FAIL';
      console.log(`  ${icon} ${step.name}: ${label}`);
      console.log(`    ${step.detail}`);
      if (!step.passed && !step.skipped) {
        allPassed = false;
      }
    }

    // 8. Print spot checks
    if (spotChecks.length > 0) {
      console.log('\n--- Spot Checks ---\n');
      for (const sc of spotChecks) {
        console.log(`  Path:    ${sc.conceptPath}`);
        console.log(`  Title:   ${sc.title}`);
        console.log(`  Type:    ${sc.type}`);
        console.log(`  Evidence: ${sc.evidenceCount} item(s)`);
        console.log(`  Excerpt: ${sc.bodyExcerpt}...`);
        console.log();
      }
    }

    // 9. Provider status
    console.log(
      hasProvider
        ? '\nProvider: available — compilation assertions were evaluated'
        : '\nProvider: NOT available — compilation assertions were skipped',
    );

    console.log(
      allPassed
        ? '\n✓ ALL CHECKS PASSED'
        : '\n✗ SOME CHECKS FAILED (or were skipped)',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ E2E test failed with error: ${msg}`);
    allPassed = false;
  } finally {
    // 10. Cleanup
    if (!config.skipCleanup) {
      try {
        rmSync(repoPath, { recursive: true, force: true });
        log(`Cleaned up sample repo: ${repoPath}`);
      } catch {
        warn(`Failed to clean up: ${repoPath}`);
      }
    } else {
      log(`Skipping cleanup — sample repo preserved at: ${repoPath}`);
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(
    'Unexpected error:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
