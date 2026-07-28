import { createHash } from 'node:crypto';
import {
  ingestBatchRequest,
  ingestBatchResponse,
  compilationRequest,
  compilationResponse,
  jobDetailResponse,
} from '@teamem/schema';
import type {
  IngestBatchRequest,
  IngestBatchResponse,
  CompilationRequest,
  CompilationResponse,
  Job,
} from '@teamem/schema';
import type { ScannedFile } from './scan.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events per batch push AND per compilation request. */
const BATCH_MAX_SIZE = 500;

/** Base polling interval in milliseconds. */
const POLL_INTERVAL_MS = 2_000;

/** Maximum number of poll attempts before giving up. */
const MAX_POLL_ATTEMPTS = 300; // 10 minutes at 2s intervals

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PushOptions {
  /** Portal base URL (e.g. https://api.teamem.ai). */
  url: string;
  /** API token (tm_...). Must not be logged or included in errors. */
  token: string;
  /** Target project ID (prj_...). */
  projectId: string;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Poll interval override (default 2000ms). For tests. */
  pollIntervalMs?: number;
}

export interface PushResult {
  /** Number of events successfully ingested (accepted + duplicate). */
  eventsIngested: number;
  /** Number of events rejected by the server. */
  eventsRejected: number;
  /** Compilation job IDs (one per compilation batch). */
  compilationJobIds: string[];
  /** Aggregate job status (all must be completed for "completed"). */
  jobStatus: string | null;
  /**
   * Number of DISTINCT concept pages this run touched.
   *
   * Counted over a set, not summed per event: F2 merges related events into
   * one page, so the same concept UUID legitimately appears in several
   * per-event results. Summing them inflated the number exactly when merging
   * worked well, which is backwards — "pages did not grow" is the behaviour
   * this tool exists to demonstrate.
   */
  pagesCreated: number;
  /** Whether any compilation was a duplicate. */
  compilationDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Redact the token from a string for safe logging/error messages.
 * Replaces any occurrence of the token value with "***".
 */
function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}

/**
 * Build an Authorization header value, never logged.
 */
function authHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Build a deterministic compilation idempotency key from a sorted list of
 * event IDs. Stable retry with the same set of IDs produces the same key,
 * which lets the server return the same job.
 */
function compilationIdempotencyKey(projectId: string, eventIds: string[]): string {
  const sorted = [...eventIds].sort();
  return createHash('sha256')
    .update(projectId)
    .update(sorted.join(','))
    .digest('hex');
}

/**
 * Build a batch-level idempotency key from the project + event itemKeys.
 */
function batchIdempotencyKey(projectId: string, events: ScannedFile[]): string {
  const sorted = events.map((e) => e.idempotencyKey).sort();
  return createHash('sha256')
    .update(projectId)
    .update(sorted.join(','))
    .digest('hex');
}

/**
 * Throw a user-facing error that never contains the token.
 */
function apiError(message: string, responseBody: string, token: string): never {
  const safeBody = redactToken(responseBody, token);
  throw new Error(`${message}: ${safeBody}`);
}

/**
 * Execute a single batch ingest POST and return the accepted event IDs.
 */
async function pushBatch(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  batch: ScannedFile[],
  batchIndex: number,
  token: string,
  signal?: AbortSignal,
): Promise<{ eventIds: string[]; rejected: number }> {
  const batchKey = batchIdempotencyKey(projectId, batch);
  const now = new Date().toISOString();

  const batchBody: IngestBatchRequest = {
    projectId,
    idempotencyKey: batchKey,
    events: batch.map((f) => ({
      source: {
        kind: 'cli_init' as const,
        externalId: `${f.repo}/${f.commitSha}/${f.path}`,
      },
      occurredAt: now,
      payload: {
        schemaVersion: 1 as const,
        repo: f.repo,
        commitSha: f.commitSha,
        path: f.path,
        content: f.content,
        truncated: f.truncated || undefined,
      },
      itemKey: f.idempotencyKey,
    })),
    options: {
      compile: false,
    },
  };

  // Validate request shape defensively.
  const parsedRequest = ingestBatchRequest.safeParse(batchBody);
  if (!parsedRequest.success) {
    throw new Error(
      `Batch request validation failed: ${parsedRequest.error.message}`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/events/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batchBody),
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error pushing events batch ${batchIndex}: ${msg}`,
    );
  }

  const rawBody = await response.text();
  if (!response.ok) {
    apiError(
      `Server rejected events batch ${batchIndex} (HTTP ${response.status})`,
      rawBody,
      token,
    );
  }

  let parsed: IngestBatchResponse;
  try {
    parsed = ingestBatchResponse.parse(JSON.parse(rawBody));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid batch response from server: ${redactToken(msg, token)}`,
    );
  }

  const eventIds: string[] = [];
  let rejected = 0;
  for (const item of parsed.results) {
    if (item.status === 'accepted' || item.status === 'duplicate') {
      if (item.eventId) {
        eventIds.push(item.eventId);
      }
    } else {
      rejected++;
    }
  }

  return { eventIds, rejected };
}

/**
 * Execute a single compilation POST and return the parsed response.
 */
async function triggerCompilation(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  eventIds: string[],
  idemKey: string,
  token: string,
  signal?: AbortSignal,
): Promise<CompilationResponse> {
  const compBody: CompilationRequest = {
    projectId,
    eventIds,
    idempotencyKey: idemKey,
  };

  const parsedCompReq = compilationRequest.safeParse(compBody);
  if (!parsedCompReq.success) {
    throw new Error(
      `Compilation request validation failed: ${parsedCompReq.error.message}`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/compilations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(compBody),
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error triggering compilation: ${msg}`);
  }

  const compRawBody = await response.text();
  if (!response.ok) {
    apiError(
      `Server rejected compilation request (HTTP ${response.status})`,
      compRawBody,
      token,
    );
  }

  try {
    return compilationResponse.parse(JSON.parse(compRawBody));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid compilation response from server: ${redactToken(msg, token)}`,
    );
  }
}

