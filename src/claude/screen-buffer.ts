/**
 * Minimal VT100/xterm screen buffer.
 *
 * Feeds raw PTY bytes in → maintains a cols×rows character grid →
 * lets callers read rendered text from any row or the full screen.
 *
 * Handles the sequences Claude Code actually uses:
 *   CUP    ESC[row;colH      — absolute cursor positioning
 *   ED     ESC[nJ            — erase in display
 *   EL     ESC[nK            — erase in line
 *   CUU/D/F/B ESC[nA/B/C/D  — cursor movement
 *   CHA    ESC[nG            — cursor horizontal absolute
 *   VPA    ESC[nd            — cursor vertical absolute
 *   DECSTBM ESC[t;br         — set scrolling region (top/bottom margins)
 *   SU     ESC[nS            — scroll up n lines within scroll region
 *   SD     ESC[nT            — scroll down n lines within scroll region
 *   IL     ESC[nL            — insert n blank lines
 *   DL     ESC[nM            — delete n lines
 *   RI     ESC M             — reverse index (scroll down at top margin)
 *   DEC private ?1049h/l     — alternate screen buffer
 *   SGR    ESC[...m          — colors / attributes (ignored)
 *   All other ESC sequences  — ignored (not rendered)
 */
export class ScreenBuffer {
  readonly cols: number;
  readonly rows: number;

  private screen: string[][];
  private altScreen: string[][];
  private useAlt = false;

  private cursorRow = 0;
  private cursorCol = 0;
  private savedCursor = { row: 0, col: 0 };
  private altSavedCursor = { row: 0, col: 0 };

  // Scrolling region (1-based in terminal spec, stored 0-based)
  private scrollTop = 0;
  private scrollBottom: number;

  constructor(cols = 220, rows = 50) {
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;
    this.screen = this._blank();
    this.altScreen = this._blank();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Feed raw PTY bytes (may contain ANSI sequences + text). */
  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === '\u001b') {
        const next = data[i + 1];
        if (next === '[') {
          // CSI: ESC [ <params> <final>
          const end = this._csiEnd(data, i + 2);
          if (end !== -1) {
            this._handleCsi(data.slice(i + 2, end), data[end]);
            i = end + 1;
          } else {
            i++; // malformed, skip ESC
          }
        } else if (next === ']') {
          // OSC: ESC ] ... BEL  or  ESC ] ... ST(ESC \)
          const bel = data.indexOf('\u0007', i + 2);
          const st = data.indexOf('\u001b\\', i + 2);
          if (bel !== -1 && (st === -1 || bel < st)) {
            i = bel + 1;
          } else if (st !== -1) {
            i = st + 2;
          } else {
            i++;
          }
        } else if (next === '(' || next === ')') {
          // Character set — skip 3 chars
          i += 3;
        } else if (next === 'M') {
          // Reverse Index: move cursor up; scroll down if at top margin
          if (this.cursorRow === this.scrollTop) {
            this._scrollDown(1);
          } else {
            this.cursorRow = Math.max(0, this.cursorRow - 1);
          }
          i += 2;
        } else if (next === '7') {
          // Save cursor (DEC)
          this._saveCursor();
          i += 2;
        } else if (next === '8') {
          // Restore cursor (DEC)
          this._restoreCursor();
          i += 2;
        } else {
          i++; // unknown ESC sequence, skip ESC
        }
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 0;
      } else if (ch === '\n') {
        // At bottom of scroll region → scroll up; otherwise just move down
        if (this.cursorRow === this.scrollBottom) {
          this._scrollUp(1);
        } else {
          this.cursorRow = Math.min(this.cursorRow + 1, this.rows - 1);
        }
      } else if (ch === '\b') {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
      } else if (ch === '\t') {
        // Tab: advance to next 8-column boundary
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
      } else if (ch === '\u0007') {
        // Bell — ignore
      } else if (ch.charCodeAt(0) >= 32) {
        // Printable character
        this._put(ch);
      }
      // Other control characters ignored

