import dotenv from "dotenv";
import {dirname, join} from "path";
import {fileURLToPath} from "url";
import {getReasoningContent} from "./getReasoningContent.js";
import {normalizeModelName} from "./normalizeModelName.js";
import fs from "fs/promises";

dotenv.config({quiet: true, debug: false});

const url = join(process.env.BASE_URL, process.env.CHAT_COMPLETION_ENDPOINT);
// const url = process.env.OPENROUTER_FULL_URL;
// const apikey = process.env.OPENROUTER_API;
const model = process.env.MODEL;
const systemPrompt = "You are a critical thinker.";
const prompt = "How does a LLM go to sleep? ";

const __filePath = fileURLToPath(
	import.meta.url
); /* get the absolute path of current file*/
const __dirname =
	dirname(__filePath); /*get the diretory, projects root folder*/

const now = new Date();
const testTime = now.toLocaleTimeString("en-GB");
const formattedDate = now.toLocaleDateString("en-GB").split("/").join("");

const normalizedModelName = normalizeModelName(model);
const pathToFolder = join(__dirname, "data", normalizedModelName);
fs.mkdir(pathToFolder, {recursive: true});

const pathToSaveFile = join(
	pathToFolder,
	`${normalizedModelName}-reasoning-${testTime}-${formattedDate}.txt`
);

const reasoningContent = await getReasoningContent(
	url,
	model,
	systemPrompt,
	prompt
	// apikey
);

fs.writeFile(pathToSaveFile, reasoningContent, "utf8");
