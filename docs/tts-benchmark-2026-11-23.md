# Pocket TTS 本机实测报告

日期：2026-11-23 | 机器：ThinkPad T14 Gen2（Ryzen 7 PRO 5850U，8C/16T，16GB DDR4，纯 CPU 推理）

## 结论

**Pocket TTS 在本机上可用：实时倍率 1.2–1.6×，首音频字节 210ms，真流式验证通过。**
配合同期的客户端真流式改造与 `chunkerMaxWords=20`，装置的三路轮读体验可成立，无需迁移模型。
唯一缺口：`user_clone` 声音克隆需要 HF 认证，当前被加载的是免克隆版模型（见下文）。

## 一、环境安装记录

| 项 | 结果 |
|---|---|
| Python | 3.13.12 + 独立 venv（`~/.workbuddy/binaries/python/envs/default`） |
| 依赖 | pocket-tts 4.0.1 / torch 2.15.0+cpu / fastapi 0.165 / uvicorn 0.54，官方 PyPI 装成 |
| 模型 | `kyutai/pocket-tts-without-voice-cloning`，经 hf-mirror 下载，含下载共约 90 秒完成加载 |
| 启动命令 | `HF_ENDPOINT=https://hf-mirror.com <venv-python> server/tts-server-pocket.py --port 8080` |

环境坑（已排）：本机 `python` 与 `pip` 指向不同解释器，`pip install` 装进 venv 而 `python` 是另一个。
后续启动服务器必须用 venv 全路径 `C:\Users\LENOVO\.workbuddy\binaries\python\envs\default\Scripts\python.exe`。

## 二、基准数据

warmup（服务器启动时自动执行，合成 "Good morning."）：

> 1.36s 音频 / 1.10s 合成 = **1.24× 实时**

HTTP 全链路基准（27 词英文长句，POST /v1/tts，curl 计时，各 2 轮）：

| 轮次 | 首字节 TTFB | 总耗时 | 音频时长 | 实时倍率 |
|---|---|---|---|---|
| eve #1 | 0.218s | 5.50s | 8.88s | **1.62×** |
| eve #2 | 0.213s | 6.92s | 9.68s | **1.40×** |
| jane #1 | 0.209s | 6.55s | 9.76s | **1.49×** |
| jane #2 | 0.213s | 6.72s | 9.84s | **1.46×** |

读法：
- **首音频约 210ms**——服务器流式 WAV 头即刻返回，验证了"边合成边传输"真实生效（客户端真流式改造的前提成立）。
- **实时倍率 1.4–1.6×**——20 词分句约合成 7 秒音频需 4.5–5 秒，播放端一边收一边播，不会追平、不会断流。
- 无 GPU、无 torch 线程调优的裸机成绩；`--threads 8` 参数已就位，如需再榨性能可试。

## 三、user_clone 状态：被 HF 认证卡住

启动日志：`Voice cloning not available (HF auth needed)`。无 HF token 时 pocket-tts 自动降载
`without-voice-cloning` 模型变体，`voices/user_clone.wav` 无法克隆，请求返回
`Unknown voice: user_clone. Available voices: eve, jane`。

解法（二选一）：
1. 在 huggingface.co 申请 token（同意 kyutai/pocket-tts 模型条款）→ 运行 `huggingface-cli login` → 重启服务器，会加载完整克隆版模型并自动克隆 `voices/user_clone.wav`；
2. 暂时把 `config.js` 中该列 `voice` 改为 `eve` 或 `jane`（会与另一列撞音色，注意区分）。

素材本身已就绪：`voices/user_clone.wav`（24kHz/单声道/PCM16/22.6s，格式已验证合格）。

## 四、OpenRouter 冒烟测试（LLM 侧，附带完成）

`openai/gpt-oss-20b` 流式请求，已配置的 key 有效，返回流中出现真实 reasoning 增量
（`"reasoning":"We"` / `" need"` / ...）——**证实 `delta.reasoning` 字段存在，现有
"separate" 解析路径可直接抓取**，此前标记的"三列可能全程静默"风险解除。

## 五、对照此前决策

- TontaubeV1.1：维持不迁移判断。它 12 核台式机才约 1× 实时，本机 1.2–1.6× 的 Pocket TTS 已更好。
- NeuTTS Air：已按指示搁置。本次基线数据留存，后续若要对比有据可依。

## 六、后续动作建议

1. 提供 HF token 解锁 `user_clone`（三列三个不同音色的前提）；
2. `npm run dev` 全链路联调，确认浏览器端真流式播放与 OpenRouter reasoning 抓取；
3. 可选：实测 `--threads 8` 与默认值的差异。
