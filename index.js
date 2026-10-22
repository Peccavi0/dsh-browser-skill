/**
 * Host half of the browser-skill bundle.
 *
 * Converts the `browser-skill` skill into a model-facing tool by exposing the
 * `bsk` CLI as one bounded command runner. The skill's own constraints (a fixed
 * command inventory, the session lifecycle, and the Agent Window boundary) are
 * encoded here so the model cannot drift outside them.
 *
 * The bundle deliberately imports nothing but Node builtins: a workspace bundle
 * is installed as a link, so `@deepseek-ai/*` packages are not resolvable from
 * the checkout. Parameter and output schemas are therefore written directly in
 * the Harness's enforced JSON Schema subset.
 *
 * @module dsh-browser-skill
 */

import { spawn } from 'node:child_process';

/** Plugin row name used for diagnostics. */
export const name = 'browser-skill';

/** The tool registry must exist before this plugin activates. */
export const inject = ['tools'];

/**
 * Every command `bsk` documents. Multi-word entries stay one string here and are
 * split into argv tokens at call time; the model never invents a command.
 */
const COMMANDS = [
  'session start',
  'session stop',
  'session list',
  'browsers',
  'status',
  'doctor',
  'update',
  'logs',
  'navigate',
  'navigate-back',
  'navigate-forward',
  'reload',
  'wait-for-navigation',
  'wait-ms',
  'observe',
  'snapshot',
  'get-html',
  'screenshot',
  'console',
  'network',
  'click',
  'hover',
  'fill',
  'select',
  'press',
  'evaluate',
  'tab list',
  'tab create',
  'tab close',
  'tab select',
  'tab borrow',
  'tab return',
  'window resize',
  'emulate',
  'upload',
  'download',
  'request-help',
  'record start',
  'record stop',
];

/**
 * Commands that take the session id as a positional argument instead of a
 * `--session` flag.
 */
const POSITIONAL_SESSION_COMMANDS = new Set(['session stop']);

/**
 * Commands that accept no session at all; a stray `--session` would make the
 * CLI reject the whole invocation.
 */
const SESSIONLESS_COMMANDS = new Set([
  'session start',
  'session list',
  'browsers',
  'status',
  'doctor',
  'update',
  'logs',
]);

/** Captured bytes per stream before truncation. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Internal deadline; the registry deadline sits above it. */
const RUN_TIMEOUT_MS = 180000;

/** Model-facing parameter schema, written directly in the enforced subset. */
const PARAMETERS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: [...COMMANDS],
      description: 'The bsk command to run, exactly as documented.',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Extra argv tokens after the command, one per flag or positional value, e.g. ["#q", "--value", "hello"] or ["--out", "C:/tmp/shot.png"].',
    },
    session: {
      type: 'string',
      description:
        'Session id printed by `session start`; appended as --session <id>. Omit only for commands that are not session-scoped.',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

/** Model-facing output schema, written directly in the enforced subset. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
  required: ['command', 'exitCode', 'stdout', 'stderr'],
  additionalProperties: false,
};

/** Render one settled run for the model. */
function render(args, value) {
  const head =
    value.exitCode === 0
      ? `bsk ${value.command} exited 0.`
      : `bsk ${value.command} exited ${value.exitCode}.`;
  const parts = [head];
  if (value.stdout.length > 0) parts.push(value.stdout);
  if (value.stderr.length > 0) parts.push(`[stderr]\n${value.stderr}`);
  return [{ type: 'text', text: parts.join('\n') }];
}

/**
 * Read every byte a collect-mode reader holds without consuming it.
 * @param reader - collected stream reader, or undefined when stdio was not collected.
 * @returns the captured text, or an empty string.
 */
function readAll(reader) {
  if (reader === undefined) return '';
  try {
    return reader.readFrom(0).text;
  } catch {
    return '';
  }
}

/**
 * Run one argv through the mounted subprocess service.
 * @param subprocess - the mounted service.
 * @param argv - executable plus arguments.
 * @param cwd - working directory for the child.
 * @param signal - fused cancellation.
 * @returns exit facts plus captured streams.
 */
async function runViaService(subprocess, argv, cwd, signal) {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_OUTPUT_BYTES },
    },
    graceMs: 2000,
    signal,
  });
  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    return {
      exitCode: -1,
      stdout: readAll(handle.collected.stdout),
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : -1,
    stdout: readAll(handle.collected.stdout),
    stderr: readAll(handle.collected.stderr),
  };
}

