import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pushEvents, BATCH_MAX_SIZE, compilationIdempotencyKey } from '../push.js';
import type { ScannedFile } from '../scan.js';

// ---------------------------------------------------------------------------
// Fake server helpers
// ---------------------------------------------------------------------------

/** Valid UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx */
const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const VALID_UUID_2 = '00000000-0000-4000-8000-000000000002';
const VALID_UUID_3 = '00000000-0000-4000-8000-000000000003';
const VALID_UUID_4 = '00000000-0000-4000-8000-000000000004';
const VALID_UUID_5 = '00000000-0000-4000-8000-000000000005';
const VALID_UUID_6 = '00000000-0000-4000-8000-000000000006';
const VALID_UUID_7 = '00000000-0000-4000-8000-000000000007';

const CONCEPT_UUID_1 = 'aaaa0000-0000-4000-8000-000000000001';
const CONCEPT_UUID_2 = 'aaaa0000-0000-4000-8000-000000000002';

function makeScannedFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    repo: 'teamem-ai/test-repo',
    commitSha: 'a'.repeat(40),
    path: 'src/index.ts',
    content: 'export const answer = 42;',
    truncated: false,
    idempotencyKey:
      '1111111111111111111111111111111111111111111111111111111111111111',
    ...overrides,
  };
}

function makeScannedFiles(count: number): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push(
      makeScannedFile({
        path: `src/file-${i}.ts`,
        idempotencyKey: `${'0'.repeat(63)}${(i % 16).toString(16)}`,
      }),
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// Fake server setup
// ---------------------------------------------------------------------------

let server: Server;
let serverUrl: string;
let receivedTokens: string[] = [];
let batchBodies: unknown[] = [];
let compilationBodies: unknown[] = [];
let jobPollCounts: Map<string, number> = new Map();
let serverHandler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers['authorization'];
    if (auth) receivedTokens.push(auth);
    serverHandler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function resetState() {
  receivedTokens = [];
  batchBodies = [];
  compilationBodies = [];
  jobPollCounts = new Map();
}

/** Helper: read the JSON body of a request, then call the callback with it. */
function withJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  fn: (parsed: Record<string, unknown>) => void,
) {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      fn(parsed as Record<string, unknown>);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    }
  });
}

/**
 * Small poll interval for unit tests — real code uses 2000ms default.
 */
