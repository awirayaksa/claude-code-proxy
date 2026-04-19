import * as pty from 'node-pty';
import { IPty } from 'node-pty';
import { PTYSessionState, SessionRequest } from '../types';
import { ScreenBuffer } from '../claude/screen-buffer';

const CLAUDE_PATH = process.env.CLAUDE_PATH ?? 'claude';
const PROMPT_DEBOUNCE_MS = parseInt(process.env.PROMPT_DEBOUNCE_MS ?? '500', 10);
const DEBUG = process.env.DEBUG === 'true';
const PTY_DEBUG = process.env.PTY_DEBUG === 'true';

/** Build the CLI argument list for the claude process from env vars. */
function buildClaudeArgs(): string[] {
  const args: string[] = [];

  if (process.env.CLAUDE_MODEL)
    args.push('--model', process.env.CLAUDE_MODEL);

  if (process.env.CLAUDE_ADD_DIR) {
    for (const dir of process.env.CLAUDE_ADD_DIR.split(',').map(d => d.trim()).filter(Boolean))
      args.push('--add-dir', dir);
  }

  if (process.env.CLAUDE_ALLOWED_TOOLS)
    args.push('--allowedTools', process.env.CLAUDE_ALLOWED_TOOLS);

  if (process.env.CLAUDE_DISALLOWED_TOOLS)
    args.push('--disallowedTools', process.env.CLAUDE_DISALLOWED_TOOLS);

  if (process.env.CLAUDE_SYSTEM_PROMPT)
    args.push('--system-prompt', process.env.CLAUDE_SYSTEM_PROMPT);

  if (process.env.CLAUDE_APPEND_SYSTEM_PROMPT)
    args.push('--append-system-prompt', process.env.CLAUDE_APPEND_SYSTEM_PROMPT);

  if (process.env.CLAUDE_SKIP_PERMISSIONS === 'true')
    args.push('--dangerously-skip-permissions');

  if (process.env.CLAUDE_MAX_TURNS)
    args.push('--max-turns', process.env.CLAUDE_MAX_TURNS);

  // Escape hatch: raw space-separated flags for anything else
  if (process.env.CLAUDE_ARGS)
    args.push(...process.env.CLAUDE_ARGS.split(/\s+/).filter(Boolean));

  return args;
}

const COLS = 220;
const ROWS = 50;

function debug(...args: unknown[]) {
  if (DEBUG) console.log('[PTYSession]', ...args);
}

function ptyDebugScreen(label: string, screen: ScreenBuffer): void {
  console.log(`\n[PTY] ${label}`);
  for (let r = 0; r < ROWS; r++) {
    const row = screen.getRow(r);
    if (row.trim()) console.log(`  row[${String(r).padStart(2)}]: ${JSON.stringify(row.trimEnd())}`);
  }
}

/**
 * Scan all rows from bottom to top for Claude Code's status bar.
 * The bar uses ─ box-drawing chars between words, e.g. "──?─for─shortcuts──".
 * Its vertical position varies: compact welcome = near top; after conversation = near bottom.
 */
function findStatusBar(screen: ScreenBuffer): string {
  // Scan bottom-to-top. The status bar is always the last rendered element,
  // so the first match from the bottom will be the bar, not response content.
  //
  // We match on 'shortcuts' (idle) or 'interrupt' (busy) only — no ─ requirement.
  // The ─ check was added to avoid false positives from content text, but it also
  // rejects valid idle bars where Claude Code renders the bar without ─ next to
  // 'shortcuts' (observed after long responses during the final re-render pass).
  //
  // Scanning bottom-up provides the false-positive protection instead: the status
  // bar always sits below any response content, so it's found first.
  for (let r = ROWS - 1; r >= 0; r--) {
    const row = screen.getRow(r);
    if (row.includes('shortcuts') || row.includes('interrupt')) {
      return row;
    }
  }
  return '';
}

/**
 * Idle: status bar contains "shortcuts" → Claude is waiting for input.
 * The bar renders as "──?─for─shortcuts──" so we match the substring.
 */
function isIdleStatusBar(text: string): boolean {
  return text.includes('shortcuts');
}

