/**
 * History dock: a flex sibling of the three Columns. Collapsed it is a 30px
 * vertical tab; expanded it is 246px wide and NARROWS the Columns instead of
 * covering them, so no Reasoning text is ever hidden.
 */
import "./history.css";

/**
 * @typedef {Object} HistoryAPI
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
  clearBtn.textContent = "Clear";
  header.appendChild(title);
  header.appendChild(closeBtn);
  header.appendChild(clearBtn);

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

  closeBtn.addEventListener("click", hide);
  tab.addEventListener("click", toggle);
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
    for (const session of sessions) {
      const item = document.createElement("div");
      item.className = "history-item";

      const question = document.createElement("div");
      question.className = "history-question";
      question.textContent = session.question || "(no question)";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      const time = document.createElement("span");
      time.textContent = new Date(session.timestamp).toLocaleString();
      const mode = document.createElement("span");
      mode.className = "history-mode";
      mode.textContent = session.mode || "chorus";
      const modelCount = document.createElement("span");
      modelCount.textContent = `${session.models?.length || 0} models`;
      meta.appendChild(time);
      meta.appendChild(mode);
      meta.appendChild(modelCount);

      item.appendChild(question);
      item.appendChild(meta);
      item.addEventListener("click", () => {
        onReplay(session);
        hide();
      });
      list.appendChild(item);
    }
  }

  return { show, hide, toggle, isOpen() { return container.classList.contains("open"); }, panel };
}
