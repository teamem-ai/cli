#!/usr/bin/env node
import { CONTRACT_STATUS } from '@teamem/schema';

export function showHelp(): string {
  return `teamem — bring team knowledge to your AI coding agent
  schema contract: ${CONTRACT_STATUS}

Usage:
  teamem <command> [options]

Commands:
  init        Initialize teamem in the current directory (placeholder)
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
    return { output: 'init: not yet implemented (M1-CLI-02)', exitCode: 0 };
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
