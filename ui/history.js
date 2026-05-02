/**
 * History UI: renders a panel of past sessions.
 * Clicking a session triggers replay in the orchestrator.
 */
export function createHistory(container, store, onReplay) {
  const panel = document.createElement("div");
  panel.className = "history-panel";
  panel.style.display = "none";

  const header = document.createElement("div");
  header.className = "history-header";

  const title = document.createElement("h3");
  title.textContent = "History";

  const closeBtn = document.createElement("button");
  closeBtn.className = "history-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    panel.style.display = "none";
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "history-clear";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    store.clear();
    renderList();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  header.appendChild(clearBtn);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "history-list";
  panel.appendChild(list);

  container.appendChild(panel);

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
        panel.style.display = "none";
      });

      list.appendChild(item);
    }
  }

  function show() {
    renderList();
    panel.style.display = "block";
  }

  return { show, panel };
}
