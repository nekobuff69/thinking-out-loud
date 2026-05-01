export default function getWorkflowWithRandomSeed(workflowJson) {
	const randomSeed = Math.floor(Math.random() * 999999999999);

	const modifiedWorkFlow = {
		...workflowJson,
		3: {
			...workflowJson[3],
			inputs: {
				...workflowJson[3].inputs,
				seed: randomSeed,
			},
		},
	};
	console.log(modifiedWorkFlow);
	return modifiedWorkFlow;
}
