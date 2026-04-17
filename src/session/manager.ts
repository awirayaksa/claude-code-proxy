import { v4 as uuidv4 } from 'uuid';
import { PTYSession } from './pty-session';

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? '600000', 10);
const EVICTION_INTERVAL_MS = 60_000;

export class SessionManager {
  private sessions = new Map<string, PTYSession>();
  private evictionTimer: NodeJS.Timeout;

  constructor() {
    this.evictionTimer = setInterval(() => this._evictIdle(), EVICTION_INTERVAL_MS);
    // Don't keep the process alive just for the eviction timer
    this.evictionTimer.unref();
  }

  /**
   * Get an existing session by ID, or create a new one.
   * New sessions are fully started (Claude prompt visible) before returning.
   */
  async getOrCreate(sessionId?: string): Promise<{ session: PTYSession; isNew: boolean }> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && existing.state !== 'dead') {
        existing.lastUsed = Date.now();
        return { session: existing, isNew: false };
      }
      // Session expired or dead — create a fresh one with the same ID
      if (existing) {
        existing.dispose();
        this.sessions.delete(sessionId);
      }
    }

    const id = sessionId ?? uuidv4();
    const session = new PTYSession(id);

    try {
      await session.waitForReady();
    } catch (err) {
      session.dispose();
      throw err;
    }

    this.sessions.set(id, session);
    return { session, isNew: true };
  }

  /**
   * Return the number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Kill and remove all sessions. Called during graceful shutdown.
   */
  disposeAll(): void {
    clearInterval(this.evictionTimer);
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private _evictIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const idle = now - session.lastUsed;
      if (session.state === 'dead' || idle > SESSION_TTL_MS) {
        console.log(`[SessionManager] Evicting session ${id} (idle ${Math.round(idle / 1000)}s)`);
        session.dispose();
        this.sessions.delete(id);
      }
    }
  }
}

// Singleton instance used by the rest of the application
export const sessionManager = new SessionManager();
