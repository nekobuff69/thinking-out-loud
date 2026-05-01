export const getReasoningContent = async (
	url,
	model,
	systemPrompt,
	prompt
	// apikey
) => {
	console.log(`\n****PROCESSING****`);
	const response = await fetch(url, {
		headers: {
			// Authorization: `Bearer ${apikey}`,
			"Content-Type": "application/json",
		},
		method: "POST",
		body: JSON.stringify({
			model: model,
			messages: [
				{role: "system", content: systemPrompt},
				{role: "user", content: prompt},
			],
			reasoning: {
				effort: "high",
			},
			temperature: 1,
		}),
	});

	const data = await response.json();
	const reasoning = data.choices[0].message.reasoning_content;
	// qwen3 series, nvidia, use key 'reasoning_content'; gpt-oss, use key 'reasoning'
	console.log(`\n****REASONING CONTENT****\n${reasoning}`);
	console.log(`\n****END OF REASONING****`);
	return reasoning;
};
