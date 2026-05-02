import { config } from "./config.js";

function render() {
  const topBar = document.getElementById("top-bar");
  const columnsContainer = document.getElementById("columns");

  // Top bar placeholder (PromptSelector + ModeToggle will go here)
  topBar.textContent = "Thinking Out Loud";

  // Column placeholders
  config.models.forEach((model) => {
    const col = document.createElement("div");
    col.className = "column";
    col.id = `column-${model.name.toLowerCase()}`;

    const header = document.createElement("div");
    header.className = "column-header";
    header.style.color = model.color;
    header.textContent = model.name;

    const reasoning = document.createElement("div");
    reasoning.className = "column-reasoning";
    reasoning.textContent = "";

    const waveform = document.createElement("canvas");
    waveform.className = "column-waveform";
    waveform.width = 300;
    waveform.height = 60;

    col.appendChild(header);
    col.appendChild(reasoning);
    col.appendChild(waveform);
    columnsContainer.appendChild(col);
  });
}

render();