/**
 * Fallback runner for profiles without the subprocess service.
 * @param argv - executable plus arguments.
 * @param cwd - working directory for the child.
 * @param signal - fused cancellation.
 * @returns exit facts plus captured streams.
 */
function runViaChildProcess(argv, cwd, signal) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const append = (target, chunk) =>
      target.length >= MAX_OUTPUT_BYTES ? target : (target + chunk).slice(0, MAX_OUTPUT_BYTES);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const onAbort = () => child.kill();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: -1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

/**
 * Register the `bsk` tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional deployment config; `binaryPath` chooses the CLI.
 */
export function apply(ctx, config = {}) {
  const configured = typeof config?.binaryPath === 'string' ? config.binaryPath.trim() : '';
  const binary = configured.length > 0 ? configured : 'bsk';
  const defaultDirectory =
    (typeof config?.cwd === 'string' && config.cwd.trim()) ||
    ctx.get('workingDirectory')?.defaultDirectory ||
    process.cwd();

  ctx.tools.register({
    name: 'bsk',
    description:
      "Run one `bsk` (browser-skill) command against the user's real Chromium browser. " +
      'Start a bounded session with `session start`, keep the printed 4-letter id, pass it as `session` on every session-scoped call, and always run `session stop` on both success and error paths. ' +
      'Work observe-act-observe: `observe` after a navigation or a meaningful DOM change, and act on fresh @eN refs instead of CSS selectors. ' +
      'Only the commands in the `command` enum exist; never invent one. ' +
      'Normal page writes affect only the Agent Window — list user tabs with `tab list --scope user` and `tab borrow` before touching one. ' +
      'Use `request-help` for login, captcha, OTP, payment or consent steps instead of brute-forcing.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render,
    },
    timeoutMs: 240000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `bsk ${args.command}`,
      kind: 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      const command = typeof args?.command === 'string' ? args.command : '';
      if (!COMMANDS.includes(command)) {
        throw new Error(`unknown bsk command: ${JSON.stringify(command)}`);
      }
      const extra = Array.isArray(args?.args)
        ? args.args.filter((token) => typeof token === 'string')
        : [];
      const session = typeof args?.session === 'string' ? args.session.trim() : '';

      const subprocess = ctx.get('subprocess');
      const resolved = subprocess === undefined ? binary : await subprocess.resolveExecutable(binary);
      const commandTokens = command.split(/\s+/u).filter((token) => token.length > 0);

      // `bsk session stop <id>` takes the id positionally and `--all` replaces it;
      // the session-lifecycle/global commands take no session flag at all.
      const wantsSession =
        session.length > 0 &&
        !SESSIONLESS_COMMANDS.has(command) &&
        !(command === 'session stop' && extra.includes('--all'));
      const placement = POSITIONAL_SESSION_COMMANDS.has(command)
        ? [session]
        : session.length > 0
          ? ['--session', session]
          : [];

      const argv = [
        resolved,
        ...commandTokens,
        ...(wantsSession ? placement : []),
        ...extra,
      ];

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(exec.signal.reason);
      if (exec.signal.aborted) abortFromCaller();
      else exec.signal.addEventListener('abort', abortFromCaller, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('bsk timed out')), RUN_TIMEOUT_MS);

      try {
        const result =
          subprocess === undefined
            ? await runViaChildProcess(argv, defaultDirectory, controller.signal)
            : await runViaService(subprocess, argv, defaultDirectory, controller.signal);
        return {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } finally {
        clearTimeout(timer);
        exec.signal.removeEventListener('abort', abortFromCaller);
      }
    },
  });
}
