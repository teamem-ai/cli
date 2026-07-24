#!/usr/bin/env node

import { scanRepository } from './commands/init/scan.js';
import { pushEvents } from './commands/init/push.js';

export function showHelp(): string {
  return `teamem — bring team knowledge to your AI coding agent

Usage:
  teamem <command> [options]

Commands:
  init        Scan current repository and push knowledge to teamem portal
  help        Show this help

Options:
  --help, -h  Show this help
  --version   Show version

Init options:
  --url       Portal base URL (e.g. https://api.teamem.ai)
  --token     API token (tm_...)
  --project   Project ID (prj_...)
`;
}

export function showVersion(): string {
  return '0.0.0';
}

export interface InitArgs {
  url?: string;
  token?: string;
  project?: string;
}

/**
 * Parse init-specific flags from the argument list. Returns the parsed flags
 * and the remaining positional args.
 */
export function parseInitArgs(args: string[]): { flags: InitArgs; rest: string[] } {
  const flags: InitArgs = {};
  const rest: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--url' && i + 1 < args.length) {
      flags.url = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--url=')) {
      flags.url = arg.slice('--url='.length);
      i += 1;
    } else if (arg === '--token' && i + 1 < args.length) {
      flags.token = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--token=')) {
      flags.token = arg.slice('--token='.length);
      i += 1;
    } else if (arg === '--project' && i + 1 < args.length) {
      flags.project = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--project=')) {
      flags.project = arg.slice('--project='.length);
      i += 1;
    } else {
      rest.push(arg);
      i += 1;
    }
  }

  return { flags, rest };
}

export async function run(args: string[]): Promise<{ output: string; exitCode: number }> {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { output: showHelp(), exitCode: 0 };
  }

  if (args[0] === '--version' || args[0] === '-v') {
    return { output: showVersion(), exitCode: 0 };
  }

  if (args[0] === 'init') {
    const { flags, rest } = parseInitArgs(args.slice(1));

    // Validate that no unrecognized positional args remain.
    if (rest.length > 0) {
      return {
        output: `Unexpected arguments: ${rest.join(' ')}\nRun "teamem init --help" for usage.`,
        exitCode: 1,
      };
    }

    // If we have --url, --token, and --project, do the full push flow.
    if (flags.url && flags.token && flags.project) {
      try {
        const cwd = process.cwd();
        const scanResult = scanRepository(cwd);

        if (scanResult.files.length === 0) {
          return {
            output: 'No scannable files found in the repository.',
            exitCode: 0,
          };
        }

        const pushResult = await pushEvents(scanResult.files, {
          url: flags.url,
          token: flags.token,
          projectId: flags.project,
        });

        const lines: string[] = [
          `Repository:   ${scanResult.repo}`,
          `Commit:       ${scanResult.commitSha}`,
          `Files:        ${scanResult.files.length}`,
          `Ingested:     ${pushResult.eventsIngested}`,
          `Rejected:     ${pushResult.eventsRejected}`,
        ];

        if (pushResult.compilationJobIds.length > 0) {
          lines.push(`Jobs:         ${pushResult.compilationJobIds.join(', ')}`);
          lines.push(`Job status:   ${pushResult.jobStatus}`);
          lines.push(`Pages:        ${pushResult.pagesCreated}`);
        }

        if (pushResult.compilationDuplicate) {
          lines.push('(compilation was a duplicate — same results as previous run)');
        }

        return { output: lines.join('\n'), exitCode: 0 };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: `init failed: ${message}`, exitCode: 1 };
      }
    }

    // If some but not all flags are provided, error out.
    if (flags.url || flags.token || flags.project) {
      const missing: string[] = [];
      if (!flags.url) missing.push('--url');
      if (!flags.token) missing.push('--token');
      if (!flags.project) missing.push('--project');
      return {
        output: `Missing required flags for push: ${missing.join(', ')}\nAll three (--url, --token, --project) must be provided to push to the portal.`,
        exitCode: 1,
      };
    }

    // Plain scan (no push flags).
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
  const result = await run(args);

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
