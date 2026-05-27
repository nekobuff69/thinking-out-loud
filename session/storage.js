/**
 * @typedef {Object} SessionModelData
 * @property {string} name
 * @property {string} displayName
 * @property {string} color
 * @property {string} voice
 * @property {number} pan
 * @property {string} reasoningText
 */

/**
 * @typedef {Object} SessionData
 * @property {string} id
 * @property {string} timestamp
 * @property {string} question
 * @property {string} mode
 * @property {SessionModelData[]} models
 * @property {string[]} [playbackOrder] - Model names in TTS playback sequence (randomized per session)
 */

/**
 * @typedef {Object} StorageAdapter
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/**
 * SessionStore: persists completed sessions.
 * Handles save, load, list (sorted newest first), clear, and eviction.
 */
import { LocalStorageAdapter } from "./local-storage-adapter.js";

const SESSIONS_KEY = "tol_sessions";
const RECENT_QUESTIONS_KEY = "tol_recent_questions";
const MAX_RECENT_QUESTIONS = 10;

export class SessionStore {
  /** @type {number} */
  #maxSessions;
  /** @type {StorageAdapter} */
  #adapter;

  /**
   * @param {number} [maxSessions]
   * @param {StorageAdapter} [storageAdapter]
   */
  constructor(maxSessions = 20, storageAdapter) {
    this.#maxSessions = maxSessions;
    this.#adapter = storageAdapter ?? new LocalStorageAdapter();
  }

  /** Save a completed session. Evicts oldest if over limit.
   * @param {SessionData} session
   * @returns {void}
   */
  save(session) {
    const sessions = this.#loadSessions();
    sessions.unshift(session);
    if (sessions.length > this.#maxSessions) {
      sessions.length = this.#maxSessions;
    }
    this.#writeSessions(sessions);
  }

  /** Load a single session by id. Returns null if not found.
   * @param {string} id
   * @returns {SessionData | null}
   */
  load(id) {
    const sessions = this.#loadSessions();
    return sessions.find((/** @type {SessionData} */ s) => s.id === id) || null;
  }

  /** List all sessions sorted by timestamp descending.
   * @returns {SessionData[]}
   */
  list() {
    return this.#loadSessions().slice();
  }

  /** Clear all stored sessions.
   * @returns {void}
   */
  clear() {
    this.#adapter.removeItem(SESSIONS_KEY);
  }

  /** Save a recent question (deduplicated, most recent first).
   * @param {string} text
   * @returns {void}
   */
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
    this.#adapter.setItem(RECENT_QUESTIONS_KEY, JSON.stringify(questions));
  }

  /** Get recent questions (most recent first).
   * @returns {string[]}
   */
  getQuestions() {
    return this.#loadQuestions();
  }

  #loadSessions() {
    try {
      const raw = this.#adapter.getItem(SESSIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {SessionData[]} sessions
   * @returns {void}
   */
  #writeSessions(sessions) {
    try {
      this.#adapter.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch {
      // Quota exceeded — remove oldest and retry once
      if (sessions.length > 1) {
        sessions.pop();
        try {
          this.#adapter.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        } catch {
          // Still failing — silently give up
        }
      }
    }
  }

  #loadQuestions() {
    try {
      const raw = this.#adapter.getItem(RECENT_QUESTIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}
