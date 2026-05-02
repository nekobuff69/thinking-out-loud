import { streamReasoning } from "./llm/llm-stream.js";

export const getReasoningContent = async (
	url,
	model,
	systemPrompt,
	prompt
	// apikey
) => {
	console.log(`\n****PROCESSING****`);
	const baseUrl = url.replace(/\/chat\/completions$/, "");
	const tokens = [];

	await streamReasoning(
		baseUrl,
		model,
		systemPrompt,
		prompt,
		{
			onReasoningToken: (token) => tokens.push(token),
			onContentStart: () => {},
			onDone: () => {},
		}
	);

	const reasoning = tokens.join("");
	console.log(`\n****REASONING CONTENT****\n${reasoning}`);
	console.log(`\n****END OF REASONING****`);
	return reasoning;
};
