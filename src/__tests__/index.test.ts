import { describe, expect, it } from 'vitest';
import { run, showHelp, showVersion } from '../index.js';

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

describe('run', () => {
  it('shows help when no args', () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with --help', () => {
    const result = run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with -h', () => {
    const result = run(['-h']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows help with help command', () => {
    const result = run(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
  });

  it('shows version with --version', () => {
    const result = run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0');
  });

  it('shows version with -v', () => {
    const result = run(['-v']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0');
  });

  it('handles init command (placeholder)', () => {
    const result = run(['init']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('not yet implemented');
  });

  it('returns error for unknown command', () => {
    const result = run(['unknown-cmd']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown command');
    expect(result.output).toContain('--help');
  });

  it('returns error for garbage input', () => {
    const result = run(['!@#$%']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown command');
  });

  it('init does not trigger unknown-command path', () => {
    const result = run(['init']);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Unknown command');
  });
});
