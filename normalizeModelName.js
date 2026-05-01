import dotenv from "dotenv";
dotenv.config({quiet: true});

export const normalizeModelName = (modelName) => {
	//Handle model names like "qwen/qwen3-14b", remove "/" before using as directory

	const nameArray = modelName.toString().split("/");

	if (nameArray.length > 1) {
		const normalizedName = nameArray[1]; //use nameArray[1] instead of splitting again
		return normalizedName;
	} else {
		return modelName; // Model Name that doesn't include "/", no need to handle before using as directory
	}
};