      i++;
    }
  }

  /** Get the trimmed text of a single row (0-indexed). */
  getRow(r: number): string {
    if (r < 0 || r >= this.rows) return '';
    return this._buf()[r].join('').trimEnd();
  }

  /**
   * Get content area text: all rows except the last `excludeBottom` rows
   * (which typically hold the status bar and separator).
   */
  getContent(excludeBottom = 2): string {
    const lines: string[] = [];
    for (let r = 0; r < this.rows - excludeBottom; r++) {
      lines.push(this.getRow(r));
    }
    return lines.join('\n').trimEnd();
  }

  /** Take a snapshot of the current buffer for diffing. */
  snapshot(): string[][] {
    return this._buf().map((row) => [...row]);
  }

  /**
   * Compare two snapshots, return only new non-whitespace content in rows
   * that changed within the content area (excludes status bar rows).
   */
  diffContent(before: string[][], after: string[][], excludeBottom = 2): string {
    const changed: string[] = [];
    const limit = this.rows - excludeBottom;
    for (let r = 0; r < limit; r++) {
      const bRow = (before[r] ?? []).join('').trimEnd();
      const aRow = (after[r] ?? []).join('').trimEnd();
      if (aRow !== bRow && aRow.trim() !== '') {
        changed.push(aRow);
      }
    }
    return changed.join('\n');
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _buf(): string[][] {
    return this.useAlt ? this.altScreen : this.screen;
  }

  private _blank(): string[][] {
    return Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' '));
  }

  private _blankRow(): string[] {
    return Array<string>(this.cols).fill(' ');
  }

  private _put(ch: string): void {
    if (this.cursorRow < this.rows && this.cursorCol < this.cols) {
      this._buf()[this.cursorRow][this.cursorCol] = ch;
    }
    this.cursorCol++;
    if (this.cursorCol >= this.cols) {
      // Auto-wrap
      this.cursorCol = 0;
      if (this.cursorRow === this.scrollBottom) {
        this._scrollUp(1);
      } else {
        this.cursorRow = Math.min(this.cursorRow + 1, this.rows - 1);
      }
    }
  }

  /**
   * Scroll the scroll region up by n lines.
   * Top n lines of the region are removed; n blank lines appear at the bottom.
   * Rows outside the scroll region are untouched.
   */
  private _scrollUp(n: number): void {
    const buf = this._buf();
    for (let i = 0; i < n; i++) {
      // Remove top line of scroll region — everything inside shifts up
      buf.splice(this.scrollTop, 1);
      // Insert blank line at bottom of scroll region
      buf.splice(this.scrollBottom, 0, this._blankRow());
    }
  }

  /**
   * Scroll the scroll region down by n lines.
   * Bottom n lines of the region are removed; n blank lines appear at the top.
   * Rows outside the scroll region are untouched.
   */
  private _scrollDown(n: number): void {
    const buf = this._buf();
    for (let i = 0; i < n; i++) {
      // Remove bottom line of scroll region, then insert blank at top.
      // Must remove first (at scrollBottom) before inserting at scrollTop,
      // otherwise scrollBottom shifts and we'd remove the wrong row.
      buf.splice(this.scrollBottom, 1);
      buf.splice(this.scrollTop, 0, this._blankRow());
    }
  }

  private _csiEnd(data: string, start: number): number {
    // CSI parameter/intermediate bytes: 0x20–0x3F
    // CSI final byte: 0x40–0x7E
    for (let i = start; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i;  // final byte
      if (c < 0x20) return -1;               // control char inside CSI = malformed
    }
    return -1;
  }

  private _handleCsi(params: string, final: string): void {
    // DEC private mode: starts with '?'
    if (params.startsWith('?')) {
      this._handleDecPrivate(params.slice(1), final);
      return;
    }

    const parts = params.split(';');
    const n = (i: number, def = 0) => parseInt(parts[i] || String(def), 10) || def;

    switch (final) {
      case 'H': case 'f': {
        // CUP: cursor position (1-based)
        const row = Math.max(1, n(0, 1));
        const col = Math.max(1, n(1, 1));
        this.cursorRow = Math.min(row - 1, this.rows - 1);
        this.cursorCol = Math.min(col - 1, this.cols - 1);
        break;
      }
      case 'A': // Cursor Up
        this.cursorRow = Math.max(0, this.cursorRow - n(0, 1));
        break;
      case 'B': // Cursor Down
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0, 1));
        break;
      case 'C': // Cursor Forward
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n(0, 1));
        break;
      case 'D': // Cursor Back
        this.cursorCol = Math.max(0, this.cursorCol - n(0, 1));
        break;
      case 'E': // Cursor Next Line
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0, 1));
        this.cursorCol = 0;
        break;
      case 'F': // Cursor Previous Line
        this.cursorRow = Math.max(0, this.cursorRow - n(0, 1));
        this.cursorCol = 0;
        break;
      case 'G': // Cursor Horizontal Absolute
        this.cursorCol = Math.min(Math.max(0, n(0, 1) - 1), this.cols - 1);
        break;
      case 'd': // Vertical Position Absolute
        this.cursorRow = Math.min(Math.max(0, n(0, 1) - 1), this.rows - 1);
        break;
      case 'J': // Erase in Display
        this._eraseDisplay(n(0, 0));
        break;
      case 'K': // Erase in Line
        this._eraseLine(n(0, 0));
        break;
      case 'L': { // Insert Lines — insert n blank lines at cursor, push region down
        const count = Math.min(n(0, 1), this.scrollBottom - this.cursorRow + 1);
        const buf = this._buf();
        for (let i = 0; i < count; i++) {
          buf.splice(this.scrollBottom + 1, 1);      // remove line that falls off bottom
          buf.splice(this.cursorRow, 0, this._blankRow()); // insert blank at cursor
        }
        this.cursorCol = 0;
        break;
      }
      case 'M': { // Delete Lines — delete n lines at cursor, pull region up
        const count = Math.min(n(0, 1), this.scrollBottom - this.cursorRow + 1);
        const buf = this._buf();
        for (let i = 0; i < count; i++) {
          buf.splice(this.cursorRow, 1);                   // remove line at cursor
          buf.splice(this.scrollBottom, 0, this._blankRow()); // add blank at bottom
        }
        this.cursorCol = 0;
        break;
      }
      case 'P': { // Delete Character
        const buf = this._buf();
        const row = buf[this.cursorRow];
        const count = n(0, 1);
        row.splice(this.cursorCol, count);
        while (row.length < this.cols) row.push(' ');
        break;
      }
      case 'S': // Scroll Up n lines
        this._scrollUp(n(0, 1));
        break;
      case 'T': // Scroll Down n lines
        this._scrollDown(n(0, 1));
        break;
      case 'X': { // Erase Character (overwrite with spaces)
        const count = n(0, 1);
        for (let c = 0; c < count && this.cursorCol + c < this.cols; c++) {
          this._buf()[this.cursorRow][this.cursorCol + c] = ' ';
        }
        break;
      }
      case 'r': { // DECSTBM — set scrolling region (1-based, inclusive)
        const top = n(0, 1);
        const bottom = n(1, this.rows);
        this.scrollTop = Math.max(0, top - 1);
        this.scrollBottom = Math.min(this.rows - 1, bottom - 1);
        // DECSTBM also homes the cursor
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      }
      case 's': // Save cursor (ANSI)
        this._saveCursor();
        break;
      case 'u': // Restore cursor (ANSI)
        this._restoreCursor();
        break;
      case 'm': // SGR — colors/attributes, ignore
        break;
      // Everything else: ignore
    }
  }

  private _handleDecPrivate(modeStr: string, final: string): void {
    const mode = parseInt(modeStr, 10);
    if (final === 'h') {
      if (mode === 1049 || mode === 47) {
        // Switch to alternate screen — save cursor, blank alt screen, reset scroll region
        this._saveCursor();
        this.useAlt = true;
        this.altScreen = this._blank();
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
      }
      // Other modes (25=cursor, 2004=bracketed paste, etc.) — ignore
    } else if (final === 'l') {
      if (mode === 1049 || mode === 47) {
        // Restore normal screen — reset scroll region
        this.useAlt = false;
        this._restoreCursor();
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
      }
    }
  }

  private _eraseDisplay(mode: number): void {
    const buf = this._buf();
    if (mode === 0) {
      // Erase from cursor to end of screen
      for (let c = this.cursorCol; c < this.cols; c++) buf[this.cursorRow][c] = ' ';
      for (let r = this.cursorRow + 1; r < this.rows; r++) buf[r].fill(' ');
    } else if (mode === 1) {
      // Erase from start to cursor
      for (let r = 0; r < this.cursorRow; r++) buf[r].fill(' ');
      for (let c = 0; c <= this.cursorCol; c++) buf[this.cursorRow][c] = ' ';
    } else if (mode === 2 || mode === 3) {
      // Erase entire screen
      for (let r = 0; r < this.rows; r++) buf[r].fill(' ');
    }
  }

  private _eraseLine(mode: number): void {
    const buf = this._buf();
    const row = buf[this.cursorRow];
    if (mode === 0) {
      // Erase to end of line
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = ' ';
    } else if (mode === 1) {
      // Erase to start of line
      for (let c = 0; c <= this.cursorCol; c++) row[c] = ' ';
    } else if (mode === 2) {
      // Erase entire line
      row.fill(' ');
    }
  }

  private _saveCursor(): void {
    if (this.useAlt) {
      this.altSavedCursor = { row: this.cursorRow, col: this.cursorCol };
    } else {
      this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
    }
  }

  private _restoreCursor(): void {
    const saved = this.useAlt ? this.altSavedCursor : this.savedCursor;
    this.cursorRow = saved.row;
    this.cursorCol = saved.col;
  }
}
