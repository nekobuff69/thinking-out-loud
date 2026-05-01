export const workflowTemplate = {
	3: {
		inputs: {
			seed: 809692561289,
			control_after_generate: "randomize",
			steps: 9,
			cfg: 1,
			sampler_name: "euler",
			scheduler: "simple",
			denoise: 1,
			model: ["16", 0],
			positive: ["6", 0],
			negative: ["7", 0],
			latent_image: ["34", 0],
		},
		class_type: "KSampler",
		_meta: {
			title: "KSampler",
		},
	},
	6: {
		inputs: {
			text: "Soft watercolor illustration, three plump piglets each building a distinct house (straw, sticks, bricks) on rolling hills at sunset; a friendly yet mischievous big bad wolf peeking from behind a tree with exaggerated eyes, gentle smile. Light dapples through leaves, adding subtle magic; textures of fuzzy fur, smooth wood, and fluffy clouds. Warm pastel palette creates comforting, wonder-filled bedtime scene. ",
			clip: ["18", 0],
		},
		class_type: "CLIPTextEncode",
		_meta: {
			title: "CLIP Text Encode (Positive Prompt)",
		},
	},
	7: {
		inputs: {
			text: 'worst_quality, bad_quality,bad_hands,very_displeasing, boring, long_body, monochrome, watermark , lowres, worst quality, low quality, normal quality, jpeg artifacts,korean comic style,off center crop,slant out of frame,drifting eyeline,double eyelashes,text to the face ,eye patch,shaking hands,arrow toes,background characters with blurred faces,unconscious expression,nasty smile,"ng_deepnegative_v1_75t",\n\n\n     # bad anatomy & pose\n\n,bad hands,missing hands,missing fingers,bad feet,cropped off limbs,weak hands,sketch hands,\n\ndehydrated ,aged,mature ,blurry and background, disfigurement,(bad eyes),(bad fingers),flat  face,\n\nlayout text, overlay text,cover title, signature, captions, comic panel,interoframe,line breaks,\n\nusername, artist signature, water mark,displayed text,Scanner Text,Date,website, artist\'s name,artist name, page number, translation,subtitle,chinese text,korean hangul text,russian cyrillic text, english text, twitter id, instagram id, twitter username, patreon username,frame,comic_fram',
			clip: ["18", 0],
		},
		class_type: "CLIPTextEncode",
		_meta: {
			title: "CLIP Text Encode (Negative Prompt)",
		},
	},
	8: {
		inputs: {
			samples: ["3", 0],
			vae: ["17", 0],
		},
		class_type: "VAEDecode",
		_meta: {
			title: "VAE Decode",
		},
	},
	9: {
		inputs: {
			filename_prefix: "ComfyUI",
			images: ["8", 0],
		},
		class_type: "SaveImage",
		_meta: {
			title: "Save Image",
		},
	},
	16: {
		inputs: {
			unet_name: "z-image-turbo-fp8-e4m3fn.safetensors",
			weight_dtype: "default",
		},
		class_type: "UNETLoader",
		_meta: {
			title: "Load Diffusion Model",
		},
	},
	17: {
		inputs: {
			vae_name: "ae.safetensors",
		},
		class_type: "VAELoader",
		_meta: {
			title: "Load VAE",
		},
	},
	18: {
		inputs: {
			clip_name: "qwen_3_4b.safetensors",
			type: "lumina2",
			device: "default",
		},
		class_type: "CLIPLoader",
		_meta: {
			title: "Load CLIP",
		},
	},
	34: {
		inputs: {
			width: 304,
			height: 304,
			batch_size: 1,
		},
		class_type: "EmptyLatentImage",
		_meta: {
			title: "Empty Latent Image",
		},
	},
};
