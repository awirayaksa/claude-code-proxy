/**
 * Debug script v8 — simplified:
 * - Trust dialog auto-confirm
 * - Wait for 'shortcuts' → send hello
 * - Wait for 'shortcuts' to return → dump full screen
 * - Show ALL rows that changed between pre-send and post-response
 */
const pty = require('node-pty');
const { ScreenBuffer } = require('./dist/claude/screen-buffer');

process.on('uncaughtException', (err) => {
  console.error('\n!!! UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

function findStatusBar(screen) {
  for (let r = 49; r >= 0; r--) {
    const row = screen.getRow(r);
    if (row.includes('shortcuts') || row.includes('interrupt') || row.includes('effort')) {
      return { row: r, text: row };
    }
  }
  return { row: -1, text: '' };
}

const screen = new ScreenBuffer(220, 50);
console.log('Spawning claude...\n');

const ptyProc = pty.spawn('claude', [], {
  name: 'xterm-color', cols: 220, rows: 50,
  cwd: process.cwd(), env: { ...process.env },
});

let phase = 'startup';
let trustConfirmed = false;
let messageSent = false;
let preSendSnap = null;
let responseStarted = false;
let chunkIndex = 0;

ptyProc.onData((data) => {
  try {
    chunkIndex++;
    screen.write(data);
    const { row: sbRow, text: statusBar } = findStatusBar(screen);

    const isIdle = statusBar.includes('shortcuts');
    const isBusy = statusBar.includes('interrupt');

    console.log(`CHUNK #${chunkIndex} [${phase}] (${data.length}b) → status bar row=${sbRow} idle=${isIdle} busy=${isBusy}`);

    // Trust dialog
    if (!trustConfirmed) {
      const content = screen.getContent(0);
      if (content.includes('Yes, I trust this folder') || content.includes('Enter to confirm')) {
        trustConfirmed = true;
        console.log('  → TRUST DIALOG — confirming');
        setTimeout(() => ptyProc.write('\r'), 300);
        return;
      }
    }

    // Ready detection
    if (!messageSent && isIdle) {
      messageSent = true;
      preSendSnap = screen.snapshot();
      phase = 'waiting';
      console.log('  → CLAUDE READY — sending "hello" in 800ms');
      setTimeout(() => {
        console.log('\n>>> Writing: hello <<<\n');
        ptyProc.write('hello\r');
      }, 800);
      return;
    }

    // Track response lifecycle
    if (phase === 'waiting' && isBusy) {
      phase = 'responding';
      responseStarted = true;
      console.log('  → Claude is thinking (esc to interrupt)');
    }

    if (phase === 'responding' && isIdle) {
      phase = 'done';
      console.log('\n>>> RESPONSE COMPLETE <<<\n');

      // Dump ALL 50 rows with their index
      console.log('=== FULL SCREEN (all 50 rows) ===');
      for (let r = 0; r < 50; r++) {
        const row = screen.getRow(r);
        if (row.trim()) {
          console.log(`  row[${String(r).padStart(2)}]: ${JSON.stringify(row.trimEnd())}`);
        }
      }

      // Diff against pre-send snapshot
      if (preSendSnap) {
        console.log('\n=== CHANGED ROWS (vs pre-send) ===');
        for (let r = 0; r < 50; r++) {
          const before = (preSendSnap[r] ?? []).join('').trimEnd();
          const after = screen.getRow(r);
          if (before !== after) {
            console.log(`  row[${String(r).padStart(2)}] before: ${JSON.stringify(before.slice(0, 80))}`);
            console.log(`  row[${String(r).padStart(2)}]  after: ${JSON.stringify(after.slice(0, 80))}`);
          }
        }
      }
    }

  } catch (e) {
    console.error(`\nERROR in chunk ${chunkIndex}:`, e.message, e.stack);
  }
});

ptyProc.onExit(({ exitCode }) => {
  console.log(`\n!!! CLAUDE EXITED (code=${exitCode}) phase=${phase} !!!`);
  if (preSendSnap) {
    console.log('\n=== FINAL SCREEN ROWS ===');
    for (let r = 0; r < 50; r++) {
      const row = screen.getRow(r);
      if (row.trim()) console.log(`  row[${r}]: ${JSON.stringify(row.trimEnd().slice(0, 120))}`);
    }
  }
});

setTimeout(() => {
  console.log('\n=== 90s TIMEOUT ===');
  console.log('phase:', phase);
  console.log('\n=== CURRENT SCREEN ===');
  for (let r = 0; r < 50; r++) {
    const row = screen.getRow(r);
    if (row.trim()) console.log(`  row[${r}]: ${JSON.stringify(row.trimEnd().slice(0, 120))}`);
  }
  ptyProc.kill();
  process.exit(0);
}, 90000);
