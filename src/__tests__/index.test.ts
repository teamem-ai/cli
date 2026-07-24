import { describe, expect, it } from 'vitest';
import { run, showHelp, showVersion, parseInitArgs } from '../index.js';

describe('showHelp', () => {
  it('lists the available command skeleton', () => {
    const output = showHelp();
    expect(output).toContain('teamem');
    expect(output).toContain('Usage:');
    expect(output).toContain('init');
  });
});

describe('showVersion', () => {
  it('returns the current version', () => {
    expect(showVersion()).toBe('0.0.0');
  });
});

describe('parseInitArgs', () => {
  it('parses --url, --token, --project with space syntax', () => {
    const { flags, rest } = parseInitArgs(['--url', 'https://example.com', '--token', 'tm_test', '--project', 'prj_test']);
    expect(flags.url).toBe('https://example.com');
    expect(flags.token).toBe('tm_test');
    expect(flags.project).toBe('prj_test');
    expect(rest).toEqual([]);
  });

  it('parses --url, --token, --project with equals syntax', () => {
    const { flags, rest } = parseInitArgs(['--url=https://example.com', '--token=tm_test', '--project=prj_test']);
    expect(flags.url).toBe('https://example.com');
    expect(flags.token).toBe('tm_test');
    expect(flags.project).toBe('prj_test');
    expect(rest).toEqual([]);
  });

  it('parses mixed syntax', () => {
    const { flags, rest } = parseInitArgs(['--url=https://example.com', '--token', 'tm_test', '--project=prj_test']);
    expect(flags.url).toBe('https://example.com');
    expect(flags.token).toBe('tm_test');
    expect(flags.project).toBe('prj_test');
    expect(rest).toEqual([]);
  });

  it('leaves unknown args in rest', () => {
    const { flags, rest } = parseInitArgs(['extra-arg', '--url', 'https://example.com']);
    expect(flags.url).toBe('https://example.com');
    expect(rest).toEqual(['extra-arg']);
  });

  it('returns empty flags when no init args', () => {
    const { flags, rest } = parseInitArgs([]);
    expect(flags.url).toBeUndefined();
    expect(flags.token).toBeUndefined();
    expect(flags.project).toBeUndefined();
    expect(rest).toEqual([]);
  });
});

describe('run', () => {
  it('shows help when no args', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with --help', async () => {
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with -h', async () => {
    const result = await run(['-h']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with help command', async () => {
    const result = await run(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows version with --version', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0');
  });

  it('shows version with -v', async () => {
    const result = await run(['-v']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0');
  });

  it('handles init command and scans the current repo', async () => {
    const result = await run(['init']);
    expect(result.exitCode).toBe(0);
    // The actual working directory is a git repo, so init should scan it.
    expect(result.output).toContain('Repository:');
    expect(result.output).toContain('Commit:');
    expect(result.output).toContain('Scanned files:');
  });

  it('returns error for unknown command', async () => {
    const result = await run(['unknown-cmd']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown command');
    expect(result.output).toContain('--help');
  });

  it('returns error for garbage input', async () => {
    const result = await run(['!@#$%']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown command');
  });

  it('init does not trigger unknown-command path', async () => {
    const result = await run(['init']);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Unknown command');
    expect(result.output).toContain('Repository:');
  });

  it('rejects partial push flags', async () => {
    const result = await run(['init', '--url', 'https://example.com']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Missing required flags');
  });

  it('rejects unexpected positional args after init', async () => {
    const result = await run(['init', 'something-extra']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unexpected arguments');
  });
});
