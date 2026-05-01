// comfyui-api.js - Simple helper functions

const COMFYUI_URL = "http://127.0.0.1:8188"; // Change if your port is different

// Queue the workflow and get a prompt ID
async function queueWorkflow(workflowJson) {
	const response = await fetch(`${COMFYUI_URL}/prompt`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({prompt: workflowJson}),
	});

	if (!response.ok) {
		throw new Error(`Error queuing prompt: ${response.status}`);
	}

	const data = await response.json();
	return data.prompt_id; // This ID tracks your generation
}

// Poll for results (history) using the prompt ID
async function getHistory(promptId) {
	const response = await fetch(`${COMFYUI_URL}/history/${promptId}`);
	if (!response.ok) return null;
	const history = await response.json();
	return history[promptId]; // Returns null/empty until done
}

// Get a generated image as a Blob (for display in <img> or saving)
async function getImage(filename, subfolder = "", type = "output") {
	const params = new URLSearchParams({filename, subfolder, type});
	const response = await fetch(`${COMFYUI_URL}/view?${params}`);
	if (!response.ok) throw new Error("Image not found");
	return await response.blob(); // Use this to create object URL or display
}

// Main example: Run the workflow and show images
export async function runWorkflow(workflowJson, saveImageNodeId = "9") {
	// Replace '6' with your SaveImage node ID
	try {
		const promptId = await queueWorkflow(workflowJson);
		console.log(`Workflow queued! Prompt ID: ${promptId}`);

		// Poll every 2 seconds until done
		const pollInterval = setInterval(async () => {
			const history = await getHistory(promptId);
			if (history) {
				clearInterval(pollInterval);
				console.log("Generation complete!");

				// Find images from your SaveImage node (check your workflow JSON for the node ID)
				const outputs = history.outputs[saveImageNodeId]?.images || [];
				for (const img of outputs) {
					const blob = await getImage(img.filename, img.subfolder, img.type);
					const imageUrl = URL.createObjectURL(blob);

					// Example: Display in HTML
					const imgElement = document.createElement("img");
					imgElement.src = imageUrl;
					document.querySelector("body").appendChild(imgElement);
					// document_BODY.appendChild(imgElement); // Or your app's container
				}
			}
		}, 2000);
	} catch (error) {
		console.error("Error:", error);
	}
}

// // Usage: Load your workflow JSON (e.g., from file input or fetch)
// fetch("your-workflow-api.json") // Or read from file in Node.js/Electron
// 	.then((res) => res.json())
// 	.then((workflow) => runWorkflow(workflow));