/**
 * Busy: status bar contains "interrupt" → Claude is generating a response.
 * The bar renders as "──esc─to─interrupt──" so we match the substring.
 */
function isBusyStatusBar(text: string): boolean {
  return text.includes('interrupt');
}

/** Return true when Claude is showing the trust/safety dialog. */
function isTrustDialog(screenText: string): boolean {
  return (
    screenText.includes('Yes, I trust this folder') ||
    screenText.includes('Enter to confirm') ||
    screenText.includes('trust this folder')
  );
}

export class PTYSession {
  readonly id: string;
  private ptyProc: IPty;
  private _state: PTYSessionState = 'starting';
  lastUsed = Date.now();

  private screen = new ScreenBuffer(COLS, ROWS);

  // Startup
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private trustConfirmed = false;

  // Active request
  private currentRequest: SessionRequest | null = null;
  private promptDebounce: NodeJS.Timeout | null = null;
  private hardTimeout: NodeJS.Timeout | null = null;
  private responseStarted = false;
  private lastContentSnapshot: string[][] = [];

  // Queue for concurrent requests on the same session
  private queue: SessionRequest[] = [];

  // PTY debug chunk counter
  private _chunkIndex = 0;

  constructor(id: string) {
    this.id = id;
    const claudeArgs = buildClaudeArgs();
    debug(`Spawning claude${claudeArgs.length ? ' ' + claudeArgs.join(' ') : ''}`);
    this.ptyProc = pty.spawn(CLAUDE_PATH, claudeArgs, {
      name: 'xterm-color',
      cols: COLS,
      rows: ROWS,
      cwd: process.env.CLAUDE_CWD ?? process.cwd(),
      env: process.env as Record<string, string>,
    });

    this.ptyProc.onData((data) => this._handleData(data));
    this.ptyProc.onExit(({ exitCode }) => this._handleExit(exitCode));
  }

  get state(): PTYSessionState {
    return this._state;
  }

