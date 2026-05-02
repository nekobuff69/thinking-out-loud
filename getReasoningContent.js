import { streamReasoning } from "./llm/llm-stream.js";

export const getReasoningContent = async (
	url,
	model,
	systemPrompt,
	prompt
	// apikey
) => {
	console.log(`\n****PROCESSING****`);
	const tokens = [];

	await streamReasoning(
		url,
		model,
		systemPrompt,
		prompt,
		{
			onReasoningToken: (token) => tokens.push(token),
			onContentStart: () => {},
			onDone: () => {},
		},
		{
			reasoning: { effort: "high" },
			temperature: 1,
		}
	);

	const reasoning = tokens.join("");
	console.log(`\n****REASONING CONTENT****\n${reasoning}`);
	console.log(`\n****END OF REASONING****`);
	return reasoning;
};
