import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installHook,
  buildHookCommand,
} from '../../install-hook.js';
import type { InstallHookOptions } from '../../install-hook.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fresh temporary directory and return path + cleanup fn. */
function tempDir(): { dir: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `teamem-install-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

function hooksPath(dir: string): string {
  return join(dir, 'settings.json');
}

function makeOptions(
  overrides: Partial<InstallHookOptions> = {},
): InstallHookOptions {
  return {
    url: 'https://api.teamem.ai',
    token: 'tm_test_token_abc123',
    project: 'prj_test_001',
    hooksPath: undefined, // set per-test
    ...overrides,
  };
}

/**
 * Read the first (and only) hook command from the nested hooks array
 * within the first SessionStart handler.
 */
function getFirstHookCommand(settingsPath: string): string {
  const raw = readFileSync(settingsPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.hooks.SessionStart[0].hooks[0].command;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildHookCommand', () => {
  it('includes the base URL, token, and projectId in the command', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai',
      'tm_test',
      'prj_123',
    );

    // The server's /v1/context reads the `projectId` query param (camelCase)
    // and requires it — snake_case project_id yields a 400.
    expect(cmd).toContain('https://api.teamem.ai/v1/context?projectId=prj_123');
    expect(cmd).toContain("Authorization: Bearer tm_test");
    expect(cmd).toContain('# teamem-install-hook:https://api.teamem.ai:prj_123');
  });

  it('strips trailing slash from url', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai/',
      'tm_test',
      'prj_123',
    );
    expect(cmd).toContain('https://api.teamem.ai/v1/context');
    expect(cmd).not.toContain('//v1/context');
  });

  it('outputs python script with hookSpecificOutput format', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai',
      'tm_test',
      'prj_123',
    );
    expect(cmd).toContain('hookSpecificOutput');
    expect(cmd).toContain('additionalContext');
    expect(cmd).toContain('python3');
  });

  it('includes hookEventName in every output branch (Claude Code requires it)', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai',
      'tm_test',
      'prj_123',
    );
    // The shell fallback echo carries hookEventName literally.
    expect(cmd).toContain('"hookEventName":"SessionStart"');

    // The two python branches (success + except) are base64-encoded inside the
    // command; decode and confirm each hookSpecificOutput carries hookEventName.
    const m = cmd.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
    const occurrences =
      decoded.split("'hookEventName':'SessionStart'").length - 1;
    expect(occurrences).toBe(2);
  });

  it('escapes single quotes in token', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai',
      "it's_a_token",
      'prj_123',
    );
    // The single quote in the token should be escaped.
    expect(cmd).toContain("it'\\''s_a_token");
  });

  it('includes fallback output on failure', () => {
    const cmd = buildHookCommand(
      'https://api.teamem.ai',
      'tm_test',
      'prj_123',
    );
    expect(cmd).toContain('Team knowledge unavailable');
    expect(cmd).toContain('|| echo');
  });
});

describe('installHook', () => {
  let testDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tempDir();
    testDir = t.dir;
    cleanup = t.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  // --- Success path: first install ---

  it('writes a new SessionStart hook with correct schema to the settings file', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.installed).toBe(true);
    expect(result.alreadyExists).toBe(false);
    expect(result.hooksPath).toBe(hooksPath(testDir));
    expect(result.message).toContain('installed successfully');
    // Token must not appear in the message.
    expect(result.message).not.toContain('tm_test_token_abc123');

    // Verify file contents — correct Claude Code hooks schema.
    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);

    // Top-level hooks key.
    expect(parsed.hooks).toBeDefined();

    // SessionStart event array.
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.SessionStart).toHaveLength(1);

    // Handler object: matcher + hooks array.
    const handler = parsed.hooks.SessionStart[0];
    expect(handler.matcher).toBe('');
    expect(handler.hooks).toBeDefined();
    expect(handler.hooks).toHaveLength(1);

    // Hook definition: type + command.
    const hook = handler.hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('# teamem-install-hook:https://api.teamem.ai:prj_test_001');
    // The token IS in the file (the hook needs it to auth at runtime).
    expect(hook.command).toContain('tm_test_token_abc123');
  });

  it('writes the correct projectId query parameter in the command', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    installHook(opts);

    const cmd = getFirstHookCommand(hooksPath(testDir));
    // Server contract is camelCase `projectId`.
    expect(cmd).toContain('projectId=prj_test_001');
    expect(cmd).not.toContain('project_id=prj_test_001');
  });

  it('creates the parent directory if it does not exist', () => {
    const nestedDir = join(testDir, 'new', 'subdir');
    const opts = makeOptions({ hooksPath: join(nestedDir, 'settings.json') });
    const result = installHook(opts);

    expect(result.installed).toBe(true);
    const raw = readFileSync(join(nestedDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].type).toBe('command');
  });

  // --- Idempotency: repeat install does not duplicate ---

  it('is idempotent — running twice with same url+project does not create duplicate handlers', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });

    const first = installHook(opts);
    expect(first.installed).toBe(true);
    expect(first.alreadyExists).toBe(false);

    const second = installHook(opts);
    expect(second.installed).toBe(false);
    expect(second.alreadyExists).toBe(true);
    expect(second.message).toContain('already exists');

    // File should have exactly one handler, one hook definition.
    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(1);
  });

  it('updates command when token changes (same url+project)', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    installHook(opts);

    const newOpts = makeOptions({
      hooksPath: hooksPath(testDir),
      token: 'tm_new_token_xyz',
    });
    const result = installHook(newOpts);

    expect(result.installed).toBe(false);
    expect(result.alreadyExists).toBe(true);

    // Should have exactly one handler, one hook, with the new token.
    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('tm_new_token_xyz');
  });

  // --- Preserves existing unrelated hooks ---

  it('preserves existing non-teamem SessionStart handlers', () => {
    // Pre-populate settings with an unrelated handler (correct schema).
    const preExisting = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: 'echo "existing custom hook"',
              },
            ],
          },
        ],
      },
    };
    writeFileSync(
      hooksPath(testDir),
      JSON.stringify(preExisting, null, 2) + '\n',
    );

    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.installed).toBe(true);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(2);

    // First handler is the existing one.
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('existing custom hook');
    // Second handler is our teamem hook.
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toContain('# teamem-install-hook');
  });

  it('preserves other top-level settings keys', () => {
    const preExisting = {
      model: 'opus',
      theme: 'dark',
      hooks: {
        SessionStart: [],
      },
    };
    writeFileSync(
      hooksPath(testDir),
      JSON.stringify(preExisting, null, 2) + '\n',
    );

    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    installHook(opts);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.model).toBe('opus');
    expect(parsed.theme).toBe('dark');
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  it('reports count of other handlers preserved', () => {
    const preExisting = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo "hook 1"' },
            ],
          },
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo "hook 2"' },
            ],
          },
        ],
      },
    };
    writeFileSync(
      hooksPath(testDir),
      JSON.stringify(preExisting, null, 2) + '\n',
    );

    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);
    expect(result.installed).toBe(true);
    expect(result.message).toContain('2 other SessionStart hook handler(s) were preserved');
  });

  it('does not report other handler count when there are none', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);
    expect(result.installed).toBe(true);
    expect(result.message).not.toContain('other SessionStart hook handler');
  });

  // --- Multiple teamem hooks for different projects ---

  it('allows separate teamem hooks for different projects', () => {
    const opts1 = makeOptions({
      hooksPath: hooksPath(testDir),
      project: 'prj_alpha',
    });
    const opts2 = makeOptions({
      hooksPath: hooksPath(testDir),
      project: 'prj_beta',
    });

    installHook(opts1);
    installHook(opts2);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(2);

    const commands = parsed.hooks.SessionStart.map(
      (h: { hooks: Array<{ command: string }> }) => h.hooks[0]!.command,
    );
    expect(commands[0]).toContain('projectId=prj_alpha');
    expect(commands[1]).toContain('projectId=prj_beta');
  });

  it('allows separate teamem hooks for different URLs', () => {
    const opts1 = makeOptions({
      hooksPath: hooksPath(testDir),
      url: 'https://api.teamem.ai',
    });
    const opts2 = makeOptions({
      hooksPath: hooksPath(testDir),
      url: 'https://staging.teamem.ai',
    });

    installHook(opts1);
    installHook(opts2);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
  });

  // --- Empty existing file ---

  it('handles a non-existent settings file', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.installed).toBe(true);
    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].type).toBe('command');
  });

  it('handles existing settings without hooks key', () => {
    writeFileSync(
      hooksPath(testDir),
      JSON.stringify({ model: 'sonnet' }, null, 2) + '\n',
    );

    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.installed).toBe(true);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.model).toBe('sonnet');
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  // --- Token safety ---

  it('never includes the token in the result message', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.message).not.toContain('tm_test_token_abc123');
    // The token-holding command text should not appear in messages.
    expect(result.message).not.toContain('Authorization: Bearer');
  });

  it('does not include token in already-exists message', () => {
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    installHook(opts); // first install
    const second = installHook(opts); // already exists

    expect(second.message).not.toContain('tm_test_token_abc123');
  });

  // --- Malformed existing JSON ---

  it('throws on malformed JSON in existing settings', () => {
    writeFileSync(hooksPath(testDir), '{ not valid json }', 'utf8');
    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    expect(() => installHook(opts)).toThrow(/parse/i);
  });

  // --- Existing handler with multiple hooks ---

  it('updates only the matching hook within a handler that has multiple hooks', () => {
    // Pre-populate with a handler that has both a teamem hook (old token)
    // and an unrelated hook.
    const oldCmd = "curl ... # teamem-install-hook:https://api.teamem.ai:prj_test_001";
    const preExisting = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: oldCmd },
              { type: 'command', command: 'echo "another hook in same handler"' },
            ],
          },
        ],
      },
    };
    writeFileSync(
      hooksPath(testDir),
      JSON.stringify(preExisting, null, 2) + '\n',
    );

    const opts = makeOptions({ hooksPath: hooksPath(testDir) });
    const result = installHook(opts);

    expect(result.installed).toBe(false);
    expect(result.alreadyExists).toBe(true);

    const raw = readFileSync(hooksPath(testDir), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(2);

    // First hook should be updated with new token.
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('tm_test_token_abc123');
    // Second hook should be unchanged.
    expect(parsed.hooks.SessionStart[0].hooks[1].command).toBe('echo "another hook in same handler"');
  });
});
