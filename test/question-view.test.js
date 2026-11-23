import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { questionView } from "../ui/question-view.js";

const PROMPTS = ["First question", "Second question"];

describe("Question view", () => {
  it("shows the exact question that was asked", () => {
    assert.equal(questionView("Anything at all", "007", PROMPTS).text, "Anything at all");
  });

  it("labels Curated prompts by position and everything else as free-text", () => {
    assert.equal(questionView("Second question", "007", PROMPTS).source, "Curated 02");
    assert.equal(questionView("typed by hand", "007", PROMPTS).source, "Free-text question");
  });

  it("builds the replay view from the selected session's question", () => {
    const selectedSession = { question: "Second question" };
    assert.deepEqual(questionView(selectedSession.question, "014", PROMPTS), {
      text: "Second question",
      sessionId: "014",
      source: "Curated 02",
    });
  });

  it("keeps the replay session id in both readouts", () => {
    const view = questionView("typed by hand", "013", PROMPTS);
    assert.equal(view.sessionId, "013");
    assert.equal(view.text, "typed by hand");
  });
});