  /**
   * Wait until Claude Code has started and shown its ready prompt.
   * Resolves when the status bar shows "? for shortcuts".
   * Times out after 45 seconds.
   */
  waitForReady(): Promise<void> {
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'dead') return Promise.reject(new Error('PTY session is dead'));

    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      this.startupTimer = setTimeout(() => {
        reject(new Error('Claude Code did not show ready prompt within 45 seconds'));
        this._state = 'dead';
      }, 45_000);
    });
  }

  /** Send a prompt and stream the response back via callbacks. */
  sendMessage(req: SessionRequest): void {
    if (this._state === 'dead') {
      req.onError(new Error('PTY session is dead'));
      return;
    }
    if (this._state === 'busy') {
      this.queue.push(req);
      return;
    }
    this._startRequest(req);
  }

  private _startRequest(req: SessionRequest): void {
    this._state = 'busy';
    this.currentRequest = req;
    this.responseStarted = false;
    this.lastUsed = Date.now();

    // Take a before-snapshot to diff against
    this.lastContentSnapshot = this.screen.snapshot();

    // Hard timeout watchdog
    this.hardTimeout = setTimeout(() => {
      const r = this.currentRequest;
      this._resetState();
      r?.onError(new Error('Response timeout'));
    }, req.timeoutMs);

    // Newlines inside the prompt text would trigger premature submission in the PTY
    // (each \n acts like Enter in Claude Code's TUI). Collapse them to spaces.
    const ptyInput = req.prompt.replace(/\n+/g, ' ').trim();
    debug(`Sending: ${ptyInput.slice(0, 80)}`);
    if (PTY_DEBUG) console.log(`[PTY] Writing prompt (${ptyInput.length} chars): ${ptyInput.slice(0, 120)}${ptyInput.length > 120 ? '…' : ''}`);
    this.ptyProc.write(ptyInput + '\r');
  }

  private _handleData(raw: string): void {
    this.screen.write(raw);
    this._chunkIndex++;

    const statusBar = findStatusBar(this.screen);
    const isIdle = isIdleStatusBar(statusBar);
    const isBusy = isBusyStatusBar(statusBar);

    if (PTY_DEBUG) {
      // Find which row holds the status bar (same logic as findStatusBar)
      let sbRow = -1;
      for (let r = ROWS - 1; r >= 0; r--) {
        const row = this.screen.getRow(r);
        if (row.includes('shortcuts') || row.includes('interrupt')) {
          sbRow = r;
          break;
        }
      }
      console.log(
        `[PTY] chunk #${this._chunkIndex} [${this._state}] (${raw.length}b)` +
        ` → status bar row=${sbRow} idle=${isIdle} busy=${isBusy}`,
      );
      // When the status bar disappears during busy phase, dump the bottom rows
      // so we can see exactly what Claude Code is rendering at that moment.
      if (sbRow === -1 && this._state === 'busy') {
        console.log('[PTY] Status bar not found — bottom 20 rows:');
        for (let r = Math.max(0, ROWS - 20); r < ROWS; r++) {
          const row = this.screen.getRow(r);
          if (row.trim()) console.log(`  row[${String(r).padStart(2)}]: ${JSON.stringify(row.trimEnd().slice(0, 120))}`);
        }
      }
    }

    debug(`status: ${JSON.stringify(statusBar.trim().slice(0, 60))}`);

    // ── Startup phase ────────────────────────────────────────────────────────
    if (this._state === 'starting') {
      // Auto-confirm trust dialog if it appears
      if (!this.trustConfirmed) {
        const content = this.screen.getContent(0);
        if (isTrustDialog(content)) {
          debug('Trust dialog detected — confirming');
          if (PTY_DEBUG) console.log('[PTY] Trust dialog detected — sending Enter');
          this.trustConfirmed = true;
          setTimeout(() => this.ptyProc.write('\r'), 300);
          return;
        }
      }

      // Ready when status bar shows idle indicator
      if (isIdle) {
        debug('Ready status bar detected');
        if (PTY_DEBUG) {
          console.log('[PTY] Claude ready — showing initial screen:');
          ptyDebugScreen('Initial screen', this.screen);
        }
        clearTimeout(this.startupTimer!);
        this.startupTimer = null;
        this._state = 'ready';
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve?.();
      }
      return;
    }

    // ── Busy phase: streaming response ──────────────────────────────────────
    if (this._state !== 'busy' || !this.currentRequest) return;

    const req = this.currentRequest;

    // Detect when Claude starts responding (status bar switches to "esc to interrupt").
    // responseStarted is ONLY set here (from actually observing isBusy), never from
    // seeing an idle status bar. This prevents the stale "idle" status bar that appears
    // in the first 1-2 chunks after sending the prompt from triggering a premature
    // _finishResponse via the debounce — if chunk #10 (first busy chunk) arrives more
    // than PROMPT_DEBOUNCE_MS after chunk #8-#9 (stale idle chunks), the old code would
    // call _finishResponse before Claude even started generating.
    if (!this.responseStarted && isBusy) {
      this.responseStarted = true;
      debug('Response started (esc to interrupt detected)');
      if (PTY_DEBUG) console.log('[PTY] Claude is thinking (esc to interrupt)');
    }

    // Detect response complete: status bar returns to idle AFTER we confirmed busy.
    // Requires responseStarted so we never mistake the post-send stale idle for done.
    if (this.responseStarted && isIdle) {
      if (this.promptDebounce) clearTimeout(this.promptDebounce);
      this.promptDebounce = setTimeout(() => {
        this._finishResponse();
      }, PROMPT_DEBOUNCE_MS);
    } else {
      // Reset debounce if we're back to busy before it fires
      if (this.promptDebounce && isBusy) {
        clearTimeout(this.promptDebounce);
        this.promptDebounce = null;
      }
    }
  }

  /**
   * Extract Claude's response text by diffing the final screen against the
   * pre-send snapshot. Filters out prompt echoes, separator lines, and status bar.
   *
   * The diff alone is unreliable across requests because the terminal scrolls:
   * rows that held the welcome panel in `before` may hold different panel content
   * in `after`, making them appear "changed" even though they aren't response text.
   * We anchor extraction to the row immediately after the prompt echo so we only
   * ever collect rows that Claude wrote in response to this specific prompt.
   */
  private _extractResponse(before: string[][], after: string[][], prompt?: string): string {
    const lines: string[] = [];

    // Find the row where the prompt echo appears (❯ <prompt text>) and start
    // extracting only from the row below it. Fall back to row 0 if not found.
    let startRow = 0;
    if (prompt) {
      const needle = prompt.replace(/\n+/g, ' ').trim().slice(0, 40);
      for (let r = 0; r < this.screen.rows; r++) {
        const row = (after[r] ?? []).join('').trimEnd();
        if ((row.includes('❯') || row.includes('>')) && row.includes(needle)) {
          startRow = r + 1;
          break;
        }
      }
    }

    for (let r = startRow; r < this.screen.rows; r++) {
      const bRow = (before[r] ?? []).join('').trimEnd();
      const aRow = (after[r] ?? []).join('').trimEnd();

      if (aRow === bRow) continue;           // unchanged
      if (!aRow.trim()) continue;            // blank

      const stripped = aRow.trimStart();

      // Skip prompt indicator-only lines (empty cursor: ❯ or >)
      if (stripped === '❯' || stripped === '>') continue;

      // Skip prompt echo lines: ❯/> prefix followed by any text
      // These show the user's typed input reflected back in the TUI
      if (stripped.startsWith('❯ ') || stripped.startsWith('> ')) continue;

      // Skip pure separator / box-drawing lines (─ ━ ╌ etc.)
      if (/^[\u2500-\u257F\s]+$/.test(aRow)) continue;

      // Skip status bar lines
      if (aRow.includes('shortcuts') || aRow.includes('interrupt') || aRow.includes('effort')) continue;

      // Skip spinner and auto-update notification lines (Linux: these appear as changed rows)
      if (stripped.includes('Brewing') || stripped.includes('Auto-updating')) continue;

      // Strip Claude's ● response-turn indicator prefix
      let text = stripped;
      if (text.startsWith('●')) text = text.slice(1).trimStart();

      // On Linux, Claude Code renders separator lines with ─ (U+2500) and then writes
      // response text over them without clearing, leaving ─ in place of spaces between
      // words. Replace all box-drawing chars with spaces and collapse runs.
      text = text.replace(/[\u2500-\u257F]/g, ' ').replace(/  +/g, ' ').trim();

      if (text.trim()) lines.push(text.trimEnd());
    }

    return lines.join('\n');
  }

  private _finishResponse(): void {
    const req = this.currentRequest;
    if (!req) return;

    // Extract response text from screen diff (pre-send vs final)
    const finalSnap = this.screen.snapshot();
    const responseText = this._extractResponse(this.lastContentSnapshot, finalSnap, req.prompt);
    debug(`Response complete: ${responseText.slice(0, 80)}`);

    if (PTY_DEBUG) {
      ptyDebugScreen('Final screen after response', this.screen);
      console.log('[PTY] Extracted response:');
      console.log(responseText || '  (empty)');
    }

    if (responseText.trim()) {
      req.onChunk(responseText);
    }

    this._resetState();
    req.onDone();
    this._processQueue();
  }

  private _resetState(): void {
    if (this.hardTimeout) { clearTimeout(this.hardTimeout); this.hardTimeout = null; }
    if (this.promptDebounce) { clearTimeout(this.promptDebounce); this.promptDebounce = null; }
    this.currentRequest = null;
    this.responseStarted = false;
    this._state = 'ready';
    this.lastUsed = Date.now();
  }

  private _processQueue(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this._startRequest(next);
    }
  }

  private _handleExit(exitCode: number): void {
    debug(`PTY exited with code ${exitCode}`);
    this._state = 'dead';

    if (this.readyReject) {
      this.readyReject(new Error(`Claude Code exited during startup (code ${exitCode})`));
      this.readyResolve = null;
      this.readyReject = null;
    }

    if (this.currentRequest) {
      const req = this.currentRequest;
      this._resetState();
      this._state = 'dead';
      req.onError(new Error(`Claude Code process exited unexpectedly (code ${exitCode})`));
    }

    for (const req of this.queue) {
      req.onError(new Error('PTY session died'));
    }
    this.queue = [];
  }

  dispose(): void {
    debug(`Disposing session ${this.id}`);
    this._state = 'dead';
    try { this.ptyProc.kill(); } catch { /* ignore */ }
  }
}
