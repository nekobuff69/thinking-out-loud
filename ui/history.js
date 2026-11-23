/**
 * History dock: a flex sibling of the three Columns. Collapsed it is a 30px
 * vertical tab; expanded it is 246px wide and NARROWS the Columns instead of
 * covering them, so no Reasoning text is ever hidden.
 */
import "./history.css";

/**
 * @typedef {Object} HistoryAPI
 * @property {(fn: () => void) => void} onOpen
 * @property {(fn: () => void) => void} onClose
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => void} toggle
 * @property {() => boolean} isOpen
 * @property {HTMLDivElement} panel
 */

/**
 * @param {HTMLElement} container
 * @param {import("../session/storage.js").SessionStore} store
 * @param {(session: import("../session/storage.js").SessionData) => void} onReplay
 * @returns {HistoryAPI}
 */
export function createHistory(container, store, onReplay) {
  /** @type {(() => void) | null} */
  let onClose = null;
  /** @type {(() => void) | null} */
  let onOpen = null;
  const panel = document.createElement("div");
  panel.className = "history-dock-inner";

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "history-tab";
  tab.textContent = "‹ History · 20";
  tab.setAttribute("aria-label", "Toggle session history");

  const content = document.createElement("div");
  content.className = "history-body";

  const header = document.createElement("div");
  header.className = "history-header";
  const title = document.createElement("h3");
  title.textContent = "History / 20 max";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "history-close";
  closeBtn.textContent = "× close";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "history-clear";
  clearBtn.textContent = "clear all";
  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.appendChild(closeBtn);
  actions.appendChild(clearBtn);
  header.appendChild(title);
  header.appendChild(actions);

  const list = document.createElement("div");
  list.className = "history-list";

  const hint = document.createElement("div");
  hint.className = "history-hint";
  hint.textContent = "Click to replay · clear all";

  content.appendChild(header);
  content.appendChild(list);
  content.appendChild(hint);
  panel.appendChild(tab);
  panel.appendChild(content);
  container.appendChild(panel);

  /** @returns {void} */
  function hide() {
    container.classList.remove("open");
  }
  /** @returns {void} */
  function show() {
    renderList();
    container.classList.add("open");
  }
  /** @returns {void} */
  function toggle() {
    if (container.classList.contains("open")) hide();
    else show();
  }

  closeBtn.addEventListener("click", () => { if (onClose) onClose(); else hide(); });
  tab.addEventListener("click", () => {
    if (container.classList.contains("open")) {
      if (onClose) onClose(); else hide();
    } else {
      if (onOpen) onOpen();
      else show();
    }
  });
  clearBtn.addEventListener("click", () => {
    if (store.list().length > 0 && !confirm("Clear all session history? This cannot be undone.")) return;
    store.clear();
    renderList();
  });

  /** @returns {void} */
  function renderList() {
    list.innerHTML = "";
    const sessions = store.list();
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No sessions yet";
      list.appendChild(empty);
      return;
    }
    for (const [index, session] of sessions.entries()) {
      const item = document.createElement("div");
      item.className = "history-item" + (index === 0 ? " on" : "");

      const line = document.createElement("div");
      line.className = "history-line";
      const number = document.createElement("b");
      number.textContent = String(sessions.length - index).padStart(3, "0");
      line.appendChild(number);
      line.appendChild(document.createTextNode(" " + (session.question || "(no question)")));

      const meta = document.createElement("span");
      meta.className = "history-meta";
      const when = new Date(session.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      meta.textContent = "Replay · " + when + " · " + (session.models?.length || 0) + " voices";

      item.appendChild(line);
      item.appendChild(meta);
      item.addEventListener("click", () => {
        onReplay(session);
        hide();
      });
      list.appendChild(item);
    }
  }

  return {
    show, hide, toggle,
    onOpen(fn) { onOpen = fn; },
    onClose(fn) { onClose = fn; },
    isOpen() { return container.classList.contains("open"); },
    panel,
  };
}