/**
 * Poll a single job until terminal status and return the final Job.
 */
async function pollJob(
  baseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  token: string,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<Job> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new Error('Push cancelled via abort signal');
    }

    await delay(pollIntervalMs, signal);

    let jobResponse: Response;
    try {
      jobResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
        method: 'GET',
        headers,
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error polling job ${jobId}: ${msg}`);
    }

    const jobRawBody = await jobResponse.text();
    if (!jobResponse.ok) {
      apiError(
        `Server error polling job ${jobId} (HTTP ${jobResponse.status})`,
        jobRawBody,
        token,
      );
    }

    let finalJob: Job;
    try {
      const detail = jobDetailResponse.parse(JSON.parse(jobRawBody));
      finalJob = detail.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid job response from server: ${redactToken(msg, token)}`,
      );
    }

    if (
      finalJob.status === 'completed' ||
      finalJob.status === 'failed' ||
      finalJob.status === 'cancelled'
    ) {
      return finalJob;
    }
  }

  throw new Error(
    `Job ${jobId} did not reach a terminal status after ${MAX_POLL_ATTEMPTS} attempts`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push scanned files to the portal: batch ingest (compile=false), trigger
 * compilation (batched ≤500 eventIds per call), poll all jobs until terminal
 * status, and return a summary.
 *
 * The token is NEVER included in error messages or log output.
 */
export async function pushEvents(
  files: ScannedFile[],
  options: PushOptions,
): Promise<PushResult> {
  const { url, token, projectId, signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const baseUrl = url.replace(/\/$/, '');

  if (files.length === 0) {
    return {
      eventsIngested: 0,
      eventsRejected: 0,
      compilationJobIds: [],
      jobStatus: null,
      pagesCreated: 0,
      compilationDuplicate: false,
    };
  }

  const headers = {
    'Authorization': authHeader(token),
    'Content-Type': 'application/json',
  };

  // ---- 1. Batch ingest events (compile=false) ----

  const allEventIds: string[] = [];
  let totalRejected = 0;

  for (let offset = 0; offset < files.length; offset += BATCH_MAX_SIZE) {
    const batch = files.slice(offset, offset + BATCH_MAX_SIZE);
    const batchIndex = Math.floor(offset / BATCH_MAX_SIZE) + 1;
    const { eventIds, rejected } = await pushBatch(
      baseUrl,
      headers,
      projectId,
      batch,
      batchIndex,
      token,
      signal,
    );
    allEventIds.push(...eventIds);
    totalRejected += rejected;
  }

  // ---- 2. Trigger compilations (batched ≤500 eventIds each) ----

  if (allEventIds.length === 0) {
    return {
      eventsIngested: 0,
      eventsRejected: totalRejected,
      compilationJobIds: [],
      jobStatus: null,
      pagesCreated: 0,
      compilationDuplicate: false,
    };
  }

  const compJobIds: string[] = [];
  let anyDuplicate = false;

  for (let offset = 0; offset < allEventIds.length; offset += BATCH_MAX_SIZE) {
    const batchEventIds = allEventIds.slice(offset, offset + BATCH_MAX_SIZE);
    const compIdemKey = compilationIdempotencyKey(projectId, batchEventIds);

    const compParsed = await triggerCompilation(
      baseUrl,
      headers,
      projectId,
      batchEventIds,
      compIdemKey,
      token,
      signal,
    );

    compJobIds.push(compParsed.compilationJobId);
    if (compParsed.duplicate) {
      anyDuplicate = true;
    }
  }

  // ---- 3. Poll all compilation jobs ----

  const finalJobs: Job[] = [];
  for (const jobId of compJobIds) {
    const job = await pollJob(baseUrl, headers, jobId, token, pollIntervalMs, signal);
    finalJobs.push(job);
  }

  // ---- 4. Build result summary ----

  // Distinct concept UUIDs, not a per-event sum. Two events that F2 merged
  // into one page both report that page's UUID; counting them twice reports
  // more pages than exist.
  const touchedConceptIds = new Set<string>();
  for (const job of finalJobs) {
    if (job.status === 'completed' && job.events) {
      for (const ev of job.events) {
        if (ev.status === 'compiled') {
          for (const conceptId of ev.conceptIds) {
            touchedConceptIds.add(conceptId);
          }
        }
      }
    }
  }
  const pagesCreated = touchedConceptIds.size;

  // Aggregate status: if all completed → "completed", if any failed → "failed", etc.
  const statuses = finalJobs.map((j) => j.status);
  let aggregateStatus: string;
  if (statuses.every((s) => s === 'completed')) {
    aggregateStatus = 'completed';
  } else if (statuses.some((s) => s === 'failed')) {
    aggregateStatus = 'failed';
  } else if (statuses.some((s) => s === 'cancelled')) {
    aggregateStatus = 'cancelled';
  } else {
    aggregateStatus = statuses[0] ?? 'queued';
  }

  return {
    eventsIngested: allEventIds.length,
    eventsRejected: totalRejected,
    compilationJobIds: compJobIds,
    jobStatus: aggregateStatus,
    pagesCreated,
    compilationDuplicate: anyDuplicate,
  };
}

/**
 * Small promise-based delay, with optional abort signal.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Delay cancelled via abort signal'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export { BATCH_MAX_SIZE, compilationIdempotencyKey, batchIdempotencyKey };