const TEST_POLL_MS = 5;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pushEvents', () => {
  // --- Success path: happy flow ---

  it('ingests events, triggers compilation, and polls to completion', async () => {
    resetState();

    const files = makeScannedFiles(3);
    let eventIdCounter = 0;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            batchBodies.push(parsed);

            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compilationBodies.push(parsed);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_comp_1',
                compilationJobId: VALID_UUID,
                duplicate: false,
                results: (parsed.eventIds as string[]).map((eid) => ({
                  eventId: eid,
                  status: 'queued' as const,
                })),
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID, count);

        if (count < 3) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              requestId: 'req_job_1',
              data: {
                id: VALID_UUID,
                projectId: 'prj_1',
                status: 'processing',
                attempts: 1,
                initiatedBy: {
                  kind: 'credential' as const,
                  credentialId: 'key_cred1',
                  principalId: null,
                },
                eventCount: 3,
                events: [
                  { eventId: 'evt_1', status: 'pending' as const },
                  { eventId: 'evt_2', status: 'pending' as const },
                  { eventId: 'evt_3', status: 'pending' as const },
                ],
                conceptIds: [],
                createdAt: new Date().toISOString(),
              },
            }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              requestId: 'req_job_1',
              data: {
                id: VALID_UUID,
                projectId: 'prj_1',
                status: 'completed',
                attempts: 1,
                initiatedBy: {
                  kind: 'credential' as const,
                  credentialId: 'key_cred1',
                  principalId: null,
                },
                eventCount: 3,
                events: [
                  {
                    eventId: 'evt_1',
                    status: 'compiled' as const,
                    conceptIds: [CONCEPT_UUID_1],
                  },
                  {
                    eventId: 'evt_2',
                    status: 'compiled' as const,
                    conceptIds: [CONCEPT_UUID_2],
                  },
                  {
                    eventId: 'evt_3',
                    status: 'skipped' as const,
                    reason: 'already_compiled' as const,
                  },
                ],
                conceptIds: [CONCEPT_UUID_1, CONCEPT_UUID_2],
                createdAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
              },
            }),
          );
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.eventsIngested).toBe(3);
    expect(result.eventsRejected).toBe(0);
    expect(result.compilationJobIds).toEqual([VALID_UUID]);
    expect(result.jobStatus).toBe('completed');
    expect(result.pagesCreated).toBe(2);
    expect(result.compilationDuplicate).toBe(false);

    // Verify batch request had compile=false.
    expect(batchBodies.length).toBe(1);
    const batchBody = batchBodies[0] as Record<string, unknown>;
    expect((batchBody.options as Record<string, unknown>).compile).toBe(false);

    // Verify compilation request shape.
    expect(compilationBodies.length).toBe(1);
    const compBody = compilationBodies[0] as Record<string, unknown>;
    expect(compBody.projectId).toBe('prj_1');
    expect(compBody.idempotencyKey).toBeTruthy();
    expect((compBody.eventIds as string[]).length).toBe(3);

    // Token was sent in Authorization header.
    expect(receivedTokens.length).toBeGreaterThan(0);
    expect(receivedTokens.every((t) => t === 'Bearer tm_test_token_123')).toBe(true);
  });

  // --- Batch splitting ---

  it('splits events into batches of ≤500 and also batches compilations', async () => {
    resetState();

    const files = makeScannedFiles(BATCH_MAX_SIZE + 100);
    let eventIdCounter = 0;
    const batchCounts: number[] = [];

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            const events = parsed.events as Array<Record<string, unknown>>;
            batchCounts.push(events.length);

            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: `req_batch_${batchCounts.length}`,
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compilationBodies.push(parsed);
            const jobId =
              compilationBodies.length === 1 ? VALID_UUID_2 : VALID_UUID_3;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: `req_comp_${compilationBodies.length}`,
                compilationJobId: jobId,
                duplicate: false,
                results: (parsed.eventIds as string[]).map((eid) => ({
                  eventId: eid,
                  status: 'queued' as const,
                })),
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url?.startsWith('/v1/jobs/')
      ) {
        const jobId = req.url.slice('/v1/jobs/'.length);
        const count = (jobPollCounts.get(jobId) ?? 0) + 1;
        jobPollCounts.set(jobId, count);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_x',
            data: {
              id: jobId,
              projectId: 'prj_1',
              status: 'completed',
              attempts: 1,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 1,
              events: [],
              conceptIds: [CONCEPT_UUID_1],
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(batchCounts.length).toBe(2);
    expect(batchCounts[0]).toBeLessThanOrEqual(BATCH_MAX_SIZE);
    expect(batchCounts[1]).toBeLessThanOrEqual(BATCH_MAX_SIZE);
    expect(compilationBodies.length).toBe(2);
    expect(result.compilationJobIds.length).toBe(2);
    expect(result.eventsIngested).toBe(BATCH_MAX_SIZE + 100);
    expect(result.jobStatus).toBe('completed');
  });

  // --- Compile=false: null batchJobId ---

  it('passes compile=false and batch response has null batchJobId', async () => {
    resetState();

    const files = makeScannedFiles(2);
    let eventIdCounter = 0;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            batchBodies.push(parsed);
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compilationBodies.push(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_comp_1',
                compilationJobId: VALID_UUID_4,
                duplicate: false,
                results: [],
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID_4}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID_4) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID_4, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_3',
            data: {
              id: VALID_UUID_4,
              projectId: 'prj_1',
              status: 'completed',
              attempts: 1,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 2,
              events: [],
              conceptIds: [],
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.eventsIngested).toBe(2);
    expect(batchBodies.length).toBe(1);
  });

  // --- Compilation idempotency key ---

  it('uses a deterministic idempotency key for compilation', async () => {
    resetState();

    const files = makeScannedFiles(2);
    let eventIdCounter = 0;
    const seenCompKeys: string[] = [];

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compilationBodies.push(parsed);
            seenCompKeys.push(parsed.idempotencyKey as string);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_comp_1',
                compilationJobId: VALID_UUID_4,
                duplicate: false,
                results: [],
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID_4}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID_4) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID_4, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_4',
            data: {
              id: VALID_UUID_4,
              projectId: 'prj_1',
              status: 'completed',
              attempts: 1,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 2,
              events: [],
              conceptIds: [],
              createdAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    // First push.
    await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(seenCompKeys.length).toBe(1);
    const expectedKey = compilationIdempotencyKey('prj_1', ['evt_1', 'evt_2']);
    expect(seenCompKeys[0]).toBe(expectedKey);

    // Second push with same input.
    eventIdCounter = 0;
    compilationBodies = [];
    await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(seenCompKeys.length).toBe(2);
    expect(seenCompKeys[0]).toBe(seenCompKeys[1]);
  });

  // --- Compilation retry: duplicate ---

  it('compilation retry with same idempotency key returns duplicate', async () => {
    resetState();

    const files = makeScannedFiles(2);
    let eventIdCounter = 0;
    let compCallCount = 0;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compCallCount++;
            compilationBodies.push(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: `req_comp_${compCallCount}`,
                compilationJobId: VALID_UUID_5,
                duplicate: compCallCount > 1,
                results: (parsed.eventIds as string[]).map((eid) => ({
                  eventId: eid,
                  status: 'already_active' as const,
                })),
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID_5}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID_5) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID_5, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_5',
            data: {
              id: VALID_UUID_5,
              projectId: 'prj_1',
              status: 'completed',
              attempts: 1,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 2,
              events: [],
              conceptIds: [],
              createdAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    // First push — not duplicate.
    const result1 = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });
    expect(result1.compilationDuplicate).toBe(false);
    expect(result1.compilationJobIds).toEqual([VALID_UUID_5]);

    // Second push — duplicate.
    eventIdCounter = 0;
    const result2 = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });
    expect(result2.compilationDuplicate).toBe(true);
    expect(result2.compilationJobIds).toEqual([VALID_UUID_5]);
  });

  // --- Token safety ---

  it('does not include the token in error messages on HTTP failure', async () => {
    resetState();

    serverHandler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          requestId: 'req_err',
          error: {
            code: 'unauthorized',
            message: 'Invalid token: tm_test_secret_key',
          },
        }),
      );
    };

    const files = makeScannedFiles(1);
    try {
      await pushEvents(files, {
        url: serverUrl,
        token: 'tm_test_secret_key',
        pollIntervalMs: TEST_POLL_MS,
        projectId: 'prj_1',
      });
      expect.fail('Expected push to throw');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('tm_test_secret_key');
      expect(message).toContain('HTTP 401');
    }
  });

  it('does not include the token in error messages on network failure', async () => {
    resetState();

    const files = makeScannedFiles(1);
    try {
      await pushEvents(files, {
        url: 'http://127.0.0.1:1',
        token: 'tm_test_secret_key_abc',
        pollIntervalMs: TEST_POLL_MS,
        projectId: 'prj_1',
      });
      expect.fail('Expected push to throw');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('tm_test_secret_key_abc');
      expect(message).toContain('Network error');
    }
  });

  // --- Job status: failed ---

  it('handles job failure and reports status', async () => {
    resetState();

    const files = makeScannedFiles(1);
    let eventIdCounter = 0;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'accepted' as const,
              eventId: `evt_${++eventIdCounter}`,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_comp_1',
                compilationJobId: VALID_UUID_6,
                duplicate: false,
                results: [],
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID_6}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID_6) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID_6, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_6',
            data: {
              id: VALID_UUID_6,
              projectId: 'prj_1',
              status: 'failed',
              attempts: 3,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 1,
              events: [
                {
                  eventId: 'evt_1',
                  status: 'failed' as const,
                  error: { code: 'compile_error', message: 'LLM timeout' },
                },
              ],
              error: { code: 'compile_error', message: 'LLM timeout' },
              conceptIds: [],
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.jobStatus).toBe('failed');
    expect(result.pagesCreated).toBe(0);
    expect(result.eventsIngested).toBe(1);
  });

  // --- Empty files ---

  it('returns zero results for empty file list without making requests', async () => {
    resetState();

    let requestMade = false;
    serverHandler = () => {
      requestMade = true;
    };

    const result = await pushEvents([], {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.eventsIngested).toBe(0);
    expect(result.compilationJobIds).toEqual([]);
    expect(requestMade).toBe(false);
  });

  // --- Partial rejection ---

  it('counts rejected events separately', async () => {
    resetState();

    const files = makeScannedFiles(3);
    let eventIdCounter = 0;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            batchBodies.push(parsed);
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => {
              if (idx === 1) {
                return {
                  index: idx,
                  status: 'rejected' as const,
                  error: { code: 'invalid', message: 'Bad payload' },
                };
              }
              return {
                index: idx,
                status: 'accepted' as const,
                eventId: `evt_${++eventIdCounter}`,
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compilationBodies.push(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_comp_1',
                compilationJobId: VALID_UUID_7,
                duplicate: false,
                results: (parsed.eventIds as string[]).map((eid) => ({
                  eventId: eid,
                  status: 'queued' as const,
                })),
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else if (
        req.method === 'GET' &&
        req.url === `/v1/jobs/${VALID_UUID_7}`
      ) {
        const count = (jobPollCounts.get(VALID_UUID_7) ?? 0) + 1;
        jobPollCounts.set(VALID_UUID_7, count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'req_job_7',
            data: {
              id: VALID_UUID_7,
              projectId: 'prj_1',
              status: 'completed',
              attempts: 1,
              initiatedBy: {
                kind: 'credential' as const,
                credentialId: 'key_cred1',
                principalId: null,
              },
              eventCount: 2,
              events: [],
              conceptIds: [],
              createdAt: new Date().toISOString(),
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.eventsIngested).toBe(2);
    expect(result.eventsRejected).toBe(1);
  });

  // --- Server error ---

  it('throws on non-OK batch response', async () => {
    resetState();

    serverHandler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          requestId: 'req_err',
          error: { code: 'internal', message: 'Database connection lost' },
        }),
      );
    };

    const files = makeScannedFiles(1);
    try {
      await pushEvents(files, {
        url: serverUrl,
        token: 'tm_test_token_123',
        pollIntervalMs: TEST_POLL_MS,
        projectId: 'prj_1',
      });
      expect.fail('Expected push to throw');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('HTTP 500');
      expect(message).toContain('Database connection lost');
    }
  });

  // --- All rejected → no compilation ---

  it('skips compilation when all events are rejected', async () => {
    resetState();

    const files = makeScannedFiles(2);
    let compRequested = false;

    serverHandler = (req, res) => {
      if (req.method === 'POST') {
        withJsonBody(req, res, (parsed) => {
          if (req.url === '/v1/events/batch') {
            const events = parsed.events as Array<Record<string, unknown>>;
            const results = events.map((_e, idx) => ({
              index: idx,
              status: 'rejected' as const,
              error: { code: 'invalid', message: 'Bad payload' },
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                requestId: 'req_batch_1',
                batchJobId: null,
                duplicate: false,
                results,
              }),
            );
          } else if (req.url === '/v1/compilations') {
            compRequested = true;
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await pushEvents(files, {
      url: serverUrl,
      token: 'tm_test_token_123',
      pollIntervalMs: TEST_POLL_MS,
      projectId: 'prj_1',
    });

    expect(result.eventsIngested).toBe(0);
    expect(result.eventsRejected).toBe(2);
    expect(result.compilationJobIds).toEqual([]);
    expect(compRequested).toBe(false);
  });
});
