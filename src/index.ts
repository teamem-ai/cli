#!/usr/bin/env node

import { scanRepository } from './commands/init/scan.js';

export function showHelp(): string {
  return `teamem — bring team knowledge to your AI coding agent

Usage:
  teamem <command> [options]

Commands:
  init        Scan current repository and generate cli_init events
  help        Show this help

Options:
  --help, -h  Show this help
  --version   Show version
`;
}

export function showVersion(): string {
  return '0.0.0';
}

export function run(args: string[]): { output: string; exitCode: number } {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { output: showHelp(), exitCode: 0 };
  }

  if (args[0] === '--version' || args[0] === '-v') {
    return { output: showVersion(), exitCode: 0 };
  }

  if (args[0] === 'init') {
    try {
      const cwd = process.cwd();
      const result = scanRepository(cwd);
      const lines: string[] = [
        `Repository: ${result.repo}`,
        `Commit:     ${result.commitSha}`,
        `Scanned at: ${result.scannedAt}`,
        `Files:      ${result.files.length}`,
      ];
      if (result.files.length > 0) {
        lines.push('');
        lines.push('Scanned files:');
        for (const f of result.files) {
          const truncatedFlag = f.truncated ? ' [truncated]' : '';
          lines.push(`  ${f.path}${truncatedFlag}`);
        }
      }
      return { output: lines.join('\n'), exitCode: 0 };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `init failed: ${message}`, exitCode: 1 };
    }
  }

  return {
    output: `Unknown command: ${args[0]}\nRun "teamem --help" for usage.`,
    exitCode: 1,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = run(args);

  if (result.exitCode !== 0) {
    console.error(result.output);
  } else {
    console.log(result.output);
  }
  process.exitCode = result.exitCode;
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
