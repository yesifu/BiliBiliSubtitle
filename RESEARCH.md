# 音轨获取与整段识别方案调查

2026-09-07。目标：减少视频转字幕的请求次数与重试浪费，并核实“浏览器缓存 / 最低分辨率 / 独立音轨 / 本地文件整段上传”的可行性。

## 实测结论

1.3 更新（2026-09-07）：已核实[转写接口](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post)的模型枚举为 `FunAudioLLM/SenseVoiceSmall`、`TeleAI/TeleSpeechASR`。[模型列表接口](https://docs.siliconflow.cn/docs/api/models-get)支持 `sub_type=speech-to-text` 和 `sub_type=chat`，插件分别查询，避免把语音合成模型用于转写。[对话接口](https://docs.siliconflow.cn/docs/api/chat-completions-post)明确引用了 DeepSeek-V4-Flash、Pro/deepseek-ai/DeepSeek-V4、Pro/zai-org/GLM-5.2、moonshotai/Kimi-K2.7-Code。预置列表保留原有 Qwen 模型，实际可用范围通过用户账户刷新确认。没有拿用户 Key 请求模型列表或进行付费识别。

1.3 不再暴露切片、并发、超时等高级字段：默认整段直传失败自动切换压缩分段、WAV。测试已用实际 M4A 文件及模拟 HTTP 415 连续验证两次回退成功；未验证真实服务端对该音频的识别质量与耗时。

用户视频 [BV13Q4y1C7hS](https://www.bilibili.com/video/BV13Q4y1C7hS/) 第 1 P 为 `cid=415333708`。B 站详情返回 200 个分 P，P1 页面时长 705 秒。DASH 音轨包含 AAC-LC 三档，接口报告码率约 67 / 133 / 319 kbit/s；这些是编码码率，不是网络下载速度。

最低码率文件为 5,919,506 字节，容器为碎片化 MP4（`ftyp / moov / sidx / moof / mdat`）。两个实际返回的 UPOS 地址完整下载成功，独立测试约 0.29–0.68 秒；主流程一次测量约 0.35 秒。没有证据说明原截图超时发生在哪个接口，旧错误信息丢失了阶段；只能确定在这次测试环境中，获取音轨本身很快。

MP4Box 无转码整理为六段，起点分别为 0、120、240、360、480、600 秒，最后一段 103.9997 秒；总输出 5,902,801 字节。整理约 0.08–0.10 秒。六段均在实际浏览器中解码成功，时长误差小于 0.001 秒。压缩样本没有重新编码，少量体积变化来自封装元数据。

## 方案比较

| 方案 | 判断 | 原因 |
| --- | --- | --- |
| 下载完整视频后提取音频 | 可行但没有必要作为默认 | B 站已提供独立音轨，画面只增加传输量与处理步骤 |
| 下载最低分辨率视频 | 音轨缺失时才值得作为后续回退 | 分辨率主要影响视频流；选择最低码率音轨更直接 |
| 读取 Chrome 已缓存的整个视频 | 不可作为普通 MV3 插件可靠方案 | 没有读取现有 HTTP 磁盘缓存全部响应体的扩展 API；播放器按需缓冲，文件不一定完整 |
| 下载原始独立音轨再整段上传 | 已实现默认路径 | 示例仅 5.65 MiB，一次 multipart 文件上传；省去本地解码和约 29 次小片请求 |
| 压缩音轨按 120 秒分段上传 | 已实现可选路径 | 六次请求，无转码；避免单次长任务，同时保留每段时间边界 |
| 录音文件异步识别 | 精确字幕的可选下一步 | 获取任务 ID 后轮询结果，通常能返回句 / 词时间戳；需另一服务的凭证与文件访问方案 |
| 本地 FunASR / Whisper | 可行，未随本插件安装 | 可直接处理完整文件与时间戳，但需要模型、运行环境与计算资源 |

## 官方接口核实

[硅基流动语音转文本 API](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post) 明确：multipart `POST /v1/audio/transcriptions`，文件不超过 1 小时且不超过 50 MB；列出 `FunAudioLLM/SenseVoiceSmall` 与 `TeleAI/TeleSpeechASR`；返回字段为 `text`。文档没有提供 ASR 任务 ID / 轮询流程，也没有数值化的服务器推理超时保证。

文档明确示例是 MP3，没有完整格式/编解码器表，因此不能从文档断言 M4A 必然被模型端点接受。新版原始 M4A 和分段 M4A 的本地文件有效性、上传流程已经验证；提供商接受情况与真实语音识别耗时尚待用户 Key 实测。格式被拒绝时可选 WAV 兼容模式。

**整段识别的纯文字不包含实际时间戳。** 按全文长度分配 704 秒只能是粗略阅读辅助，不能声称逐句同步。提高客户端超时能避免本地过早中断，无法解决服务端 503 / 504，也不等于提高推理速度。

[阿里云录音文件识别说明](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide) 与 [Paraformer REST API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api) 提供异步提交、任务查询和识别结果。录音文件通过服务可访问的 URL 提供，结果包含句/词起止时间。需要上传文件到可访问存储等额外步骤，不能假定阿里云能直接读取带来源限制的 B 站地址。异步有利于避免一条长 HTTP 推理连接，不保证整体耗时一定更短。

## 下载与缓存资料

- [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)：DASH 独立音轨与格式提取参考。
- [BBDown Parser](https://github.com/nilaoda/BBDown/blob/master/BBDown.Core/Parser.cs) 与 [PCDN 处理](https://github.com/nilaoda/BBDown/blob/master/BBDown/Program.Methods.cs)：主地址、备用地址与端口型 PCDN 的处理参考。新版优先真实返回的常规地址，保留其它线路；不硬编码替换签名 URL 的主机。
- [Chromium browsingData API 源码](https://github.com/chromium/chromium/blob/main/chrome/common/extensions/api/browsing_data.json)：缓存清除接口，不提供任意缓存文件内容读取。
- [Chrome DevTools network 文档源码](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/reference/devtools_network/index.md)：可以取被检查网络请求的响应，早于工具启动的请求可能缺失，不等于磁盘缓存枚举。
- [Chrome HTTP 缓存分区说明](https://developer.chrome.com/blog/http-cache-partitioning)：相同 URL 不保证扩展和站点共享缓存。
- [MP4Box.js](https://github.com/gpac/mp4box.js)：完整 MP4 解析、样本与封装工具；本项目固定打包 2.4.1，BSD-3-Clause。
- [FunASR](https://github.com/modelscope/FunASR)：本地识别、VAD、标点及时间戳方案参考。

本次没有读取用户 API Key，没有实际调用付费识别/翻译接口，没有修改日常浏览器用户目录。网络、整理与模型耗时分别衡量，不能把下载测试速度当成最终字幕生成速度。
