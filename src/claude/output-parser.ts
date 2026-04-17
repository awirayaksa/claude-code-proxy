// ─── ANSI / terminal output cleaning ─────────────────────────────────────────
// Inline regex to avoid the ESM-only strip-ansi package

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

/**
 * Strip carriage-return overwrite sequences used by spinners.
 * Each `\r` within a line resets to the start, so we keep only whatever
 * was written after the last `\r`.
 */
export function stripCarriageReturns(str: string): string {
  return str
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
}

/**
 * Full cleaning pipeline: ANSI → carriage-return → result.
 */
export function cleanOutput(raw: string): string {
  return stripCarriageReturns(stripAnsi(raw));
}

// ─── Prompt boundary detection ────────────────────────────────────────────────

/**
 * Patterns that represent Claude Code's interactive prompt.
 * After ANSI stripping the last non-empty line will match one of these
 * when Claude is idle and waiting for the next user input.
 *
 * Extend this list if the prompt looks different in your environment.
 * Set DEBUG=true in env to log raw cleaned output and help tune patterns.
 */
const PROMPT_PATTERNS: RegExp[] = [
  /^>\s*$/,   // simple "> "
  /^❯\s*$/,  // unicode prompt "❯ "
];

/**
 * Return true when the accumulated clean output ends with Claude's prompt,
 * meaning it has finished its response and is idle.
 */
export function endsWithPrompt(cleanText: string): boolean {
  const lines = cleanText.split('\n');
  // Walk backwards to find the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') continue;
    return PROMPT_PATTERNS.some((p) => p.test(line));
  }
  return false;
}

// ─── Echo removal ─────────────────────────────────────────────────────────────

/**
 * When text is written to a PTY, the terminal echoes it back in the output.
 * Strip the echoed prompt text from the beginning of the response buffer.
 */
export function removeEcho(output: string, sentText: string): string {
  // Normalize: remove trailing \r\n that was added when writing
  const needle = sentText.replace(/\r?\n?$/, '').trim();
  if (!needle) return output;

  const trimmed = output.trimStart();
  if (trimmed.startsWith(needle)) {
    return trimmed.slice(needle.length).trimStart();
  }
  return output;
}

// ─── UI chrome filter ─────────────────────────────────────────────────────────

/**
 * Lines that are purely Claude Code UI chrome and not part of the response.
 * These are detected after ANSI+CR stripping.
 */
const UI_LINE_PATTERNS: RegExp[] = [
  /^[╭╰─│╮╯┌└─│┐┘]+/, // box-drawing characters
  /^\s*Claude Code\s*/i,
  /^\s*v\d+\.\d+\.\d+\s*$/, // version string
  /^\s*\?\s+.*\(Y\/n\)/i, // yes/no prompts
  /^\s*\?\s+.*\(y\/N\)/i,
];

/**
 * Return true if this line is UI decoration rather than response content.
 */
export function isUiLine(line: string): boolean {
  return UI_LINE_PATTERNS.some((p) => p.test(line));
}

/**
 * Filter a block of clean text: remove UI chrome lines and prompt lines,
 * leaving only the actual response content.
 */
export function extractResponseText(cleanText: string): string {
  return cleanText
    .split('\n')
    .filter((line) => !isUiLine(line) && !endsWithPrompt(line))
    .join('\n')
    .trim();
}
