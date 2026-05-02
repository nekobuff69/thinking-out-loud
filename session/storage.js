/**
 * SessionStore: persists completed sessions to LocalStorage.
 * Handles save, load, list (sorted newest first), clear, and eviction.
 */
const SESSIONS_KEY = "tol_sessions";
const RECENT_QUESTIONS_KEY = "tol_recent_questions";
const MAX_RECENT_QUESTIONS = 10;

export class SessionStore {
  #maxSessions;

  constructor(maxSessions = 20) {
    this.#maxSessions = maxSessions;
  }

  /** Save a completed session. Evicts oldest if over limit. */
  save(session) {
    const sessions = this.#loadSessions();
    sessions.unshift(session);
    if (sessions.length > this.#maxSessions) {
      sessions.length = this.#maxSessions;
    }
    this.#writeSessions(sessions);
  }

  /** Load a single session by id. Returns null if not found. */
  load(id) {
    const sessions = this.#loadSessions();
    return sessions.find((s) => s.id === id) || null;
  }

  /** List all sessions sorted by timestamp descending. */
  list() {
    return this.#loadSessions().slice();
  }

  /** Clear all stored sessions. */
  clear() {
    localStorage.removeItem(SESSIONS_KEY);
  }

  /** Save a recent question (deduplicated, most recent first). */
  saveQuestion(text) {
    if (!text?.trim()) return;
    const trimmed = text.trim();
    const questions = this.#loadQuestions();
    // Remove duplicate if exists
    const idx = questions.indexOf(trimmed);
    if (idx > -1) questions.splice(idx, 1);
    // Add to front
    questions.unshift(trimmed);
    // Cap length
    if (questions.length > MAX_RECENT_QUESTIONS) {
      questions.length = MAX_RECENT_QUESTIONS;
    }
    localStorage.setItem(RECENT_QUESTIONS_KEY, JSON.stringify(questions));
  }

  /** Get recent questions (most recent first). */
  getQuestions() {
    return this.#loadQuestions();
  }

  #loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  #writeSessions(sessions) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch {
      // Quota exceeded — remove oldest and retry once
      if (sessions.length > 1) {
        sessions.pop();
        try {
          localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        } catch {
          // Still failing — silently give up
        }
      }
    }
  }

  #loadQuestions() {
    try {
      const raw = localStorage.getItem(RECENT_QUESTIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}
