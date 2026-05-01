import {runWorkflow} from "./triggerWorkflow.js";
// import zImageWorkflow from "./z_image_turbo_text-2-img_default.json" with {type: "json"};
import {workflowTemplate} from "./workflowTemplate.js";
import getWorkflowWithRandomSeed from "./getWorkflowWithRandomSeed.js";

const runWorkflowBtn = document.getElementById("trigger-workflow-btn");
runWorkflowBtn.addEventListener("click", () =>
	runWorkflow(getWorkflowWithRandomSeed(workflowTemplate))
);
