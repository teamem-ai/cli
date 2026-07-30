import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstallHookOptions {
  /** Portal base URL (e.g. https://api.teamem.ai). */
  url: string;
  /** API token (tm_...). Must not be logged or included in errors. */
  token: string;
  /** Target project ID (prj_...). */
  project: string;
  /** Override default hooks file path (for testing). */
  hooksPath?: string;
}

export interface InstallHookResult {
  /** Whether a new hook entry was written. */
  installed: boolean;
  /** Whether a hook with the same URL + project already existed. */
  alreadyExists: boolean;
  /** Absolute path to the hooks settings file. */
  hooksPath: string;
  /** Human-readable message for stdout. */
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to Claude Code user settings. */
function defaultHooksPath(): string {
  return (
    process.env.TEAMEM_HOOKS_PATH ??
    join(homedir(), '.claude', 'settings.json')
  );
}

/** Marker comment embedded in the hook command to identify our entries. */
export const TEAMEM_MARKER = 'teamem-install-hook';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the shell command that the hook runs at SessionStart.
 *
 * The token IS embedded in the returned command (it must be, so the hook can
 * authenticate at runtime). Callers MUST NOT log this value or include it in
 * error messages.
 */
export function buildHookCommand(
  url: string,
  token: string,
  project: string,
): string {
  const baseUrl = url.replace(/\/$/, '');

  // Use python3 for robust JSON processing (available on macOS and most
  // Linux distributions). Fall back to a plain text message when it fails.
  const pythonScript =
    "import sys,json\n" +
    "try:\n" +
    " d=json.load(sys.stdin)\n" +
    " ctx=d.get('data',d)\n" +
    " print(json.dumps({'hookSpecificOutput':{'additionalContext':json.dumps(ctx,indent=2,ensure_ascii=False)}}))\n" +
    "except Exception as e:\n" +
    " print(json.dumps({'hookSpecificOutput':{'additionalContext':'Team knowledge unavailable: '+str(e)}}))";

  const encoded = Buffer.from(pythonScript).toString('base64');

  // Single-quote the token for safe shell interpolation. The `'\\''` idiom
  // closes the single-quoted string, appends a literal single-quote, and
  // re-opens the single-quoted string.
  const safeToken = token.replace(/'/g, "'\\''");

  return [
    `curl -s -H 'Authorization: Bearer ${safeToken}'`,
    `'${baseUrl}/v1/context?projectId=${project}'`,
    `2>/dev/null`,
    `| python3 -c "exec(__import__('base64').b64decode('${encoded}').decode())"`,
    `2>/dev/null`,
    `|| echo '{"hookSpecificOutput":{"additionalContext":"Team knowledge unavailable"}}'`,
    `# ${TEAMEM_MARKER}:${baseUrl}:${project}`,
  ].join(' ');
}

/**
 * Check whether a hook entry matches our teamem SessionStart pattern.
 * Returns true when the command contains our marker with matching URL+project.
 */
function isTeamemHook(command: string, url: string, project: string): boolean {
  const baseUrl = url.replace(/\/$/, '');
  const expectedMarker = `# ${TEAMEM_MARKER}:${baseUrl}:${project}`;
  return command.includes(expectedMarker);
}

/**
 * Check whether any hook command in a list is a teamem hook for the given
 * URL+project.
 */
function findTeamemHookIndex(
  commands: string[],
  url: string,
  project: string,
): number {
  return commands.findIndex((cmd) => isTeamemHook(cmd, url, project));
}

// ---------------------------------------------------------------------------
// Settings file helpers
// ---------------------------------------------------------------------------

interface ClaudeSettings {
  hooks?: {
    SessionStart?: Array<{
      matcher?: string;
      command: string;
    }>;
  };
  [key: string]: unknown;
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    throw new Error(
      `Failed to parse existing settings file at "${path}". ` +
        'Check that the file contains valid JSON.',
    );
  }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install a read-only SessionStart hook into the Claude Code settings file.
 *
 * The hook calls `GET /v1/context` at the start of every Claude Code session
 * and injects the team knowledge summary via `hookSpecificOutput.additionalContext`.
 *
 * Idempotent: running install-hook again with the same url+project will
 * detect the existing hook and leave it in place. Other hooks (teamem or
 * otherwise) are never modified or removed.
 *
 * The token is NEVER included in return values or error messages.
 */
export function installHook(options: InstallHookOptions): InstallHookResult {
  const { url, token, project } = options;
  const hooksPath = options.hooksPath ?? defaultHooksPath();
  const command = buildHookCommand(url, token, project);

  // Read existing settings.
  const settings = readSettings(hooksPath);

  // Ensure hooks.SessionStart array exists.
  const hooks = (settings.hooks = settings.hooks ?? {});
  const sessionStartHooks = (hooks.SessionStart =
    hooks.SessionStart ?? []);

  // Check for existing matching hook.
  const existingCommands = sessionStartHooks.map((h) => h.command);
  const existingIndex = findTeamemHookIndex(existingCommands, url, project);

  if (existingIndex !== -1) {
    // A matching hook already exists — update its command (token may have
    // changed) but keep the position.
    sessionStartHooks[existingIndex] = {
      matcher: '',
      command,
    };
    writeSettings(hooksPath, settings);

    return {
      installed: false,
      alreadyExists: true,
      hooksPath,
      message: [
        'A teamem SessionStart hook for this project already exists — command updated.',
        `  Hook location: ${hooksPath}`,
        '',
        'To remove the teamem hook, edit the file above and delete the entry with',
        `"${TEAMEM_MARKER}" in its command.`,
        '',
        'To override with a different token/URL, re-run install-hook with the new values.',
      ].join('\n'),
    };
  }

  // Append the new hook entry.
  sessionStartHooks.push({
    matcher: '',
    command,
  });
  writeSettings(hooksPath, settings);

  const otherHookCount = sessionStartHooks.length - 1;
  const otherNote =
    otherHookCount > 0
      ? `\n\n${otherHookCount} other SessionStart hook(s) were preserved — they are unchanged.`
      : '';

  return {
    installed: true,
    alreadyExists: false,
    hooksPath,
    message:
      [
        'SessionStart hook installed successfully.',
        `  Hook location: ${hooksPath}`,
        '',
        'What this does:',
        '  At the start of every Claude Code session, the hook calls',
        `  GET /v1/context and injects the team knowledge summary as`,
        '  additional context — so your agent always sees the latest',
        '  team knowledge without manual search.',
        '',
        'To remove the hook:',
        `  Edit ${hooksPath} and delete the entry whose command contains`,
        `  "${TEAMEM_MARKER}".`,
        '',
        'To override: re-run `teamem cli install-hook` with the new values.',
        '',
        'Note: If your MCP client does not support hooks, use `teamem cli search`',
        '  (or the MCP memory_search tool) to retrieve team knowledge on demand.',
      ].join('\n') + otherNote,
  };
}
