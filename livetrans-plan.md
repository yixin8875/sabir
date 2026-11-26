# Livetrans 方案文档 v0.4
## 对标 Liveglot：本地优先、开源、非商业的实时双语字幕 + 会话问答

> 版本 v0.4 · 2026-11-24
> 分析对象：https://liveglot.app/zh-hans/ （官网、上手教程、FAQ、如何工作、识别设置页、产品截图）
> **v0.4 变更**：桌面壳改为 **Tauri 2**（Rust 后端承载采集、重采样、VAD、ASR、翻译路由与存储，音频不经过 WebView）；UI 采用 **coss ui**（Base UI + Tailwind v4，MIT）。补充 crate 选型、打包/更新/权限、coss 主题映射与组件对应。
> **v0.3 变更**：翻译与问答改为"本地 + 第三方"双路径；音频与识别仍全程本地；新增 Provider 路由、首用同意、失败回退。
> **v0.2 变更**：按"不做商业化、开源可用"重写，移除买断/授权/支付/试用/遥测/云中转。

---

## 0. 结论先行

**产品契约（四条，不可妥协）：**

1. **音频与识别不出机**：采集、VAD、转录全部在本机；第三方只可能收到"定稿后的文本"，永远收不到音频。
2. **翻译与问答默认本地，可选第三方**：本地引擎开箱即用；第三方仅在用户显式配置并同意后启用，走用户自己的 Key、由客户端直连服务商，不经过我们的服务器。
3. **零账号、零付费、零遥测**：没有登录、没有授权码、没有埋点；第三方产生的费用由用户自行承担。
4. **开源可自建**：MIT（建议）发布，任何人可编译、修改、再分发；模型不打包，按各自许可证下载。

**Liveglot 的本质不是"翻译器"，而是一个"外语直播课的学习闭环工具"：**

```
听得见（采集任意系统声音）
   → 看得懂（逐句定稿后再翻译，带上下文）
   → 问得清（基于本场记录追问刚才没听懂的内容）
   → 留得下（自动生成带时间戳的双语 Markdown 笔记）
```

真正构成差异化的只有两点：

1. **"整句定稿 + 滚动上下文"的翻译策略**——等一句说完、带着前几句一起翻译。译文可读性来自这里。
2. **"只依据本场转录"的侧边问答**——把被动字幕变成主动理解，可右键引用任意一句。

**"本地 + 第三方"要解决的核心矛盾：**

| 路径 | 引擎 | 延迟/句 | 质量 | 成本 | 网络 | 隐私 |
|---|---|---|---|---|---|---|
| 高速本地 | NMT（ONNX opus-mt） | 0.1–0.5 s | 中 | 0 | 无 | 最好 |
| 本地 LLM | Ollama / llama.cpp（3B–14B） | 1.5–8 s | 好 | 0 | 无 | 最好 |
| 第三方 | OpenAI / DeepSeek / OpenRouter / 自定义 | 0.8–3 s | 最好 | 用户自付 | 需要 | 文本外发 |

- 只做本地：8GB 机器要么慢、要么译得糙。
- 只做第三方：违背本地开源定位，断网/无 Key 即不可用。
- **正确做法：三条路径同时存在，按硬件与偏好路由；默认本地高速档，第三方作为"读得更顺"的可选升级。**

**形态结论：**

- **桌面应用用 Tauri 2**：Rust 侧完成"采集 → 重采样 → VAD → ASR → 翻译路由 → 落盘"，WebView 只渲染文本事件。音频不经过 JS，IPC 流量极小。
- **UI 用 coss ui**：Base UI 原语 + Tailwind v4 + shadcn 兼容 token；组件是"复制到项目里"的模式，便于按阅读器气质改造。
- **纯浏览器仍不可行**：系统音频、本地 ASR、Key 安全三项都过不去；官网只做门面。

---

# 一、产品分析

## 1.1 一句话定位

> 一个免费、开源、本地优先的外语直播课字幕与问答工具：默认在本机跑完识别、翻译和问答；想读得更顺，也可以接你自己的第三方模型。

对标 Liveglot 的体验，去掉价格、账号和"必须上云"。

## 1.2 用户与场景

| 场景 | 典型用户 | 痛点 | 产品对应能力 |
|---|---|---|---|
| 付费外语直播课 / Trading Room | 投资者、独立开发者、留学生 | 语速快、术语多、走神一句后面全断 | 实时双语字幕、按句翻译、追问、笔记 |
| YouTube / Twitch 长直播 | 内容学习者 | 平台字幕只有原文、延迟高、不可回溯 | 系统声采集、自动笔记 |
| Zoom / Meet / Teams 网课与会议 | 远程工作者、跨境团队 | 平台自带字幕不翻译或质量差 | 任意应用声源、双语对照 |
| 线下讲座 / 培训室 | 参会者 | 只能录音，回去再整理 | 麦克风采集、Markdown 导出 |
| 隐私敏感 / 无网环境 | 研究者、法务、涉密行业 | 不能把音频传到云 | 音频不出机、本地引擎、离线可用 |
| 有 API Key 的重度用户 | 开发者、AI 从业者 | 本地模型质量不够、想用自己的服务 | 第三方 Provider（直连、自有 Key） |
| Linux 桌面用户 | 开发者 | 商业工具基本不支持 Linux | AppImage / deb / rpm |
| 开源贡献者 | 开发者 | 想改词表、加引擎、做插件 | Rust 适配器、coss 组件、MIT |

**关键洞察：** 用户不是"想翻译"，而是"想在不中断注意力的前提下理解并留下东西"。竞品不是翻译软件，而是"暂停 + 查词 + 回放 + 手记"这套笨拙动作。

## 1.3 功能全景与优先级

按"使用频率 × 不可替代性 × 开源用户价值"打分（满分 10）：

| # | 功能 | 价值 | 优先级 | 说明 |
|---|---|---|---|---|
| 1 | 任意系统声 / 麦克风采集（mac / win / linux） | 10 | **P0** | 不做平台集成；任何能出声的应用都能用 |
| 2 | 本地流式识别 + 临时结果预览 | 9 | **P0** | 说话中先显示灰色预览，让用户"看到在听" |
| 3 | 整句定稿 + 滚动上下文翻译 | 10 | **P0** | 等一句结束再翻，前几句一并给模型；单段 ≤8 秒 |
| 4 | 双语字幕流（时间戳 / 字号 / 暂停） | 9 | **P0** | 原文小字灰色、译文大字深色；可调字号 |
| 5 | 会话持久化 + Markdown 导出 | 8 | **P0** | 每场一个带时间戳的双语 .md，目录可改 |
| 6 | 本地模型管理器 | 9 | **P0** | 下载/校验/续传/复用/量化档位/离线导入 |
| 7 | 零配置引导（硬件档位 + 引擎检测） | 8 | **P0** | 自动推荐模型；检测 Ollama；未装给可复制的安装命令 |
| 8 | 基于本场记录的侧边问答 | 10 | **P1** | 只依据本场转录；引用任意一句；流式输出 |
| 9 | 场景背景 / 术语预设 | 8 | **P1** | 一两句话交代主题、行话，显著提升识别、翻译、问答 |
| 10 | 引擎适配器（sherpa-onnx / whisper-rs / Ollama / llama.cpp / NMT / OpenAI 兼容） | 8 | **P1** | Rust trait；社区可加引擎 |
| 11 | **第三方 Provider 管理** | 9 | **P1** | 多套配置、Base URL、模型、Key、测试连接、首用同意、路由与回退 |
| 12 | 多语言 UI + Linux 打包 | 7 | **P1** | 中文/英文优先；AppImage、deb、rpm |
| 13 | 译文配音（TTS） | 6 | **P2 · 已实现** | 本机 Kokoro v1.1 逐句朗读译文（中英双语，模型按需下载）；音色/语速/落后加速待做 |
| 14 | 笔记库 / 全文检索 | 6 | **P2 · 已实现** | 本机 FTS5 三元组索引跨场次检索原文与译文，bm25 排序 + 命中片段；向量/同义词待做 |
| 15 | 插件 / 脚本接口 | 6 | **P2 · 已实现** | 每场一个 JSONL 事件流；本机脚本可返回改写译文；附带 `livetrans` CLI |
| 16 | 浮标 / 主题 / 置顶 | 5 | **P2** | 原生质感 |

### 为什么第 3 和第 8 条是"灵魂"

- **第 3 条决定"能不能读"**：实时翻译最大的失败不是不准，而是"碎"。英文语序和中文语序不同，半句直译比听原文还累。等句尾 + 带上下文，是把"字幕"变成"可读文本"的关键决策。
- **第 8 条决定"有没有用"**：看直播不可能 100% 专注。走神 30 秒后，用户需要的是"刚才那个关键价位是多少"，而不是从头重听。以转录为唯一事实来源、允许引用某一行，既解决检索，也抑制幻觉。

### 翻译路由（产品核心）

```
用户设置「翻译」用哪条路径：
  A. 本地高速 NMT        → 毫秒级，默认
  B. 本地 LLM（3B/7B）   → 通顺、带上下文
  C. 第三方 Provider     → 质量最好，用户 Key，按量自付

用户设置「问答」用哪条路径：
  1. 本地 LLM
  2. 第三方 Provider（可与翻译不同，如翻译用 DeepSeek、问答用 GPT）

失败回退链（自动，可关闭）：
  第三方 → 本地 LLM（若已配置） → 本地 NMT → 仅显示原文
```

**关键设计：翻译和问答分开配置。** 翻译追求便宜、快；问答追求强。这也对应 Liveglot 的"翻译用便宜模型、聊天用更强模型"。

## 1.4 开源与分发（替代商业模式）

| 维度 | 决策 | 说明 |
|---|---|---|
| 代码许可证 | **MIT（建议）** | 最大采用度；若希望衍生作品也必须开源，选 AGPL-3.0 |
| 模型许可证 | 不打包，按各自许可证下载 | Whisper 权重 MIT、sherpa-onnx Apache-2.0、Silero VAD MIT、Qwen2.5 Apache-2.0、opus-mt CC-BY-4.0；避免 Llama/Gemma 等带额外限制的权重作为默认 |
| UI 许可证 | coss ui MIT | 组件复制进项目后仍保留其许可声明 |
| 分发 | GitHub Releases + 包管理器 | `.dmg` / `.app`、`.msi` / NSIS `.exe`、`.deb` / `.rpm` / `.AppImage`；Homebrew Cask、winget、Scoop、Flathub、AUR 逐步接入 |
| 更新 | `tauri-plugin-updater` + GitHub Releases | 无自建更新服务器；签名密钥随发布流程管理 |
| 模型下载 | Hugging Face + 镜像 + 离线导入 | 断点续传、SHA-256 校验、复用已有文件、手动指定路径 |
| 文档站 | Astro 静态站 → GitHub Pages / Cloudflare Pages | 官网 + 快速开始 + 硬件与模型 + 第三方配置 + 贡献指南 |
| 社区 | CONTRIBUTING、Issue/PR 模板、good first issue、i18n JSON、适配器 trait | 开源项目的"留存"靠贡献路径 |
| 资金 | 可选 GitHub Sponsors / Open Collective | 不设付费墙；钱用于 CI、签名、模型带宽 |
| 品牌 | 自己的名称与图标 | 不使用 Liveglot 名称/Logo/文案 |

**成本结构：**

| 项 | 成本 |
|---|---|
| 服务器 | $0（无后端；文档站静态托管免费） |
| 第三方 API | **用户自付**（产品不经手、不加价、不抽成） |
| CI | GitHub Actions 免费额度；Tauri 三平台原生构建约 20–40 分钟/次 |
| 模型带宽 | Hugging Face / 镜像承担；可提供离线包 |
| 签名公证 | 可选；Apple Developer $99/年；Windows 代码签名另计 |
| 维护 | 主要成本是人的时间，尤其是三平台音频采集代码 |

## 1.5 差异化机会

1. **免费开源替代**：Liveglot $19.99 买断；我们 MIT、零成本、可审计。
2. **隐私边界清晰且可验证**：音频永不出机；第三方只收定稿文本；断网仍可用本地模式。
3. **本地 + 第三方自由组合**：8GB 机器用 NMT 也能跑；有 Key 的用户可接任意 OpenAI 兼容服务。
4. **Tauri 的轻量与性能**：安装包 10–40MB（不含模型），内存占用低于 Electron；音频管线在 Rust，UI 不搬运 PCM。
5. **Linux 一等公民**：商业同类几乎不支持；开源用户高度重合。
6. **coss ui 的可改造性**：组件源码在仓库里，能按"阅读器"气质调整，而不是被组件库锁死。
7. **术语表/场景预设开源可分享**：导入导出 JSON，形成社区词表。
8. **可脚本化**：导出 JSONL 事件流、`livetrans` CLI，方便接 Obsidian/Notion 自动化；脚本插件还能改写译文。

## 1.6 明确不做什么

- **不做 SaaS / 云中转 / 账号体系**：第三方请求从客户端直连。
- **不做支付、授权码、试用期、DRM、设备限制**。
- **不做遥测、崩溃上报、使用分析**（诊断包由用户手动导出）。
- **不做云端 ASR**：音频不出机是契约；Rust trait 保留扩展点，但默认与文档都不提供云识别。
- **不做会议 Bot**：不往 Zoom/Meet 派机器人。
- **不录屏、不存音频**：只处理声音，音频默认不落盘。
- **不做移动端**（初期）。

---

# 二、技术方案

## 2.1 形态决策：Tauri 2 桌面应用 + coss ui

| 能力 | 纯 Web | Tauri 2 |
|---|---|---|
| 麦克风 | ✅ getUserMedia | ✅ Rust（cpal / 平台 API） |
| 系统全局音频 | ❌（macOS 浏览器拿不到） | ✅ ScreenCaptureKit / WASAPI / PipeWire |
| 本地 Whisper / sherpa | ⚠️ WASM/WebGPU，慢且占内存 | ✅ 原生 Rust |
| 本地 LLM | ⚠️ WebLLM 需 WebGPU，模型数 GB | ✅ Ollama / llama.cpp |
| 第三方 API | ⚠️ CORS 受限，Key 暴露在前端 | ✅ Rust `reqwest` 直连，Key 在钥匙串 |
| 音频进 UI | — | ✅ **不进**：Rust 内完成，只发文本事件 |
| 写 Markdown 到任意目录 | ❌（只能下载） | ✅ Rust 直接写 |
| 后台常驻 / 浮标 / 托盘 | ❌ | ✅ 多窗口 + tray |
| 安装包体积 | — | 10–40MB（不含模型） |

**架构：**

```
┌─────────────────────────────────────────────────────────────┐
│  WebView：React 19 + Vite + Tailwind v4 + coss ui (Base UI)  │
│  字幕流 · 聊天(Composer/Chat UI) · 设置 · 模型 · Provider      │
└──────────────▲───────────────────────────┬──────────────────┘
   事件 Channel（partial/final/translation/status/level）│ invoke 命令
┌──────────────┴───────────────────────────▼──────────────────┐
│  Rust Core（src-tauri）                                      │
│  capture → rubato 16k → ring buffer → VAD → ASR              │
│  router → NMT(ort) / local LLM(HTTP) / remote(reqwest)       │
│  SQLite(rusqlite) · Markdown · 模型管理 · keyring · 日志       │
│  tray · 浮标窗口 · updater · 单实例                           │
└──────┬──────────────────┬──────────────────┬─────────────────┘
       │                  │                  │
  系统声/麦克风        Ollama / llama.cpp    第三方 HTTPS
  (SCK/WASAPI/        (127.0.0.1)           (用户 Key 直连)
   PipeWire)
```

**三条硬原则：**

1. **音频不跨 IPC**：PCM 只存在于 Rust；WebView 收到的是 `partial` / `final` / `translation` 文本事件。
2. **第三方请求不跨 WebView**：全部由 `reqwest` 在 Rust 发出，避免 CORS、混合内容与 Key 暴露。
3. **UI 不需要 Web Audio**：采集、混音、重采样、VAD 在 Rust；TTS 合成也在 Rust，只有合成好的 WAV 以 base64 交给 WebView 播放（2026-11-25 实现）。前端只负责显示。

**为什么 Tauri 适合这个产品：**

- 体积与内存：Electron 动辄 100MB+；Tauri 复用系统 WebView（WKWebView / WebView2 / WebKitGTK）。
- 原生管线：重采样、VAD、ASR 都是计算密集且高频，放 Rust 比"JS 里跑 AudioWorklet + WASM"更稳。
- 安全边界：Key、模型、音频都在 Rust 侧，WebView 不接触敏感数据。
- 代价：三平台系统音频采集要写 Rust（Electron 的 `desktopCapturer` 是现成的）。这是本项目最大的工程量，必须在 Sprint 0 先验证。

## 2.2 实时管线（Rust）

```
[采集线程] capture（SCK / WASAPI loopback / PipeWire monitor / cpal mic）
   → 混音（系统声 + 麦克风，各自增益）
   → rubato 重采样到 16k mono f32
   → 环形缓冲
   → VAD（sherpa-onnx VoiceActivityDetector / Silero ONNX）
   → 分段：静音 ≥300ms 或 达到 8s 上限 → 定稿
   → ASR 线程
        ├─ sherpa-onnx OnlineRecognizer（流式，低延迟，临时结果自然）
        └─ whisper-rs / yamabiko-whisper（LocalAgreement-2，准确）
   → 句级事件：partial → 仅预览；final → 锁定
   → 翻译路由器（serial queue）
        ├─ NMT：ort + opus-mt ONNX + tokenizers
        ├─ 本地 LLM：reqwest → Ollama/llama.cpp（SSE/NDJSON）
        └─ 第三方：reqwest（SSE）
        → 失败回退链
   → Channel 推送：translation:delta / translation:done / translation:error
   → SQLite 增量落盘（rusqlite，WAL）
   → 停止：生成 Markdown / JSONL
```

**IPC 事件表（tauri::ipc::Channel）：**

| 事件 | 载荷 | 频率 |
|---|---|---|
| `asr:partial` | `{seq, text}` | 150–300ms |
| `asr:final` | `{segmentId, seq, tStart, tEnd, text}` | 每句 |
| `translation:delta` | `{segmentId, text}` | 流式 token |
| `translation:done` | `{segmentId, route, providerId?, ms}` | 每句 |
| `translation:error` | `{segmentId, code, fallbackTo?}` | 失败时 |
| `engine:status` | `{asr, llm, level, route}` | 1–2Hz |
| `model:progress` | `{id, received, total}` | 下载时 |
| `session:saved` | `{path, durationMs, segments}` | 结束时 |

## 2.3 音频采集（Rust）

| 平台 | 系统声 | 麦克风 | 权限 / 注意 |
|---|---|---|---|
| macOS 13+ | ScreenCaptureKit 音频流（`capture-system-or-process-audio` / `screencapturekit`） | `cpal` | "屏幕与系统音频录制"权限；14.2+ 可改用 Core Audio Process Taps（更轻） |
| Windows 10/11 | WASAPI loopback（`wasapi` / `capture-system-or-process-audio`） | `cpal` / WASAPI | 无需权限；麦克风被拦时打开隐私设置 |
| Linux | PipeWire / PulseAudio monitor source（`pipewire` / `cpal` 选 `.monitor`） | `cpal` | 需选择 monitor 源；Flatpak 需音频 portal |

**可复用参考：**

- `capture-system-or-process-audio`：跨平台 API，自动选择 WASAPI / PipeWire / Core Audio + ScreenCaptureKit，支持 macOS 14.2+ 的进程级 tap。**建议作为首选封装**，在 Tauri command 里启动/停止。
- `tauri-plugin-system-audio`：Tauri 2 插件，但完整管线**仅 Windows**（WASAPI loopback + AEC + 16k mono + level），macOS/Linux 是 mic-only 桩。
- `apecia-org/audio-recorder`：Rust + Tauri 2 的按应用录音参考实现（macOS SCK 进程级 + Windows WASAPI process loopback + cpal 麦克风），架构可直接借鉴。

**实现要点：**

- 采集回调里不做重活：只写入环形缓冲，重采样与 VAD 在独立线程。
- 混音在 Rust 求和并限幅，提供系统声/麦克风两个增益。
- 权限失败要给出可操作提示（打开系统设置、重启应用），不要只报错。
- 音频只在内存；调试录音显式开启且提示。

## 2.4 本地 ASR 选型

| 方案 | 延迟 | 质量 | 说明 |
|---|---|---|---|
| `sherpa-onnx` OnlineRecognizer（Zipformer / Paraformer） | 低 | 中-好 | **推荐默认**：真流式、临时结果连续；同 crate 还带 VAD 与 TTS |
| `whisper-rs`（whisper.cpp 绑定） | 中 | 好 | 准确；块状，需要 VAD 切段；支持 Metal / CoreML / Vulkan / CUDA |
| `yamabiko-whisper` | 中 | 好 | 基于 whisper-rs 的 LocalAgreement-2 流式封装，省去自己写增量策略 |
| `tauri-plugin-whisper-core` | 中 | 好 | Tauri v2 参考实现，含 Silero VAD |
| FunASR / Paraformer（中文强） | 低-中 | 中文好 | 社区适配器 |

**建议路线：**

- MVP：**sherpa-onnx 流式**做默认（跟得上），**whisper-rs** 作为"更准"档位。
- 模型管理：manifest `{id, kind, name, url, mirrors[], sha256, sizeBytes, quant, license, minRamGB}`；断点续传、校验、离线导入、复用已有文件。
- 硬件档位：8GB → 轻量流式；16GB → Large v3 Turbo q5；24GB+ → q8 / medium。
- `sherpa-onnx` 需要预编译库：通过 `SHERPA_ONNX_LIB_DIR` 指定并随安装包分发，或使用其自动下载机制（离线用户需可复用）。
- **ASR 永远是本地**：这是"音频不出机"的边界。

## 2.5 翻译层：本地双引擎 + 第三方（全部在 Rust）

### A. 本地高速 NMT

- `ort`（ONNX Runtime）+ opus-mt ONNX 模型 + `tokenizers`；CPU 上 100–300ms/句。
- 备选：`ct2rs`（CTranslate2 绑定），成熟度低于 ONNX 路线。
- 模型：opus-mt en↔zh（CC-BY-4.0，约 300MB）、M2M100-418M（MIT，多语）。
- 术语表用后处理替换（可选）。

### B. 本地 LLM

- `reqwest` 调 Ollama / llama.cpp / LM Studio，统一 OpenAI 兼容接口（`http://127.0.0.1:11434/v1`）。
- 推荐 Qwen2.5-3B/7B-Instruct（Apache-2.0）、Mistral-7B-Instruct（Apache-2.0）；默认 3B q4。
- 模型常驻预热（`keep_alive`），避免每句冷启动。
- 流式解析 SSE/NDJSON，token 到达即推 Channel。

### C. 第三方 LLM

- `reqwest` 直连任意 OpenAI 兼容 HTTPS；流式 `eventsource-stream` 或手写 SSE 解析。
- 预设（以官方文档为准）：OpenAI、DeepSeek、OpenRouter、SiliconFlow、Moonshot、智谱；本地 Ollama / LM Studio / llama.cpp 为 `scope: local`。
- Key 由 `keyring` 存系统钥匙串；Rust 请求，WebView 不接触 Key 与域名细节（只显示配置）。

### 路由、回退与失败策略

```
TranslationRouter（Rust）:
  provider = profile.translateProviderId
  if provider.scope === 'remote' && !provider.consentAt → 前端弹同意
  try provider
  catch/超时/429/5xx:
    → 本地 LLM（若配置）
    → 本地 NMT
    → 标记 failed，保留原文 + 重试按钮
  连续 3 次失败 / 60s → 熔断，自动回退本地 5 分钟，顶部横幅说明
```

- 流式输出；401/403 立即停并提示 Key 无效；连接拒绝提示本地服务未启动；429 指数退避。
- 超时：第三方 15s、本地 LLM 20s、NMT 3s。
- 成本可见：会话结束显示"本场译文约 X 千 tokens（第三方）"，本地估算。
- Prompt 与 v0.3 相同（只输出译文、保留数字/代码、带上文、术语优先）。

## 2.6 会话问答：本地 + 第三方

**原则：回答只依据本场转录，找不到就说"这场没有提到"。**

| 会话长度 | 策略 |
|---|---|
| < 30 分钟（<600 句） | 全量转录进上下文（按模型上下文预算裁剪） |
| 30 分钟–3 小时 | 最近 200 句 + 关键词检索 Top-K（带时间戳与行号） |
| > 3 小时 / 跨场 | 分块索引（每 20 句一块）+ 邻块扩展（P2 再上向量） |

- Rust 从 SQLite 组装上下文，调用本地/第三方，流式推 Channel。
- 问答 Provider 独立于翻译 Provider；小模型提示"建议 7B 以上或第三方"。
- 回答附 `refs: [segmentId]`，UI 跳转并高亮；引用格式 `[20:23:19]`。
- 第三方问答只发送：转录片段 + 问题 + 引用句 + 场景描述；不发送音频。

## 2.7 数据模型

```ts
Session {
  id, title, startedAt, endedAt,
  source, asrEngine, asrModelId, asrLang, targetLang,
  translateRoute, chatRoute, presetId?, notePath?,
  stats { segments, chars, avgTranslateMs, estTokens }
}
Segment {
  id, sessionId, seq, tStart, tEnd,
  original, translated?,
  status, route?, providerId?, translateMs?, errorCode?
}
ChatMessage { id, sessionId, role, content, refs[], route, model, createdAt }
Preset { id, name, description, glossary[] }
ModelRecord { id, kind, name, path, sizeBytes, sha256, quant?, license, minRamGB? }
ProviderConfig {
  id, name, scope: 'local' | 'remote',
  baseUrl, model, apiKeyRef?, timeoutMs, maxTokens, temperature,
  consentAt?, isDefaultTranslate, isDefaultChat
}
EngineProfile { id, name, asrModelId, translateRoute, translateProviderId?, chatRoute, chatProviderId?, contextLines }
Setting { key, value }
```

- SQLite：`rusqlite`（bundled），WAL；增量写入，崩溃恢复。
- Key 永不进 SQLite：`keyring` crate → macOS Keychain / Windows Credential Manager / Linux Secret Service；库里只存 `apiKeyRef`。
- 导出：Markdown + JSONL + 可选 SRT。

## 2.8 笔记导出

```markdown
# 2026-11-17 20:00 training

- 日期：2026-11-17
- 时长：41:12
- 音源：系统声
- 识别：sherpa-onnx Zipformer（英语）／whisper Large v3 Turbo
- 翻译：DeepSeek deepseek-chat（简体中文）／本地 Qwen2.5-3B
- 问答：本地 Qwen2.5-7B
- 场景：PA Trading Room，讲师讲价格行为与关键价位

---

**20:23:05**
Look at this bar: it closed well above yesterday's high.
看这根 K 线：它收在昨天最高点上方很多。

**20:23:12**
That tells us the buyers are still in control.
这说明买方仍然占据主导。

> 引用：If the pullback holds above 4520...（20:23:19）
```

- 文件名 `YYYY-MM-DD-HHmm-{slug}.md`；默认 `Documents/Livetrans`，设置可改。
- 可选 YAML front matter；未翻译保留原文并标注 `<!-- untranslated -->`。

## 2.9 隐私、安全与数据去向

| 数据 | 去向 |
|---|---|
| 音频 | Rust 进程内存；不落盘、不上传、不进 WebView |
| 转录原文 | 本机 SQLite |
| 翻译请求 | 本地引擎，或用户选定的第三方（仅"定稿文本 + 上文 + 术语 + 场景"） |
| 问答请求 | 本地 LLM，或用户选定的第三方（仅转录片段 + 问题 + 引用句） |
| API Key | 系统钥匙串（`keyring`）；不写日志、不进数据库、不进 WebView |
| 遥测 | **无** |
| 模型下载 | Hugging Face / 镜像（仅下载） |
| 更新检查 | GitHub Releases（可关闭） |

**机制：**

1. **总开关"允许发送到第三方"默认关闭**；关闭时 Provider 列表只显示本地服务。
2. **每个 Provider 首次使用时弹同意框**：写明发送什么文本、不发送音频、目标域名；同意时间记入 `consentAt`。
3. **顶栏常驻路由徽章**：`本地 · NMT` / `本地 · Qwen` / `第三方 · DeepSeek`。
4. **离线自动降级**：第三方置灰，自动回退本地，横幅说明。
5. **日志脱敏**：`tauri-plugin-log` 只记录错误码与时间，不写正文与 Key。
6. **CSP**：WebView 禁止远程脚本；更新与下载全在 Rust。
7. **合规提示**：首次录音提示"请确认已获得在场人员同意"。

**可验证性：** README 提供"断网跑本地模式"步骤；第三方模式下可用防火墙观察仅目标域名被访问。

## 2.10 打包、发布与自动更新（Tauri）

- **构建**：`tauri build`；前端 `vite build`。
- **产物**：macOS `.dmg` / `.app`；Windows `.msi`（WiX）或 NSIS `.exe`；Linux `.deb` / `.rpm` / `.AppImage`。
- **CI**：`tauri-apps/tauri-action` 在 macos / windows / ubuntu 原生 runner 上构建（Tauri 不适合廉价交叉编译）；缓存 Rust target 与 Cargo registry。
- **自动更新**：`tauri-plugin-updater` + GitHub Releases 的 `latest.json` + minisign 签名公钥；可关闭。
- **签名**：macOS codesign + notarization（可选）；Windows Authenticode（可选）。无证书时文档说明 Gatekeeper/SmartScreen 的正确打开方式，**不教关闭安全机制**。
- **Linux 依赖**：WebKitGTK 4.1、libappindicator、librsvg；deb 声明依赖；AppImage 打包；Flatpak 后期提供 manifest（注意音频 portal）。
- **体积**：安装包约 10–40MB（含 sherpa 运行时库，不含模型）；模型另下。
- **合规产物**：`THIRD_PARTY_NOTICES.md`（Tauri、coss ui、sherpa-onnx、whisper.cpp 等）、模型许可证清单、SBOM。
- **已落地（Windows，2026-11-26）**：`tauri-plugin-updater` + `tauri-plugin-process` 接入，`bundle.createUpdaterArtifacts` 打开，公钥内嵌 `tauri.conf.json` 的 `plugins.updater.pubkey`；私钥在仓库外 `%USERPROFILE%\.livetrans\updater.key`（无密码），CI 通过 `TAURI_SIGNING_PRIVATE_KEY` 注入。`.github/workflows/release.yml` 在 `windows-latest` 上依次跑 `scripts/fetch-vendor.ps1`、版本一致性检查、标签/版本比对、`cargo test --lib`，再用 `tauri-action` 构建 `--bundles nsis,msi` 并上传草稿 Release 与 `latest.json`。版本用 `scripts/set-version.mjs` 同步 `package.json` / `tauri.conf.json` / `Cargo.toml`。更新检查只在「设置 → 关于与诊断」手动触发，不做后台轮询。托盘与关闭到托盘见 `tray.rs` / `lib.rs`；日志常开（Info、单文件轮转、上限 4MB）供诊断包截取尾部。当前只发 Windows 产物，macOS/Linux 矩阵等端口完成后再加。

## 2.11 技术栈与仓库结构

| 层 | 选型 | 说明 |
|---|---|---|
| UI | React 19 + Vite + TypeScript | 与 WebView 同源 |
| 样式 | Tailwind v4 + coss ui（Base UI） | 组件复制进仓库；token 走 CSS 变量 |
| 桌面壳 | **Tauri 2**（Rust） | 采集、管线、存储、窗口、更新 |
| 音频采集 | `capture-system-or-process-audio`（首选）/ `wasapi` / `screencapturekit` / `cpal` | 按平台封装成 trait |
| 重采样 | `rubato` | 16k mono f32 |
| VAD | `sherpa-onnx` VoiceActivityDetector / Silero ONNX（`ort`） | 与 ASR 同栈更省依赖 |
| ASR | `sherpa-onnx`（流式）/ `whisper-rs` / `yamabiko-whisper` | trait 适配 |
| NMT | `ort` + ONNX opus-mt + `tokenizers` | 备选 `ct2rs` |
| 本地 LLM | `reqwest` → Ollama / llama.cpp | OpenAI 兼容 |
| 第三方 | `reqwest` + SSE 解析 | Rust 直连，避 CORS |
| 存储 | `rusqlite`（bundled） | WAL、迁移 |
| Key | `keyring` | 三平台钥匙串 |
| 模型管理 | `reqwest` 流式下载 + `sha2` + Range 续传 | 进度走 Channel |
| 日志 | `tauri-plugin-log` | 脱敏 |
| 更新 | `tauri-plugin-updater` | GitHub Releases |
| 窗口 | 多 `WebviewWindow`：主窗 + 浮标 | 透明/置顶/跳过任务栏 |
| 托盘 | Tauri tray | 录音状态 |
| 单实例 | `tauri-plugin-single-instance` | 防止重复录音 |
| 目录选择 | `tauri-plugin-dialog` | 笔记目录 |
| 打开文件 | `tauri-plugin-opener` | 显示笔记 |
| 设置缓存 | `tauri-plugin-store` | 非敏感项 |
| localhost UI（可选） | `axum` 绑定 127.0.0.1 + token | 第二屏 |
| 文档站 | Astro（静态、多语言） | 与 coss 解耦，复用同一套 token |
| i18n | i18next + JSON | 社区可翻译 |
| 测试 | `cargo test` + Vitest + Playwright（前端）；`tauri-driver`（E2E，Linux/Windows） | |
| 发布 | `tauri-action` + GitHub Actions | 三平台矩阵 |
| 代码规范 | Biome（前端）+ `cargo fmt` / `clippy` | |

**仓库结构：**

```
apps/
  desktop/
    src/                  React + coss ui
      components/ui/      coss 组件（复制进来）
      features/           transcript / chat / settings / models / providers
    src-tauri/
      src/
        audio/            capture.rs mix.rs resample.rs ring.rs
        vad/              vad.rs
        asr/              mod.rs sherpa.rs whisper.rs segment.rs
        translate/        mod.rs nmt.rs local_llm.rs remote.rs router.rs
        chat/             context.rs
        store/            db.rs migrations/ notes.rs
        models/           manifest.rs download.rs verify.rs
        providers/        config.rs keyring.rs test.rs
        window/           main.rs pill.rs tray.rs
        ipc/              events.rs commands.rs
      capabilities/       main.json pill.json
      resources/          sherpa libs / notices
      tauri.conf.json
  docs/                   Astro 官网/文档
packages/
  ui/                     共享业务组件（可选）
  shared/                 TS 类型、i18n、provider 预设
scripts/                  模型清单、发布校验
```

## 2.12 性能与可靠性目标

- 首行字幕 P95 ≤ 2.5s；整句译文 P95：NMT ≤3s、本地 LLM ≤6s、第三方 ≤4s。
- 第三方失败自动回退成功率 ≥99%（有本地下限时）。
- 连续 3 小时会话内存增长 <300MB；Rust 侧音频缓冲恒定。
- 崩溃率 <0.5%/会话；崩溃后可从最近落盘点恢复。
- 字幕滚动 60fps；1000+ 行不卡顿（虚拟列表）。
- 冷启动：ASR 模型加载 2–5s；LLM 预热 1–5s；UI 首屏 <1s。
- 资源不足时明确建议换小模型，不静默变慢。

---

# 三、UI 方案

## 3.1 设计定位

**"一张会生长的纸"，而不是"一个控制台"。**

- 主角色是**文字**：原文是安静的注脚，译文是正文。
- 控件退后：只在需要时出现。
- 情绪：安静、可信、专注；纸感米白 + 墨色 + 一点青蓝。
- 一句话原则：**用户 90% 的时间在左边读，10% 的时间在右边问。**
- 开源附加原则：**路线透明**——当前用什么引擎、走本地还是第三方、每句花了多久，一眼可见。

## 3.2 coss ui 主题接入

**coss ui 的机制（据其官方文档）：**

- 基于 **Base UI** 原语，**Tailwind CSS v4**，组件以 shadcn 方式复制进项目。
- token 与 shadcn/ui 同构，额外提供 `--destructive-foreground`、`--info(-foreground)`、`--success(-foreground)`、`--warning(-foreground)`。
- 边框采用**不透明 alpha 边框 + 底部阴影**制造清晰对比；不建议换成普通实色边框，否则会破坏其视觉深度。
- 需要 **Base UI 的 portal 隔离**：应用根容器加 `isolation: isolate`，否则 Dialog/Popover/Select 可能与内容层叠冲突。
- 字体变量：`--font-sans`、`--font-heading`（默认别名到 sans）、`--font-mono`；`@coss/style` 默认装 Inter + Geist Mono。

**初始化（Vite + React）：**

```
pnpm dlx shadcn@latest init @coss/style
pnpm dlx shadcn@latest add @coss/ui
```

> 若 CLI 对 Vite 的 `@coss/style` 预设有差异，退路是：把 `@theme inline` 与 `:root/.dark` token 直接粘进 `globals.css`，再按需复制组件源码。coss 文档明确支持手动方式。

**我们的 token 覆盖（保持 coss 的 alpha 边框策略）：**

| coss token | Light | Dark |
|---|---|---|
| `--background` | `#FBFAF7` | `#121316` |
| `--foreground` | `#17181C` | `#E8E9EC` |
| `--card` / `--popover` | `#FFFFFF` | `#1C1E23` |
| `--primary` | `#17181C` | `#F2F2F0` |
| `--primary-foreground` | `#FBFAF7` | `#121316` |
| `--secondary` / `--muted` / `--accent` | `rgba(23,24,28,.04)` / `.04` / `rgba(43,111,128,.10)` | `rgba(255,255,255,.04)` / `.04` / `rgba(143,208,221,.14)` |
| `--muted-foreground` | `#6B6A66` | `#9A9CA3` |
| `--accent-foreground` | `#2B6F80` | `#8FD0DD` |
| `--border` / `--input` | `rgba(23,24,28,.09)` / `.12` | `rgba(255,255,255,.08)` / `.10` |
| `--ring` | `#2B6F80` | `#8FD0DD` |
| `--destructive` | `#C4453C` | `#E06A60` |
| `--radius` | `0.875rem`（14px） | 同 |

**globals.css 覆盖片段：**

```css
@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-destructive: var(--destructive);
  --color-info: var(--info);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --font-sans: var(--font-sans);
  --font-heading: var(--font-sans);
  --font-mono: var(--font-mono);
}

:root {
  --radius: 0.875rem;
  --background: #fbfaf7;
  --foreground: #17181c;
  --card: #ffffff;
  --popover: #ffffff;
  --primary: #17181c;
  --primary-foreground: #fbfaf7;
  --secondary: rgba(23, 24, 28, 0.04);
  --muted: rgba(23, 24, 28, 0.04);
  --muted-foreground: #6b6a66;
  --accent: rgba(43, 111, 128, 0.10);
  --accent-foreground: #2b6f80;
  --border: rgba(23, 24, 28, 0.09);
  --input: rgba(23, 24, 28, 0.12);
  --ring: #2b6f80;
  --destructive: #c4453c;
  --info: #3b6fb0;
  --success: #2f7d5a;
  --warning: #b8791f;
  --font-sans: Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    "Noto Sans CJK SC", sans-serif;
  --font-mono: "Geist Mono", "JetBrains Mono", ui-monospace, monospace;
}

.dark {
  --background: #121316;
  --foreground: #e8e9ec;
  --card: #1c1e23;
  --popover: #1c1e23;
  --primary: #f2f2f0;
  --primary-foreground: #121316;
  --secondary: rgba(255, 255, 255, 0.04);
  --muted: rgba(255, 255, 255, 0.04);
  --muted-foreground: #9a9ca3;
  --accent: rgba(143, 208, 221, 0.14);
  --accent-foreground: #8fd0dd;
  --border: rgba(255, 255, 255, 0.08);
  --input: rgba(255, 255, 255, 0.10);
  --ring: #8fd0dd;
  --destructive: #e06a60;
  --info: #7fb0e8;
  --success: #6cc59a;
  --warning: #e0b062;
}
```

**根容器（Base UI portal 隔离）：**

```tsx
<body className="relative">
  <div className="isolate relative flex h-svh flex-col">
    <App />
  </div>
</body>
```

**排版：**

- 正文 17px / 1.6；字幕原文 14px muted；译文 17px text；时间戳 12px mono。
- 按钮沿用 coss 的 Button；主按钮胶囊化（`rounded-full`），Card 用 `--radius`。
- 标题 `letter-spacing: -0.02em`，CJK 归零。
- 对话框标题默认用 `--font-heading`，中文场景别名到 sans 即可。
- 字体：Inter 走 `@coss/fonts`；中文用系统字体（PingFang SC / 微软雅黑 / Noto Sans CJK），**不随包分发 CJK 字体**（体积大）。

## 3.3 信息架构

**官网/文档站（Astro，复用同一套 token）：**

```
/                  首页（主张 + 截图 + 三步 + 本地/第三方说明 + 下载）
/features          功能详解
/quickstart        快速开始（安装、权限、模型、Ollama、第三方配置）
/models            硬件与模型推荐（8/16/24/32GB）
/providers         第三方服务配置与隐私边界
/privacy           本地方案说明（音频不出机、断网可验证）
/faq /roadmap /contributing /changelog /download
```

**应用内：**

```
主界面
 ├─ 顶栏：标题 + 状态 · 声源 · 语言对 · 路由徽章 · 设置 · 聊天开关
 ├─ 字幕流（主区）
 │   ├─ SegmentBlock（时间戳 / 原文 / 译文 / 引用 / 重试 / 耗时）
 │   └─ InterimRow（灰底 + Spinner + 预览）
 ├─ 聊天侧栏（coss Composer / Chat UI）
 ├─ 底栏：时钟 · 笔记文件名 · 字号 · 翻译档位 · 暂停/结束
 └─ 浮标窗口（可选）：录音状态
设置（coss Dialog / Sheet + Tabs）
 ├─ 识别 · 翻译与问答 · 第三方服务 · 模型管理
 ├─ 配音 · 记录 · 场景背景 · 外观 · 关于与开源
```

## 3.4 主界面规格

```
┌──────────────────────────────────────────────────────────────┐
│ ● 实时翻译  实时   [系统声▾] [英语→简体中文] [本地·NMT▾] ⚙ 💬 │ 56px
├───────────────────────────────────────┬──────────────────────┤
│ 20:23:05                              │ 聊天            ⟳  ✕ │
│ Look at this bar...                   │                      │
│ 看这根 K 线...                         │  ┌────────────────┐  │
│                                       │  │ 他说的关键位是多少？│ │
│ 20:23:12                              │  └────────────────┘  │
│ That tells us...                      │  ┌────────────────┐  │
│ 这说明买方仍然占据主导。                 │  │ 讲师在看 4520…   │  │
│                                       │  └────────────────┘  │
│ ┌───────────────────────────────┐     │                      │
│ │ 20:23:19  💬                  │     │  ┌ 引用 · 20:23:19 ┐ │
│ │ If the pullback holds...      │     │  └────────────────┘ │
│ │ 如果回调守在 4520 上方…        │     │  ┌────────────────┐  │
│ └───────────────────────────────┘     │  │ 基于本场记录提问… │  │
│                                       │  └────────────────┘  │
│ ◌ 正在识别语音…                        │  Enter 发送 · ↑ 上一条│
│ So be patient and let the market...   │                      │
├───────────────────────────────────────┴──────────────────────┤
│ 23:41 📁 2026-11-17-2000-training.md A- 100% A+ 本地·NMT 暂停 结束│
└──────────────────────────────────────────────────────────────┘
```

- 左区约 72%（聊天可折叠）；底栏"翻译档位"是高频开关。
- 顶栏路由徽章 hover 显示 Provider、域名、平均耗时、已发送文本量。
- 浮标：Tauri 第二窗口，60×28，透明、无边框、置顶、跳过任务栏；Linux 下透明效果需降级测试。

### 句子块状态

| 状态 | 视觉 |
|---|---|
| 临时 | coss Skeleton/浅色块 + Spinner + "正在识别语音…" |
| 待翻译 | 原文正常色，译文位置 Skeleton |
| 已翻译 | 原文 muted，译文 text；hover 显示耗时与路由 |
| 被引用 | `--muted` 底色 + 引用图标 |
| 翻译失败 | destructive 细边 + "重试"；回退时标注"已回退本地" |
| 朗读中 | 左侧 2px accent 竖条 |

## 3.5 关键交互

| 交互 | 规格 |
|---|---|
| 自动滚动 | 新句滚动到底；手动上滑暂停，出现"回到最新" |
| 引用 | coss ContextMenu：引用到聊天 / 复制原文 / 复制译文 / 复制双语 |
| 字号 | A- / 100% / A+；快捷键 `⌘/Ctrl + - / =` |
| 档位 | 底栏 coss SegmentedControl：本地·NMT / 本地·LLM / 第三方 |
| 首用第三方 | coss Dialog：发送文本 / 不发音频 / 目标域名 / 计费提醒 |
| 回退 | 顶部 Alert："已回退本地 · 5 分钟内不再尝试"，可手动恢复 |
| 暂停 | 停止采集保留会话；继续续写 |
| 结束 | 生成 Markdown + Toast："已保存到 …（打开 / 显示文件夹）" |
| 聊天 | coss Composer：Enter 发送、Shift+Enter 换行、↑ 上一条 |
| 命令面板 | coss Command：`⌘/Ctrl+K`，搜句子、切引擎、开设置 |
| 快捷键 | Space 暂停/继续；Esc 取消引用 |
| 置顶 | 顶栏 Toggle；浮标可选 |

## 3.6 引导流程（3 步）

```
第 1 屏：听什么？
   [系统声] [麦克风] [两者]（coss ToggleGroup / SegmentedControl）
   → 权限卡片（macOS 含"重启应用"）

第 2 屏：用哪个识别？
   自动检测内存：
     8GB  → 推荐流式轻量模型
     16GB → 推荐 Large v3 Turbo q5
     24GB+→ q8 / medium
   [下载] 进度 / [选择已有模型文件] / [稍后]

第 3 屏：翻译与问答用哪条路？
   翻译：
     ● 本地高速 NMT（推荐，免配置）
     ○ 本地 LLM（检测到 Ollama ✓ → 推荐 Qwen2.5-3B → [拉取]）
     ○ 第三方 API（更快更顺；需自己的 Key；只发送文本，不发送音频）
   问答：跟随翻译 / 单独配置 / 暂不启用
   → [开始第一场]
```

- 第三方选项旁常驻："音频不会离开本机；仅定稿文本会发送到 api.xxx.com"。
- 连接测试给出具体错误（端口拒绝、模型不存在、Key 无效、地区不可用）。

## 3.7 状态设计

| 状态 | 设计（coss 组件） |
|---|---|
| 首次权限 | Alert + 引导卡片；macOS"重启应用" |
| 模型下载 | Progress + 可关闭设置窗；镜像/校验 |
| 下载失败 | Alert + 换镜像 + 手动导入 |
| 模型加载 | 顶部细条 + Spinner，2–5s |
| Ollama 未启动 | Badge（warning）+ 命令复制 |
| Key 缺失/无效 | Provider 标红 + "去配置"；不影响本地 |
| 首用同意 | Dialog（数据去向） |
| 第三方限流/超时 | 句子 destructive 边 + 自动回退 + Alert |
| 回退生效 | 路由 Badge 变"已回退" |
| 识别断开 | Badge 变黄 + 重连提示 |
| 离线 | 第三方置灰并说明 |
| 内存不足 | 明确建议换小模型 |
| 空会话 | coss Empty + 三步图示 |
| 保存完成 | Toast |

## 3.8 组件对应（coss ui）

| 需求 | coss 组件 |
|---|---|
| 顶栏按钮/图标 | Button（ghost/outline）、Tooltip |
| 路由徽章 | Badge（success/warning/info） |
| 声源/档位 | SegmentedControl、ToggleGroup |
| 语言/模型/Provider 选择 | Select、Combobox、Autocomplete |
| 字幕卡片/面板 | Card、Frame、Group、Separator |
| 字幕滚动 | ScrollArea + 虚拟列表（TanStack Virtual） |
| 右键引用 | ContextMenu |
| 聊天 | Composer、Chat UI、Textarea、Avatar |
| 设置 | Dialog（桌面）、Sheet（窄窗）、Tabs、Field、Fieldset、Form |
| Provider 表单 | Input、Input Group、Label、Switch、RadioGroup、NumberField |
| Key 输入 | Input + 显示/隐藏 Toggle + 复制按钮 |
| 模型下载 | Progress、Meter、Skeleton、Spinner |
| 删除确认 | AlertDialog |
| 空态/错误 | Empty、Alert |
| 提示 | Toast、Tooltip、Kbd |
| 命令面板 | Command |
| 日志/诊断 | Collapsible、Accordion |

> 业务组件一律包在 coss 原语上；不要再手写一套 Button/Input。

## 3.9 动效与无障碍

- 150ms hover、200ms 折叠、250ms toast；尊重 `prefers-reduced-motion`。
- 新句 4px 上移 + 渐入，不做打字机。
- 对比度：正文 ≥7:1，muted ≥4.5:1；焦点环用 `--ring`。
- 键盘：coss/Base UI 自带焦点管理；字幕区 `↑/↓` 逐句、`Enter` 引用。
- 屏幕阅读器：新句 `aria-live="polite"` 可关闭；临时结果不播报。
- 字号调节缩放全站字号。

## 3.10 官网设计要点

- 首屏：主张 + 真实截图 + 双下载 + `MIT` / `音频不出机` / `Tauri` / `Linux` 徽章。
- 第二屏：功能三卡；第三屏：三步开始。
- 第四屏：**数据边界图**（音频 → 本机；文本 → 可选第三方）。
- 第五屏：硬件与模型推荐表。
- 第六屏：FAQ。
- 页脚：快速开始、模型、第三方、隐私、路线图、贡献、GitHub。
- 官网用 Astro + 同一套 CSS token；coss 是 React 组件，如需复用可做 React island，但不必强行引入。

---

# 四、落地计划

## 4.1 里程碑（开源节奏）

| 阶段 | 周期 | 目标 | 验收 |
|---|---|---|---|
| **Sprint 0 · 技术验证** | 2 周 | Tauri 2 三平台采集 → rubato/VAD → sherpa 流式 → NMT/本地 3B/第三方 → coss 字幕 UI | 一小时直播：首行 ≤2.5s；NMT ≤3s；本地 3B ≤6s；第三方 ≤4s；三平台至少各跑通一次 |
| **v0.1 MVP** | 5 周 | 桌面闭环：采集、识别、三路翻译、Provider、字幕、SQLite、Markdown、模型管理、3 步引导 | 20 名内测（含 8GB 机器 + 第三方用户）完成 ≥30 分钟课程；崩溃 <1% |
| **v0.2 · 问答与分发** | 3 周 | 问答（本地/第三方）、引用、场景预设、术语表、Linux 包、中英 i18n | 问答有依据率主观 ≥80%；AppImage/deb 可装 |
| **v0.3 · 扩展** | 3 周 | TTS、笔记库、SRT/JSONL、插件事件流、whisper 档位 | 配音追速可控；跨场检索可用 |
| **v1.0 · 稳定** | 4 周 | 签名说明、CI 矩阵、性能优化、文档站、CONTRIBUTING、许可证 | 三平台一键安装；发布流程可复现 |

### Sprint 0 实施记录（2026-11-24，Windows 11）

`apps/desktop` 已经是一个可编译运行的骨架：Tauri 2 + React 19 + Vite 8 + Tailwind 4 + coss ui（Base UI）。Rust 侧 `src-tauri/src/engine.rs` 接好了 WASAPI 回环采集与 sherpa 流式识别，前端完成三栏字幕台、亮/暗主题和浏览器演示源。

实测结论：

- **sherpa-onnx 2.0.3 不需要 CMake。** 构建脚本取预编译库，本机没有 cmake/clang/ninja 也能编过。但 Windows 的静态库是 `/MT` 运行时，直接链进 `/MD` 的 Rust 程序会出现一批 CRT 符号未解析（实测 41 个）；改用 `default-features = false, features = ["shared"]`（`shared-MT` DLL 自带 CRT）后链接通过。发布包需要把 `onnxruntime.dll`、`sherpa-onnx-c-api.dll` 等一起带上，这一步待补。`whisper-rs` 仍依赖 CMake，留到 v0.3 的 whisper 档位再引入。
- **坏代理会卡住构建脚本。** 本机系统代理是 `127.0.0.1:12000`，`ureq` 走它会连不上 GitHub。把 `sherpa-onnx-v2.0.3-win-x64-static-MT-Release-lib.tar.bz2` 放进 `src-tauri/vendor/sherpa/`，由 `src-tauri/.cargo/config.toml` 设 `SHERPA_ONNX_ARCHIVE_DIR`，构建即可离线复现；`cargo add/fetch` 时需清空 `HTTP(S)_PROXY`。
- **模型**：`sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` 的 int8 encoder（174MB）、decoder、joiner、tokens 已解压到 `apps/desktop/models/`，并在 `tauri.conf.json` 里声明为打包资源；开发态由 `CARGO_MANIFEST_DIR/../models` 自动发现，也可用 `LIVETRANS_MODEL_DIR` 覆盖。
- **采集路径已落地**：`wasapi` 取默认 Render 端点，用 `Direction::Capture` + `EventsShared { autoconvert: true }` 打开回环，直接请求 16kHz 单声道 f32，省掉 rubato 这一层；Rust 只把电平（RMS/峰值）和句子文本经 `tauri::ipc::Channel` 发给 WebView，音频不出 Rust。
- **前端**：coss 初始化成功；TypeScript 7 已移除 `baseUrl`，`paths` 相对 tsconfig 生效；`geist` 不再导出 CSS，改用 `@fontsource-variable/geist-mono`；开发端口改为 5180（本机 5173 被另一个项目占用）。
- **已验证**：`pnpm build`、`cargo build` 均通过；浏览器预览下亮/暗主题、空态、逐字上屏、CJK 排版、电平条正常；桌面窗口里用系统语音朗读中英文、并叠加本机正在播放的音频，真实跑出了整句中英文字幕。该双语模型词表全大写，Rust 侧已做「句首大写、其余小写」归一化。
- **待验证**：端点切句阈值（当前 2.4s 静音）在一小时长会话中的手感与漂移；macOS（ScreenCaptureKit）和 Linux（PipeWire）采集尚未实现；翻译与问答仍是下一阶段；发行版还需要补 DLL 打包与签名。

### 里程碑 1 实施记录（2026-11-25，Windows 11）

句子级翻译已经接在识别链路后面：`Final` 事件同时进入 `TranslateService` 的串行队列，译文通过同一个 Channel 以 `translationDelta` / `translationDone` / `translationError` 推送；前端在原文下方渲染译文、耗时、路由与「已回退本地」标记，失败行带重试。

实测结论：

- **本地 NMT（opus-mt en→zh，int8 ONNX）可用。** `Xenova/opus-mt-en-zh` 的 encoder / decoder / decoder_with_past 三张图加 `tokenizer.json` 放在 `models/translate/en-zh/`；`cargo test translate::nmt` 通过，示例句输出「大家早安,今天课开始」。两个坑：tokenizer.json 的 Precompiled normalizer 带 `null` 的 SentencePiece charsmap，Rust `tokenizers` 直接拒绝加载，加载时替换为 NFKC；`decoder_with_past` 只回吐 decoder 的 KV，encoder 交叉注意力 KV 必须从首步缓存原样带上。
- **ort 依然不能静态链接。** 预编译 ONNX Runtime 是 `/MT`，与 `/MD` 的 Rust 二进制冲突（实测 42 个 CRT 符号）。改用 `ort` 的 `load-dynamic`，运行时 `init_from(vendor/onnxruntime/onnxruntime.dll)`；本机 1.28.2 的 DLL 可加载，发布包需要把它放到安装目录（`tauri.conf.json` 已映射）。
- **路由与回退**：默认本地 NMT；可切本地 LLM（OpenAI 兼容，默认 `127.0.0.1:11434/v1`）或第三方（HTTPS + 用户 Key）。链路 remote → local LLM → NMT；第三方连续 3 次失败熔断 5 分钟；中文句子直接跳过（`passthrough`），避免中译中。
- **授权与 Key**：第三方首次启用必须显式勾选，`remote_consent_at` 记录版本与时间；Key 只在 Rust 侧读取并放进请求头，WebView 只看得到 `apiKeySet` 布尔值。设置写在 `%APPDATA%/app.livetrans.desktop/settings.json`，Key 在系统钥匙串。
- **前端**：右上齿轮与底栏路由徽章打开设置 Sheet；行内显示译文与 `本地 NMT · 0.5s` 徽章；浏览器演示源同样发出翻译事件，已验证亮/暗主题与同意闸门（未同意时测试/保存禁用）。
- **已验证**：`cargo test translate::`（NMT + SSE 解析）、`pnpm build`、`pnpm tauri dev` 可启动；浏览器预览中原文/译文对照、中文跳过、路由芯片正常。
- **发布包已验证**（同日追加）：NSIS/MSI 均出包（475MB / 528MB），静默安装到本机后从安装目录启动，Ctrl+M + 系统 TTS 播放四句英文，字幕逐句收束并全部给出本地 NMT 译文。顺带发现 sherpa 的 `sherpa-onnx-c-api.dll` / `cxx-api.dll` 没有进安装器（只映射了 `onnxruntime.dll`），已补进 `tauri.conf.json` 并从 vendor 压缩包解到 `vendor/sherpa/`；重打包后安装目录根下 `app.exe`、`onnxruntime.dll`、两个 sherpa DLL 与 `models/` 齐全。
- **仍待验证**：NMT 单句延迟与一小时长会话的内存只做了冒烟；安装器未签名（SmartScreen 提示）；macOS/Linux 的采集与打包。

### 识别模型管理（同日追加）

识别模型不再随安装包分发，改为应用内下载与管理：

- 新增 `asr_models.rs`：模型目录（中英双语 ~190MB / 英文 ~69MB / 中文轻量 ~30MB，来自 `hf-mirror.com` → `huggingface.co`，可用 `LIVETRANS_MODEL_BASE` 覆盖）、断点续传下载（`.part` + Range，逐文件校验大小）、`asr.json` 设置（`{ "model": <id 或绝对目录>, "language": "auto", "threads": 2 }`）、模型删除；权重落在 `%APPDATA%\app.livetrans.desktop\models\asr\<id>\`。
- 引擎改为通过 `AsrService::engine_model()` 解析目录与线程数，目录内按 `encoder*.onnx` / `decoder*.onnx` / `joiner*.onnx` / `tokens.txt` 发现文件（编码器与 joiner 优先 int8）；未选模型时启动返回 `no_asr_model` 前缀错误，前端直接打开识别页。
- 设置从右侧抽屉换成带左侧导航的窗口：识别（模型下载/选择/浏览/重新扫描/线程数/自定义目录）与翻译与聊天（原有翻译设置搬入）。未选模型时 Listen / Ctrl+M 打开识别页，管线 Speech 行显示缺模型。
- 云端识别**不做**：音频与识别永远在本机，这是产品契约，不随竞品设置项照搬。
- 待验证：安装包首次启动的空状态与真实下载流程（后端下载已用 `downloads_zh_14m_from_mirror` 测试过 31MB 全流程）；下载中断后的续传；大模型下载时长与进度手感。

### Whisper 整段识别（同日追加）

按用户要求补上竞品列表里的两个 Whisper 模型：

- 目录新增 `whisper-turbo`（`csukuangfj/sherpa-onnx-whisper-turbo`，int8 encoder 674.7MB + decoder 361.1MB + tokens ≈ 1.04GB）与 `whisper-small`（同名 small 仓库，112.4MB + 262.2MB + tokens ≈ 375MB）。模型定义增加 `kind`（streaming / whisper），设置页对 Whisper 显示「整段识别」徽章。
- 文件发现改为按角色在文件名里查找（Whisper 文件带 `turbo-` / `small-` 前缀）；有 joiner 判为流式，无 joiner 且能找 `*-tokens.txt` 判为 Whisper。镜像探测改用各模型自己的 tokens 文件，不再硬编码 `tokens.txt`。
- 引擎新增 `whisper_loop`：Silero VAD（`silero_vad.onnx` 643KB，随安装包分发，`vendor/vad/` → 安装目录根）按 0.55s 静音切句，每段用 `OfflineRecognizer` 整句解码（`task=transcribe`，语种 auto→不指定），只出定稿、不出 partial；停止时 `vad.flush()` 收尾。状态栏提示「Whisper 整段识别：说完一句、停顿后出字」。
- **已验证**：单元测试（流式/Whisper 目录发现、设置往返）；真实下载 Whisper Small（375MB，`downloads_whisper_small_from_mirror`）；`whisper_decodes_the_sample_clip` 用仓库 `models/0.wav` 解码出「昨天是 MondayToday is 禮拜二…」，VAD 能切出语音段。
- 测试环境坑：本机 `C:\Windows\System32\onnxruntime.dll` 是旧版（只支持 IR 1–10），`cargo test` 的测试 exe 在 `target/debug/deps/` 下会先命中 system32，导致加载失败；把 `vendor/onnxruntime/onnxruntime.dll` 复制进 `deps/` 即可。安装版可执行文件旁就有 1.28.2，不受影响。
- 限制：预编译 sherpa 运行库只有 CPU provider，暂不支持显卡加速（竞品界面写的 GPU 加速这里做不到）；Turbo 每句停顿后约有 1 秒解码延迟。语种目前固定「自动识别」，`asr.json` 的 `language` 已接通 Whisper 的 language 参数，界面选择器后续再补。

### 翻译模型也改成按需下载（同日追加）

用户要求「所有模型不要打包进安装包，都采用设置中手动下载，模型可以下载到指定目录」，翻译设置参照竞品布局重排：

- `tauri.conf.json` 不再映射任何模型权重，只留运行时 DLL 与 `silero_vad.onnx`；安装包从约 365MB 掉到运行时大小（翻译用的 421MB NMT 不再内嵌）。
- 抽出 `download.rs`（镜像探测、分段续传、大小校验），识别与翻译共用。新增 `translate/models.rs`：opus-mt en→zh 包 5 个文件（encoder 52.7MB / decoder 192.7MB / decoder_with_past 189.4MB / tokenizer / config，共 441,177,157 字节），下载到 `<模型根>/en-zh`。
- 设置新增 `modelsRoot`（识别与翻译各自可改下载位置，默认 `%APPDATA%\...\models\{asr,translate}`）与 `targetLang`（zh-Hans / zh-Hant / en；NMT 只支持简体，其他目标走 LLM 提示词）。`EndpointSettings` 增加 `name`，路由芯片显示预设名。
- 翻译页重排：翻译成（NMT 时锁定简体中文）、不翻译只记录原文、翻译配置（三条路线保留卡片）、本地 NMT 的模型卡片（下载/取消/删除/进度/下载位置/浏览/重新扫描）、第三方快速填写（OpenAI / DeepSeek / OpenRouter）、本地快速填写（Ollama / LM Studio）、名称/模型/接口地址/API Key + 测试连接、上文句数、失败回退、测试一句。按产品契约未加竞品的云端识别/多配置档与聊天配置分档（问答后端尚未接通）。
- **已验证**：`downloads_the_nmt_package`（421MB 实际下载 47.9s，文件大小与目录校验通过）；`empty_directory_is_not_installed`；前端 `tsc -b`；浏览器预览确认三种路线的布局与模型卡片渲染。
- **安装版实测（同日）**：新安装包 NSIS 10.46MiB / MSI 14.99MiB（旧版约 365MB），MSI File 表只有 app.exe、onnxruntime.dll、sherpa 两个 DLL、silero_vad.onnx，无任何权重。静默装到 `D:\Livetrans` 后：清空 `asr.json` 启动 → Ctrl+M 直接打开 **设置 → 识别** 并显示「还没有可用的识别模型」，同目录残留的旧 `models\` 不被引用；恢复 `asr.json`（whisper-small）后 Ctrl+M 用 Whisper Small 听写三句英文（TTS 播放），字幕逐句出、译文报「无法连接 11434」——因为 NMT 未装，回退到默认 Ollama 地址，证明按需下载的路由生效；再把下载好的 NMT 包放进 `%APPDATA%\...\models\translate\en-zh` 重启，三句全部离线译出简体中文。管线 Speech 行原先写死「Zipformer streaming」，已改为按所选模型的 `kind` 显示「Whisper 整段」/「Zipformer streaming」。
- 仍待验证：在安装版界面里点「下载」（与测试共用 `download.rs` 同一路径）、下载中断续传、以及超时/镜像切换的界面提示。

### Sprint 1 P0 补齐（2026-11-25，Windows 11）

按「还有哪些功能没开发 → 先做P0」，补上四项离日常可用最近的缺口：

- **会话持久化 + 导出**（`store.rs`）：`%APPDATA%\app.livetrans.desktop\livetrans.db`，WAL。`sessions(id, started_at, ended_at, title, source, asr_model, translate_route)`、`segments(session_id, seq, start_ms, end_ms, original, translated, route, provider, translate_ms, error)`。`Engine::start` 建会话行、`stop` 写 `ended_at`；独立 `livetrans-store` 写线程在事件去 UI 之前先落库（`Final`、`TranslationDone`、`TranslationError`）。`export_session` 写 `Documents\Livetrans\livetrans-<标题>.<md|jsonl|srt>`，没给 id 时取最近一场。前端字幕栏「导出」下拉三种格式。
- **零配置引导**（`environment.rs`）：探测物理内存（`GetPhysicallyInstalledSystemMemory`）、核心数、Ollama（`GET /api/tags`，~800ms 超时、no_proxy）。内存 <8GB 推荐 `zh-14m`，否则推荐中英双语 Zipformer。识别页顶部在未就绪时给出该卡片，翻译页本地 LLM 卡片显示「Ollama 已连接」或安装提示。
- **音频源选择**（`audio.rs`）：`audio.json` 存 `{ source, device }`；WASAPI 设备枚举（Render/Capture 两向），系统声音走默认或指定 Render 端点的回环，麦克风走 Capture 端点（无 keepalive 静音）。设置页两张卡片 + 设备下拉。契约不变：音频只在 Rust 进程内。
- **字幕显示控制**：字号 13–24（localStorage `livetrans-caption-size`）、`Ctrl+P` 暂停/继续（capture 线程继续读包但丢弃，会话与字幕保留）、顶栏图钉置顶（`set_always_on_top`）。
- **已验证**：`cargo test --lib` 12 通过 / 4 忽略（联网用例）；`tsc --noEmit` 无错；浏览器预览确认音源卡片与设备列表、字号缩放与持久化、导出菜单、暂停徽章与冻结计时。
- **安装版实测（同日）**：NSIS 11.24MiB / MSI 15.96MiB（新增 rusqlite/chrono），静默装到 `D:\Livetrans`。启动即建 `livetrans.db`；Whisper Small 听写三句后库里出现 `sessions` 行（`source`/`asr_model`/`translate_route`=nmt）与三条 `segments`（NMT 逐句译文、`translate_ms` 1364/104/146）。暂停按钮/`Ctrl+P` 后朗读不落库，徽章显示「已暂停」，继续后恢复写入；`Esc` 停止写入 `ended_at`。UI Automation 点「导出」分别得到 Markdown（含时长/音源/模型元信息）、SRT、JSONL（session + segment 行）。图钉切换已验证 `WS_EX_TOPMOST`。音源卡切到「麦克风」会写 `audio.json` 并重启采集，本机没有可用麦克风端点时界面给出「找不到麦克风设备」错误后恢复系统声音。
- **待做**：系统声 + 麦克风混音与按进程采集；会话库界面（列表/检索）；问答；术语表；TTS；托盘与自动更新；macOS/Linux。多 Provider 配置档已于同日补齐。安装器仍未签名。

### Sprint 1 P1 补齐（2026-11-25，Windows 11）

按 P0 记录末尾的「待做」继续推进，完成四项：音源扩到四种、会话库、本场问答、以及把音频/识别的机器边界写进帮助文案。

- **四种音源**（`audio.rs` / `engine.rs`）：`AudioSource { System, Microphone, Both, Process }`，`audio.json` 增 `micDevice` / `processId`，`normalized()` 统一清洗（来源转 id、设备去空白、pid 必须 >0）。设置页四张卡片（系统声音 / 麦克风 / 系统声音 + 麦克风 / 单个应用），输出与输入设备分别选择，进程下拉来自 `Device::get_iaudiosessionmanager` 的默认 Render 回环会话（按 pid 分组、排除 pid 0 与本进程），带「刷新」。
- **混音**：两路捕获线程各自 16 kHz 单声道，写入 `sync_channel(32)`；`mix_loop` 用 `VecDeque` 缓冲，每 100ms（1600 样本）把两路相加后发出，任一路滞后超过 3 个块就只用另一路，单路缓冲上限 5s，电平每 90ms 汇报一次。某一路打开失败时发 `Status { state: "listening", message: "…；另一路继续采集中" }`，整体不中断。会话的 `source` 写「系统声音 + 麦克风」。
- **按进程采集**：`AudioClient::new_application_loopback_client(pid, include_tree=true)`（Windows 10 2004+；该客户端不实现 `get_device_period`，回退 200,000 hns）。只抓目标进程及其子进程，不混入系统其它声音；没有正在发声的应用时列表为空。会话 `source` 写「单个应用」。
- **会话库**（`store.rs` / `library-dialog.tsx`）：`list_sessions(query, limit)`——空查询按 id 倒序列全部；有查询时匹配标题、音源，或用 `EXISTS` 匹配字幕原文/译文；`delete_session` 先删 `segments` 再删 `sessions`，不存在时报错。界面为顶栏书本按钮打开的对话框：300ms 防抖搜索、场次行（标题/音源/条数）、只读详情（原文+译文+时间）、复用导出菜单（md/jsonl/srt）、删除需二次确认。
- **本场问答**（`ask.rs` / `ask-panel.tsx`）：WebView 只发送当前屏幕上的 `AskLine { seq, start_ms, text }` 与问题；Rust 侧从尾部按行取上下文（上限 12,000 字符，行格式 `[seq] mm:ss 原文`），系统提示要求只依据转录、用简体中文、结论后标 `[行号]`。路由与翻译一致：第三方仅在「已同意 + 有 Key」时优先，失败回退本地 LLM，再失败报错误码；`AskEvent` 经 `Channel` 流式回传 `Delta` / `Done{route, provider, ms, citations}` / `Error`。引用解析只保留真正发送过的行号，界面把它们渲染成可对照时间戳的徽章。契约不变：音频不进问答，转发给第三方的只有问题与相关字幕。
- **已验证**：`cargo test --lib` 13 通过 / 4 忽略（新增 `settings_roundtrip_and_clamp`、`searches_and_deletes_sessions`、`context_is_numbered_and_keeps_the_tail`、`citations_only_keep_lines_that_were_sent`）；`cargo test --lib ask::` 2 通过；`tsc` 无错。
- **安装版实测（同日）**：NSIS 11.6MiB / MSI 16.4MiB，静默装到 `D:\Livetrans`。
  - 按进程：用 TTS 的 PowerShell（pid 38848）发声，选「单个应用」后库中出现 `source=单个应用` 的场次（3 条，英文原文 + NMT 译文），其它系统声音未混入。
  - 混音：本机唯一的 Realtek 麦克风端点为 Unknown，无法单独采集；切「系统声音 + 麦克风」后系统那一路照常出字并落库（`source=系统声音 + 麦克风`），另一路失败只提示不中断——混音路径可用，麦克风半边受本机硬件限制。
  - 会话库：列表显示 4 场、条数与音源正确；搜索、详情、删除均可通过 UI Automation 操作；导出沿用 P0 已验证的三种格式。
  - 问答：用本地假的 OpenAI 兼容流式服务（`127.0.0.1:18080`，仅验证用，已删除）把 `localLlm` 指过去，听三句英文后提问，回答分块流式出现（「根据转录，本次评审先讲市场数据 [1]，随后提到季度目标 [2]。」），徽章显示 `00:00` / `00:04` 两条引用，路由显示「本地 LLM · 127.0.0.1:18080 · 0.3s」；未配置接口时默认 Ollama 地址连通失败会明确报错。测试后已恢复 `settings.json` 与 `audio.json`。
- **已知限制**：混音是两路直接相加、按到达顺序对齐，不做时钟校正；混音中某一路的失败提示可能被随后的识别状态覆盖，用户未必看得到；按进程采集依赖 WASAPI 进程回环（Win10 2004+），只列出已有音频会话的进程；问答只用当前屏幕上的字幕（约 1.2 万字）；跨场次检索与问答见下方同日追加。

### 术语表与场景预设（2026-11-25，同日追加）

对应功能全景第 9 条。目标是可切换的多套场景预设（每套含一两句场景背景 + 行话表），让翻译统一译法、问答理解上下文，并尽量让识别偏向这些词：

- **模型与存储**（`glossary.rs`）：`Glossary { activeId, presets: [{ id, name, scene, terms }] }` 存 `%APPDATA%\app.livetrans.desktop\glossary.json`。内置「通用（不限场景）」预设且始终排第一、不可承载内容；最多 20 个预设，名称 ≤40 字、scene ≤600 字、每预设术语 ≤200 条，保存时去空白、丢弃不完整行、按 source 小写去重、重复 id 自动加后缀；`activeId` 失效时回落到通用预设。旧版 `{scene, terms}` 文件读入后自动迁移成一个「我的场景」预设并设为当前。`prompt_block()` / `hotword_lines()` 都只取当前预设；热词写 app_data 目录的 `glossary-hotwords.txt`，一行一个原文；空表时删除旧文件。单测覆盖归一化/去重、通用预设约束、按当前预设取提示块与热词、热词文件往返、旧文件迁移与保存回读。
- **翻译注入**（`TranslateService`）：服务启动时读 `glossary.json`，`attempt()` 为本地 LLM 与第三方两条路线把提示块追加到 system prompt，并要求“优先采用术语表给出的译法”；本地 NMT 逐句翻译不读取术语表（模型本身无法遵从）。保存术语表立即生效，无需重启。
- **问答注入**（`ask.rs`）：`ask()` 在系统提示里追加本场场景与术语，并强调背景只用于理解、回答仍须依据转录并标注 `[行号]`。
- **识别热词**（`engine.rs`）：`Engine::start` 把热词文件路径传给流式 ASR；`build_config` 有热词时改用 `modified_beam_search`（greedy 不支持热词）、`max_active_paths=4`、`hotwords_score=1.5`，`modeling_unit=cjkchar+bpe` 且 `bpe_vocab` 指向模型 `tokens.txt`。若模型拒绝热词，自动退回无热词配置再创建识别器，不影响开播。Whisper 没有热词接口，术语只作用于翻译与问答。
- **界面**：设置「场景与术语」分页（`glossary-settings.tsx`）顶部是预设下拉 + 「新增预设」，下方编辑当前预设的名称、场景文本域（带字数）与成对术语（添加/删除、200 条上限），可两步确认删除非通用预设；底部沿用对话框统一保存，保存成功后把 Rust 归一化结果回填并清除未保存标记。首页空闲态按竞品布局改为居中「准备好就开始」：图标 + 说明 + 场景下拉 + 「管理…」+「开始录音」；切换场景只写 `activeId`，`useGlossary` 负责乐观更新与失败回读。浏览器预览用内存 demo。
- **已验证**：`cargo test --lib` 20 通过 / 4 忽略（含 5 个 glossary 单测）；`tsc -b` 无错；浏览器预览新增预设、填写场景/术语、保存后首页下拉切换与重开保留均正常。
- **安装版实测（同日）**：NSIS 11.30MiB 静默装到 `D:\Livetrans`。UI Automation 从首页「管理…」进入设置，新建预设「产品评审」（场景「讨论云原生与供应链，参与者会说 Kubernetes 与灰度发布。」、术语 `supply chain => 供应链`），保存后 `glossary.json` 为 `activeId=preset-…`、两个预设结构正确，首页下拉显示「产品评审」；在首页下拉切到「通用（不限场景）」后文件 `activeId=general`、按钮文字同步更新。把 `route` 临时指到本地假 OpenAI 流式服务（127.0.0.1:18082），用设置里的「测试一句」分别测试：通用预设时 system prompt 无场景/术语，切回「产品评审」后同一请求带上「场景背景：讨论云原生与供应链…」「supply chain => 供应链」；再次开始录音时 `glossary-hotwords.txt` 内容为 `supply chain`。测试后已恢复 `settings.json`、`audio.json` 并删除测试用 `glossary.json` 与假服务。
- **限制**：本地 NMT 不读术语表；Whisper 不支持热词；切换预设后翻译与问答立即生效，但识别热词要到下一次开始录音才更新；热词是否命中取决于所选 Zipformer 的词表大小写与分词（`bpe_vocab=tokens.txt`），未逐模型校准，效果欠佳时识别器会自动退回普通解码；术语表导入/导出见下方同日追加。

### 顶栏音源下拉（2026-11-25，同日追加）

首页音源不再只是底栏的固定文字，顶栏「Live session」右侧新增音源下拉（参考竞品顶栏的「系统声 ⌄」）：

- **状态共享**（`use-audio-settings.ts`）：App 层通过现有 `get_audio_settings` / `save_audio_settings` 加载并保存 `audio.json`；Rust 仍在每次 `start()` 重新读取，因此切换只影响下一次开始录音，不会打断进行中的采集。
- **下拉行为**：列出系统声音、麦克风、系统声音 + 麦克风；尚未选择进程时「选择单个应用…」直接打开 **设置 → 识别**，已有 `processId` 时可直接切到该应用；「选择应用与设备…」始终进入识别页更换进程或输出/输入设备。开始中、采集中和暂停时下拉禁用，避免误以为当前采集已切换。
- **回填**：识别设置里改音源通过新增的 `onAudioSaved` 立即回填 App 状态；底栏音源胶囊空闲时显示当前选择、采集时显示引擎回传的真实音源，并移除了旧的「Microphone v0.2」假入口。
- **已验证**：`tsc -b` 无错；浏览器预览中下拉切换后顶栏与底栏同步、无进程时「选择单个应用…」打开识别页、设置内改音源后顶栏立即回填。
- **安装版实测（同日）**：NSIS 11.30MiB 静默装到 `D:\Livetrans`。UI Automation 确认顶栏「音源」ComboBox 可选系统声音 / 麦克风 / 系统声音 + 麦克风：选麦克风后 `audio.json` 为 `source=microphone`，选混音后为 `source=both`；尚未选进程时选「选择单个应用…」会打开 **设置 → 识别** 且不改写 `audio.json`；在设置里点麦克风卡片（立即保存）再关闭，顶栏与底栏文案同步变为「麦克风」；最后选回「系统声音」。测试后已恢复 `audio.json`。
- **限制**：切换只对下一次开始录音生效；单个应用的进程与设备仍需在设置里选择。

### Provider 配置档（2026-11-25，同日追加）

对应任务拆解第 6 条：第三方不再只有一套地址/模型/Key，而是可保存、切换、删除的多套配置档（最多 10 套）：

- **数据模型**（`translate/mod.rs`）：`ProviderProfile { id, name, baseUrl, model, consentAt }`，设置里存 `providers: Vec<ProviderProfile>` 与 `activeProviderId`；默认一套 DeepSeek（`https://api.deepseek.com/v1`、`deepseek-chat`）。旧版单套字段 `remoteLlm` / `remoteConsentAt` 只在反序列化时读取，迁移成第一套配置档后不再写回；旧 Key（`translate-api-key`）在首次启动时复制到当前配置档并删除旧条目。名称 ≤40 字、URL/模型去空白、空 id 补 `provider-N`、重复 id 加后缀、最多 10 套；`activeProviderId` 失效时回落到第一套，且至少保留一套。
- **Key 与同意**：每套 Key 存系统钥匙串的 `provider:<id>`，WebView 只拿到 `providerKeys: Record<string, boolean>`；保存时写入当前配置档的 Key，删除配置档时删除它的 Key。同意记录按配置档保存（`consentAt`），首次发送前必须勾选；翻译、测试连接与问答都只认当前配置档的同意与 Key，切换配置档需要重新同意。
- **同时修复**：`keyring = "3"` 原来没有开任何 native feature，Windows 上会静默落到内存 mock，Key 重启即丢。现改为 `keyring = { version = "3", features = ["windows-native"] }`（按平台放在 `cfg(windows)` 依赖里），并新增一个 `#[ignore]` 的钥匙串往返测试（写入两套 Key、分别读回、清除一套不影响另一套）。
- **路由**：翻译的第三方路线与问答都取 `activeProvider()`；`describeRoute` 显示当前配置档名称，问答失败链仍是「当前第三方 → 本地 LLM」。
- **界面**：设置 → 翻译与聊天 → 第三方内新增「Provider 配置档」区：下拉切换、新增/删除（删除需点两次确认）、OpenAI / DeepSeek / OpenRouter 快速新建；名称、模型、接口地址、Key、同意勾选都作用于当前配置档。保存配置本身不发送文本，因此不需要同意；「测试连接」、翻译与问答才会拒绝没有同意的配置档。
- **单测**：旧单套设置迁移为配置档且不回写旧字段；裁剪/去重/当前项回落；数量上限与默认档。`cargo test --lib` 23 通过 / 4 忽略。
- **已验证**：`tsc -b` 无错；浏览器预览中新增空白档、OpenAI 预设（自动填 `gpt-4o-mini` 与地址）、下拉切换三套、删除需二次确认并回落到剩余档。
- **安装版实测（同日）**：NSIS 11.32 MiB 静默装到 `D:\Livetrans`。旧 `settings.json`（单套 `remoteLlm` + `remoteConsentAt`）启动后在设置里显示为 DeepSeek 配置档，保存后文件只含 `providers` / `activeProviderId`，不再写回旧字段。新增「Test OpenAI」档（`http://127.0.0.1:18080/v1` / `test-model`），勾选同意并保存后，Windows 凭据管理器出现 `provider:<id>.app.livetrans.desktop` 条目；重启应用后「移除这个配置档的 Key」仍在。用本地假 OpenAI 流式服务验证「测试连接」：服务端收到 `Authorization: Bearer <user key>`、`model='test-model'`、2 条消息，界面显示「测试译文：早上好，各位。」。删除该配置档并保存后只剩 DeepSeek、`activeProviderId` 回落到 `provider-1`，凭据管理器条目同时消失；删除后的保存不再被「未同意」拦住（保存配置不发文本）。测试后已恢复 `settings.json` / `audio.json` 并清除测试凭据。
- **限制**：配置档没有单独的「设为默认」概念，当前项就是唯一活跃项；导入/导出配置档见下方同日追加。

### 浮标开关与模型校验（2026-11-25，同日追加）

- **浮标开关**（`lib.rs` / `App.tsx`）：前端一直在调 `set_float_visible`，但 Rust 侧没有注册这个命令，`invoke(…).catch()` 把错误吞掉，所以「设置 → 通用 → 显示录音浮标」实际无效。现补上命令：显示时把 300×68 的浮标放在主窗口右下角 24px、`always_on_top`，隐藏时直接 `hide()`；同时补上同样缺失的 `focus_main_window`（浮标上的「回到主窗口」用它）。主窗口关闭通过 `on_window_event` 先 `engine.stop()`（给进行中的场次写 `ended_at`）再 `exit(0)`——否则隐藏的浮标窗口会让进程留在后台，且退出时正在录的那场会在库里永远显示「进行中」。
- **模型校验**（`download.rs` / `asr_models.rs` / `translate/models.rs`）：新增 `sha2` 依赖；目录表每个文件带 SHA-256（5 个识别模型 18 个文件 + 本地 NMT 5 个文件）。权重用仓库 LFS 元数据里的 `oid`，`tokens.txt` / `tokenizer.json` / `config.json` 等非 LFS 小文件直接对发布文件取哈希。`fetch_file` 对已存在的文件先校验大小与校验值（坏文件删除重下）；新下载的 `.part` 完成后校验，失败时删除分片、下次从头下载，避免把 421MB 的坏文件当已安装。空校验值保留旧的仅大小校验行为。
- **已验证**：`cargo check --offline` 通过；`cargo test --lib` 24 通过 / 5 忽略（新增 `download::tests::sha256_matches_a_known_vector`，用 `abc` 的已知向量）；`cargo test --lib downloads_zh_14m_from_mirror -- --ignored` 真实下载中文轻量模型 31MB 四个文件，全部校验通过；`pnpm build`（`tsc -b` + vite）通过。
- **安装版实测（同日）**：NSIS 11.39 MiB / MSI 16.18 MiB。直接运行 `target/release/app.exe`（同目录已带三个 DLL 与 `silero_vad.onnx`）：空闲时浮标隐藏；`Ctrl+M` 开始录音后浮标出现，位置在窗口 683,301–1878,1098 的右下角（浮标 1561,1014–1861,1082），再按 `Ctrl+M` 停止后隐藏；对主窗口发 `WM_CLOSE` 后进程在 8 秒内退出，不再留在后台；录音中关闭时正在录的场次会先写 `ended_at`（实测 19:04:24 → 19:04:27），不会留在「进行中」。测试里开关录音产生的空场次（无字幕）留在会话库，可手动删除。
- **限制**：校验只覆盖「下载到本机」这一步；用户手动放入的模型目录、旧版本已下载的文件不会主动重算（否则每次打开设置都要哈希 1 GB）。浮标位置固定在主窗口右下角，不做多显示器记忆。

### 导出目录、会话改名、中英双语与三步引导（2026-11-25，同日追加）

- **导出目录**：`general.rs` 新增 `GeneralSettings { exportDir, locale }`，存在 `%APPDATA%\app.livetrans.desktop\general.json`（先写临时文件再 rename）；`export_session` 读取该文件，未设置时用 `document_dir()/Livetrans`，保存设置时 `create_dir_all` 校验目录可建。设置 → 通用 → 导出显示当前目录（未设置时显示默认提示），可「浏览…」（`tauri-plugin-dialog`）或恢复默认。
- **会话标题**：`store.rs::rename_session` 去空白、拒绝空标题、截到 80 字符，返回更新后的 `SessionMeta`；`rename_session` 命令注册。会话库详情标题旁加铅笔按钮，就地编辑：Enter 保存、Esc 取消（用 ref 跳过随之而来的 blur），失败显示在顶部错误条；列表与详情同步更新。浏览器预览的 `renameSession` 直接改演示数据。
- **i18n**：以中文原文作键，`src/lib/i18n.ts` 提供 `tr(zh, params?)`（`{name}` 插值）与 `localize(text)`（Rust 文本的精确匹配翻译）；英文表 `messages.en.ts` 由脚本从调用点提取生成，共 284 条。语言存 `localStorage["livetrans-locale"]` 并由 Rust `general.json` 作为权威值：启动时同步、设置里切换后重载窗口（模块级选项表在 import 时构建）。设置 → 通用 → 界面语言选择简体中文 / English，保存后立即重载。
- **Rust 侧文案**：`general::is_chinese()` / `general::pick(zh, en)`；识别模型目录（5 个模型的标题与说明）、环境推荐语、Markdown 导出表头与失败注释、通用预设名（前端按 `GENERAL_ID` 映射）、引擎状态/错误（暂停、Whisper 加载、VAD、采集公告、设备错误）、导出/改名/无会话等命令错误都按语言输出。已存会话里的中文音源字段由前端 `localize()` 兜底。
- **三步引导**：`onboarding.tsx`，首次启动（`localStorage["livetrans-onboarded"]` 未设）显示：① 边界说明（音频不出机、边说边出字、会话与导出在本机）；② 选择默认音源（写 `audio.json` 的 `source`）；③ 推荐识别模型（显示大小与安装状态，可直接下载并自动选中；也可「稍后再选」）。完成后写标记并关闭；不阻塞主界面，浮标窗口不渲染它。
- **已验证**：`cargo test` 27 通过 / 5 忽略（含 `general::tests::settings_round_trip`、`store::tests::renames_a_session_and_rejects_blank_titles`）；`tsc -b` 与 `pnpm build` 无错；用 headless Edge + CDP 驱动浏览器预览逐步截图：三步引导（欢迎/音源/模型）、中文设置页、切换 English 后主界面与设置页全英文、会话库改名成功（标题与列表同步）；`Interface language` 显示 English、`Export` 区块出现。release 构建产出 NSIS 11.41 MiB / MSI 16.20 MiB。
- **安装版实测（同日）**：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224` 运行 `target/release/app.exe`，用 CDP 驱动：首次启动显示三步引导，逐步点过并「完成」；打开设置看见「界面语言」与「导出」两个区块；切到 English 后窗口重载、主界面与设置页为英文；再选「Simplified Chinese」保存，`general.json` 回到 `zh-Hans`，界面恢复。测试写入的 `general.json` 与临时调试端口在测试后删除。
- **限制**：英文未覆盖少数底层错误与系统设备名；已存旧会话的中文 `source` 视词典匹配程度翻译；语言切换靠整窗重载；引导标记存 localStorage；导出目录的原生选择框未在 CDP 里点选（只验证了保存与默认值回退）。

### 术语表 / 配置档导入导出与跨场次问答（2026-11-25，同日追加）

对应功能全景里的「术语分享」与会话库的跨场次能力，完成三件事：

- **术语表导入/导出**（`glossary.rs`）：`export_portable` 写 `{ app: "livetrans", kind: "glossary", version: 1, presets: [{ name, scene, terms: [{ source, target }] }] }`，只含用户预设（不含「通用」）、已归一化并丢弃空行，没有可导出内容时报错；`import_portable` 同时接受这份格式与旧的 `glossary.json` 结构，生成 `import-N` 新 id、丢弃「通用」与不完整术语。错误按界面语言输出。单测覆盖导出不含 id/通用预设、旧格式读入、空文件与坏文件被拒绝。
- **配置档导入/导出**（`translate/mod.rs`）：格式 `{ app, kind: "provider-profiles", version: 1, profiles: [{ name, baseUrl, model }] }`；导出只取已填地址与模型的配置档，明确去掉 id、`consentAt` 与 Key（Key 本来只存系统钥匙串）。导入丢弃缺地址/模型的条目、id 置空（界面再加 `provider-import-…` 新 id）、`consentAt` 置空、名称缺失补「服务商 n」，总数仍受 10 套上限约束。单测覆盖导出无 Key/同意/id、导入跳过不完整条目。
- **文件 IO 与对话框**：前端用 `@tauri-apps/plugin-dialog` 的 `open` / `save`（`dialog:default`），Rust 负责读写 JSON。两个设置页都先把导入结果合并进未保存的 `form`：保留现有内容、新预设成为当前项、清空 Key/同意/测试结果并提示「保存后生效」，点「保存」才落盘，避免导入直接覆盖现有数据。浏览器预览用 `portable-file.ts`：导出走 Blob 下载，导入用隐藏 `<input type=file>` 解析，无 Tauri 时也能演示。
- **跨场次检索**（`store.rs` / `ask.rs`）：`TranscriptHit { session_id, title, started_at, seq, start_ms, original, translated }`；`segments_matching` 用 `LIKE ?1 ESCAPE '\'` 同时匹配原文与译文，`recent_segments` 取最近行。问题先做词提取：ASCII 按单词去停用词；CJK 取相邻二元组并跳过「的了是在和与就都也个吗呢吧啊哦我你他她它们这那」等，最多 12 个词。每个词最多取 60 行、每场最多 12 行、总共 40 行，按命中词数排序后按场次新旧编号；一个词都没命中时回退到最近 30 行（场次倒序、场内正序）。
- **跨场次问答**：`ask_across` 先发 `Retrieved { lines, sessions }`（前端立即画「检索依据」），再把编号上下文（`[n]「标题」mm:ss 原文`）交给 `stream_answer`——第三方只在当前配置档「已同意 + 有 Key」时优先，失败回退本地 LLM，`Delta` / `Done { route, provider, ms, citations }` / `Error` 经 `Channel` 流式回传。系统提示要求只依据这些行、用界面语言作答、结论后标 `[n]`，引用只保留实际发送过的行号；`search_transcripts` 是同一检索的不调用模型版本。
- **界面**（`cross-session-ask.tsx` / `library-dialog.tsx`）：会话库右上角「跨场次问答 / 返回会话」切换右栏；空状态给出三条示例问题；消息区为用户气泡 + 助手卡片（流式文字、引用徽章、路由与耗时、可折叠的「检索依据 n 行 · m 场」），点引用或依据行会打开对应场次并滚动到 `segment-<seq>`；底部输入框回车提问，另有「只检索」/「提问」按钮，进行中可停止。
- **已验证**：`cargo test --lib` 35 通过 / 5 忽略（新增术语表 3 个、配置档 2 个、store 检索 1 个、ask 词提取与排序 2 个）；`cargo check --all-targets`、`tsc -b`、`pnpm build` 均通过（仅 vite 的 641 kB chunk 提示）；英文词典重新提取 328 条、缺失 0。headless Edge + CDP 驱动浏览器预览：导入含 1 个预设/2 条术语（其中 1 条空行）的术语文件后显示「已加入 1 个预设」且空行被丢弃；配置档导出显示「浏览器预览：已生成下载文件」，导入 1 套完整 + 1 套缺模型的配置档后只加入「评审用」并提示 Key 需重填；跨场次提问「Kubernetes rollout」得到 1 行/1 场依据与 `00:42` 引用徽章，「canary」只检索得到 1 行，点依据行打开会话成功。
- **限制**：这里的跨场次问答仍是 `LIKE` 打分，排序只看命中词数与场次新旧，问法抽象或同义词时可能空手而归；中文按二元组切分，长词命不中时依赖相邻组覆盖；行数/场次上限如上，会话很多时不会穷尽全部历史。会话库的「全文检索」后来改用 FTS5 三元组索引（见本节后文），两者并存。跨场次问答仍需配置模型（第三方要同意 + Key），音频依旧不出本机；导入的配置档 Key 需重填；原生文件对话框未在安装版里自动化点选（只验证了浏览器预览与 Rust 单测）。

### 译文配音（TTS）（2026-11-25，同日追加）

- **模型**：sherpa-onnx 2.0.3 的 `OfflineTts` + Kokoro v1.1 多语种（`csukuangfj/kokoro-multi-lang-v1_1`）。只取 5 个文件：`model.onnx`（325,561,476 B）、`voices.bin`（53,790,720 B，103 个音色）、`tokens.txt`、`lexicon-us-en.txt`（5,956,885 B）、`lexicon-zh.txt`（2,120,131 B），合计 387,430,323 B（约 369.5 MiB）。v2.0.0 起 `data_dir`（espeak-ng-data / jieba）已废弃，中英双语靠两份 lexicon，不再下载几百个小文件。
- **下载与校验**（`voice.rs` + `download.rs`）：沿用识别/翻译的下载站选择（先 `hf-mirror.com` 再 `huggingface.co`，`LIVETRANS_MODEL_BASE` 可覆盖），`.part` 续传，按仓库公布的 SHA-256 校验；完成后写入 `%APPDATA%\app.livetrans.desktop\models\tts\kokoro-zh-en-v1.1\`。界面有进度、取消与两步确认的删除。
- **设置**：`voice.json` 只有 `{ enabled }`，默认关闭；保存时若 `enabled=true` 但模型不完整会报错拒绝。Rust `VoiceService` 懒加载 `Arc<OfflineTts>`（`num_threads=2`），首次朗读才把模型读进内存。
- **合成与播放**：`synthesize_voice(text, lang)` 去掉 NUL、截到 600 字符，按语言选音色——`lang` 以 `en` 开头用 `af_maple`（sid 0），否则用中文女声 `zf_001`（sid 3），生成 16-bit 单声道 WAV 后 base64 回传；在 `spawn_blocking` 里跑，不阻塞命令线程。前端 `use-voice.ts` 串行合成→播放（`Audio('data:audio/wav;base64,…')`），队列上限 6，`speak()` 只在已安装且开关打开时入队；停止录音、暂停、卸载时清空队列并停声。浏览器预览没有 Tauri，退化为 Web Speech API，仅用于界面演示。
- **接入**：`use-engine` 新增 `onTranslationDone`，在 `translationDone` 且 `route !== 'passthrough'` 时回调；`App` 用 `voice.speak(text, translate.settings.targetLang)`。设置对话框新增「配音」页（侧栏 Volume2 图标），布局按设计稿：顶部说明、语音模型卡片（标题 / 已安装或下载中徽章 / 大小与 103 音色文案 / 说明 / 下载-取消-删除）、「朗读译文」开关与引导文案；仍走暂存表单，只有点「保存」才调用 `saveVoiceSettings`，错误留在面板里。
- **i18n**：新增 10 条英文词条（配音、语音模型、朗读译文、两段引导、Kokoro 说明等），词典共 340 条，提取脚本缺失 0。
- **已验证**：`cargo test --lib` 39 通过 / 6 忽略（新增 `voice` 4 个：WAV 头、base64 向量、空目录未安装、设置默认关闭与往返；另有忽略的真实合成测试）；`tsc -b` 与 `pnpm build` 通过（仅 vite 651 kB chunk 提示）。忽略测试真实下载 387MB 并合成中英混句，断言 base64 以 RIFF/WAVE 开头且样本数 > 10,000，173.8s 通过。浏览器预览实测：设置页文案与设计稿一致；开关需先装模型，切换后显示未保存、保存后重开仍在；删除 → 卡片变为未安装、开关禁用并显示「先下载上面的模型，才能打开配音。」；下载进度 0→63%→已安装、取消后回到下载按钮；切到 English 后「配音」页文案全部为英文。
- **限制**：固定音色与语速（无音色/语速/音量选择），只读译文；Kokoro 英文词典没收录的词会被跳过，`RSI` 等短缩写按字母读；只覆盖中英；WebView 播放队列 6 句，落后时丢弃新句；模型约 370MB，首次朗读才加载（额外数百 MB 内存）；没有「落后自动加速」，也未在安装版里做实际发声自动化测试（单测已覆盖真实合成）。

### 插件 / JSONL 事件流、全文检索与 CLI（2026-11-25，同日追加）

对应功能全景第 14、15 条，一次补齐四块：

- **全文索引**（`store.rs`）：`segments_fts` 是 FTS5 外部内容表，`content='segments'`、`content_rowid='id'`、`tokenize='trigram'`，索引 `original` 与 `translated`；`segments_fts_ai/ad/au` 三个触发器随字幕增删改同步。`open()` 读 `PRAGMA user_version`，旧库首次打开时执行一次 `INSERT INTO segments_fts(segments_fts) VALUES('rebuild')` 并写入 version 1，升级不需要用户操作。
- **检索**（`SearchHit` / `search_fulltext`）：按空白拆词，保留 ≥3 个字符的词，拼成转义后的短语 `MATCH`（`"` 加倍），join 回 `segments` 与 `sessions`，`ORDER BY rank` 取 `bm25` 负分；可选按 `session_id` 过滤。结果含场次标题、开始时间、`seq`、`start_ms`、原文、译文、分数与片段；片段优先取译文，取首个命中词前 24 字、总长 90 字的窗口并加省略号。不足 3 字的查询（如 `AI`）回退 `segments_matching` 的 `LIKE` 包含匹配，分数记 0。`render` 抽出 Markdown / JSONL / SRT 三种导出供 CLI 复用。
- **界面**（`library-search.tsx`）：会话库顶栏新增「全文检索 / 返回会话」切换，右栏输入 220ms 防抖后调用 `search_library`；结果卡片显示标题、`mm:ss`、原文与不同则显示片段，点击打开对应场次并滚动到 `segment-<seq>`。空态、加载、错误与说明文案齐全，输入提示明确「英文单词或至少 3 个中文字」。
- **插件与事件流**（`plugins.rs`）：`PluginSettings { enabled, command }` 存在 `%APPDATA%\app.livetrans.desktop\plugins.json`，命令经系统 shell（Windows `cmd /C`，其它 `sh -c`）启动，带 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，Windows 用 `CREATE_NO_WINDOW` 避免闪控制台；stdin 收 JSONL，stdout 读 `{"type":"rewrite","id":n,"text":"…"}`，按 `id` 用 400ms `recv_timeout` 路由回等待线程。每场监听在 `streams\<会话 id>.jsonl` 写同一份事件（`session` 头、`status/partial/final/translationDelta/translationDone/translationError/error`、`sessionEnd`，均带 `sessionId`，电平事件跳过）；不做插件时也照写。`probe` 为「测试命令」临时启动一次并返回是否有改写。
- **接入**（`engine.rs`）：store 线程缓存每句 `Final` 原文；`TranslationDone` 在非 passthrough 且有文本时先问插件改写，再按改写后的译文写库、发 UI 与触发配音，所以导出、会话库与朗读都看到改写结果。`stop` 在 ASR 线程结束后发 `sessionEnd` 并结束进程。
- **CLI**（`cli.rs` + `bin/livetrans.rs`）：Cargo feature `cli` + `required-features`，默认应用构建不受影响。`LIVETRANS_DB` 可覆盖数据库；子命令 `list`（表格或 `--json`）、`search`（每行一个 `SearchHit` JSON）、`show --format md|jsonl|srt`、`export`（默认 `livetrans-<id>.<fmt>`）、`stream [--follow]`（打印或每 250ms 跟随最新场次，处理截断）。
- **已验证**：`cargo test --lib` 45 通过 / 6 忽略（新增全文检索双语命中、场次过滤、2 字回退、删除清理、旧库重建；插件设置归一化/拒绝空命令启用、事件流内容、无插件不改写、Windows 回声脚本 probe）；`cargo check --all-targets --features cli`、`tsc -b`、`pnpm build` 通过。CLI 用临时 SQLite 夹具逐条跑过 list/search/show/stream/export/help。浏览器预览实测：插件页开关在命令为空时禁用、填命令后可开、测试命令返回预览提示、保存后重开仍在、空命令 + 启用被拒；中文「灰度」与英文 `kubernetes` 都能出结果并点开对应句；切 English 后两页文案完整。英文词典提取 359 条、缺失 0。
- **限制**：trigram 每词至少 3 字符，短词只能 `LIKE` 扫行；没有向量/同义词/模糊匹配，片段是截取而非原文高亮；`search_transcripts`（跨场次问答）仍走旧的 LIKE 检索，两套并存。插件单命令、每场一个进程，改写只作用于译文且等待上限 400ms，超时/空输出/与原译文相同就不改，脚本崩溃后本场不再改写；stdout 必须 UTF-8，非 JSON 与 stderr 只进日志。浏览器预览不运行本机脚本。CLI 只读，不含写入/删除。

### 托盘、自动更新、诊断包与发布工程（2026-11-26）

对应功能全景第 16 条与发布准备，一次补齐四块：

- **托盘与关闭到托盘**（`tray.rs`、`lib.rs`、`general.rs`）：`TrayIconBuilder::with_id("main-tray")` 用应用图标，tooltip `Livetrans`，菜单「显示主窗口 / 设置… / 退出 Livetrans」，`show_menu_on_left_click(false)` 让左键单击直接恢复窗口；恢复时 `show` + `unminimize` + `set_focus`。`WindowEvent::CloseRequested` 先取 `Engine` 并 `stop()`（隐私：不在后台继续采集），再读 `general.json` 的 `minimizeToTray`：为真时 `api.prevent_close()` 并 `window.hide()`，为假时 `app.exit(0)`。`GeneralSettings` 新增 `#[serde(default = "default_minimize_to_tray")] minimize_to_tray: bool`，默认 `true`，手写 `Default` 保留“文件缺失时默认开启”；前端 `general-settings.tsx` 在「显示录音浮标」下方加同名开关，`app-settings.ts` 归一化 `minimizeToTray !== false`。
- **自动更新**（`updater.ts`、`about-settings.tsx`、`Cargo.toml`、`capabilities/default.json`、`tauri.conf.json`）：Rust 侧注册 `tauri_plugin_updater::Builder` 与 `tauri_plugin_process`；JS 侧动态 import `@tauri-apps/plugin-updater` / `plugin-process`，`checkForAppUpdate()` 返回 `{version, currentVersion, date?, body?}`，`installAppUpdate(onProgress)` 把 Started/Progress 事件换算成 0–1 进度，`relaunchApp()` 负责重启。`updatesSupported()` 在浏览器预览返回 false，按钮禁用并显示说明。设置新增「关于与诊断」页（`Info` 图标），显示版本、检查/下载/安装/重启四态与错误文案。公钥来自 `tauri signer generate`，私钥不进仓库；端点仍为 `OWNER` 占位符，发布前替换。
- **诊断包**（`diagnostics.rs`、`store.rs`、`diagnostics.ts`）：`export_diagnostics` 命令把 `StoreHealth {sessions, segments, latest, userVersion, integrity}`、版本、OS/架构、配置路径、模型安装探测（`models/translate/en-zh`、`models/tts/kokoro-zh-en-v1.1` 下是否存在 `.onnx`）写成 `summary.json`；`SETTINGS` 复制 general/audio/asr/settings(translate)/voice/plugins 六份配置并递归删除 `key/apikey/secret/token/password/consent/consentat/command` 字段；日志每个文件只取尾部 256KB；打包用 `zip` crate 的 Deflated。明确不含字幕、音频、SQLite、术语表、事件流与 API Key，zip 内附 `README.txt` 说明。前端用 `tauri-plugin-dialog` 的 `save` 选路径（默认 `livetrans-diagnostics-YYYY-MM-DD-HH-mm-ss.zip`），预览模式返回一段合成 JSON 而不读本机数据。
- **发布工程**（`.github/workflows/release.yml`、`scripts/`、`RELEASING.md`）：`fetch-vendor.ps1` 从 k2-fsa 与 NuGet 取 sherpa-onnx 两个 DLL、`onnxruntime.dll` 与 `silero_vad.onnx`；`set-version.mjs` 写/校验三处版本；workflow 在 `v*` 标签或手动触发时检查三处版本一致、标签等于版本、跑单测，再由 `tauri-action` 用 `pnpm tauri` 构建 NSIS/MSI 与签名更新文件，创建草稿 Release。`RELEASING.md` 记录一次性准备（改 `OWNER`、配置两个签名 secret、备份私钥）、发布命令、发布后自检与回滚方式。仓库用 Git 管理：`main` 基线，功能分支 `feature/tray-updater-diagnostics`。
- **已验证**：`cargo check --offline`、`cargo check --all-targets --features cli --offline` 通过；`cargo test --lib --offline` 46 通过 / 6 忽略（新增 `general` 托盘字段往返、`diagnostics` 脱敏保留布局）；`tsc -b` 通过；`node scripts/set-version.mjs --check` 三处一致；下载 URL 用 HEAD 实测（sherpa 与 Silero 200；ONNX Runtime 改走 NuGet）。
- **限制**：更新只手动检查，无启动自检、后台轮询或静默安装；安装后必须重启。`OWNER` 未替换前检查更新会 404。托盘图标不随录音状态变化；关闭到托盘会中断当前录音。诊断包不含用户内容，但日志可能带会话标题/路径等元数据；脱敏按字段名，未来新增的敏感字段名需同步 `is_secret_key`。CI 只构建 Windows；正式发布前需先跑通一次标签流程并做安装冒烟，`TAURI_SIGNING_PRIVATE_KEY` 未配置时 workflow 会失败。

## 4.2 MVP 任务拆解

1. **Tauri 骨架**：`tauri.conf.json`、capabilities、主窗 + 浮标、托盘、单实例、日志。
2. **采集**：封装 `capture-system-or-process-audio` 为 `AudioSource` trait；mac/win/linux 各实现 + 权限引导；麦克风 + 混音。
3. **音频管线**：rubato 16k、环形缓冲、sherpa VAD、分段器（300ms / 8s）。
4. **ASR**：sherpa `OnlineRecognizer` 接入；模型 manifest、下载（续传/校验/镜像/导入）、硬件档位。
5. **翻译**：NMT（`ort` + opus-mt ONNX + tokenizers）；Ollama 适配；OpenAI 兼容适配；路由器、上下文、术语表、回退链、SSE 流式。
6. **Provider**：多套配置、预设、`keyring` 存 Key、测试连接、首用同意、默认项。
7. **存储**：rusqlite schema、WAL、迁移、崩溃恢复；Markdown/JSONL 导出。
8. **IPC**：Channel 事件表、`invoke` 命令（start/stop/test/download/ask）、错误码。
9. **UI**：coss 初始化、主题覆盖、字体、portal 隔离；主界面、虚拟列表、6 种句子状态、字号、档位、路由徽章、聊天占位。
10. **设置**：9 个分页（coss Tabs + Field/Form）；连接测试。
11. **引导**：3 步 + 硬件检测 + Ollama 检测 + 第三方同意。
12. **工程**：GitHub Actions + tauri-action；updater 密钥；CHANGELOG；LICENSE；THIRD_PARTY_NOTICES；文档站骨架。

## 4.3 指标（开源版）

| 类别 | 指标 | 目标 |
|---|---|---|
| 延迟 | 首行字幕 P50/P95 | ≤1.2s / ≤2.5s |
| 延迟 | NMT 句译 P50/P95 | ≤0.5s / ≤3.0s |
| 延迟 | 本地 LLM 句译 P50/P95 | ≤3.0s / ≤6.0s |
| 延迟 | 第三方句译 P50/P95 | ≤1.2s / ≤4.0s |
| 稳定性 | 第三方失败回退成功率 | ≥99% |
| 质量 | 翻译失败率 | <1% |
| 使用 | 单次会话时长中位数 | ≥35 分钟 |
| 稳定 | 崩溃率 / 会话 | <0.5% |
| 资源 | 3 小时会话内存增长 | <300MB |
| 兼容 | 三平台安装成功率 | ≥95% |
| 开源 | 发布 30 天 Stars / 下载 | 先定基线 |
| 社区 | 首个外部 PR / issue 响应 | <30 天 / <72 小时 |

## 4.4 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Tauri 三平台系统音频采集工作量大 | 进度拖延 | Sprint 0 先做 spike；用 `capture-system-or-process-audio` 与 audio-recorder 参考；按平台 trait 隔离 |
| macOS 权限（屏幕录制/麦克风） | 采不到声音 | Info.plist 声明；权限卡片 + 重启；14.2+ 用 Core Audio Tap 降级 |
| WebKitGTK 渲染/滚动差异 | Linux 体验差 | 虚拟列表压测；避免重滤镜；提供渲染回退说明 |
| coss/Base UI portal 层叠 | 弹窗被内容盖住 | 根容器 `isolation: isolate`；body `relative`；E2E 覆盖 Dialog/Select |
| coss 主题被改坏 | 边框/阴影失焦 | 保留 alpha 边框 + 底部阴影策略；只覆盖颜色，不改结构 |
| Rust 构建时间与 CI 成本 | 发布慢 | 缓存 Cargo target；三平台原生 runner；避免交叉编译 |
| updater 签名密钥丢失 | 无法更新 | 密钥离线备份；文档化轮换流程 |
| 第三方 Key 泄露 | 账号损失 | `keyring`；Rust 请求；不写日志；不进 WebView |
| "本地"叙事被第三方破坏 | 信任受损 | 总开关默认关；路由徽章；首用同意；数据边界图 |
| 第三方费用意外 | 用户不满 | 会话结束估算 tokens；超时/熔断；单价以服务商为准 |
| 本地 LLM 太慢/太弱 | 体验差 | 三档路由；默认 NMT；按内存推荐 |
| 模型体积/下载失败 | 首次体验卡死 | 分档、镜像、续传、校验、离线导入 |
| Linux 音频/打包复杂 | 支持不全 | monitor 选择器 + 诊断；AppImage 先行，Flatpak 后置 |
| 模型许可证 | 法律风险 | 不打包权重；默认 Apache/MIT/CC-BY；清单可查 |
| 开源维护负担 | 范围失控 | 适配器 trait + good first issue + 明确 scope |

---

# 五、附录

## A. 翻译 Prompt（LLM 档）

```
system:
你是实时字幕翻译器。把用户给出的英文句子翻译成简体中文。
要求：
1. 只输出译文，不要解释、不要引号、不要重复原文。
2. 保持数字、代码、股票代码、专有名词不变。
3. 参考「上文」保持代词、术语和语气一致。
4. 术语表优先级最高。

user:
【场景】{preset.description}
【术语】{glossary，最多 20 条}
【上文】
20:23:05 原文… / 译文…
20:23:12 原文… / 译文…
【本句】
20:23:19 If the pullback holds above 4520, I'm looking for a second leg up.
```

## B. 问答 Prompt

```
你是这场直播课的助教。只依据下方转录回答，不要使用外部知识。
如果转录中没有依据，直接说"这场没有提到"。
回答尽量短，先给结论，再给 1–3 条出处（时间戳）。
引用时使用 [20:23:19] 形式。

【场景】{preset}
【转录】
[20:23:05] ...
...
【问题】{question}
【被引用句】{quote?}
```

## C. 设置项清单

- 识别：引擎（sherpa / whisper）、模型、语言、高级（库路径/模型路径）
- 翻译与问答：翻译路由、问答路由、Ollama 地址与模型、上下文句数、温度、术语表、回退开关、连接测试
- 第三方服务：Provider 列表、预设、Base URL、模型、Key、超时、max tokens、默认项、首用同意
- 模型管理：已安装、占用、下载、校验、镜像、离线导入、删除
- 配音：TTS 模型（Kokoro v1.1 中英双语）、朗读译文开关；音色、语速、音量、落后最高语速待做
- 记录：目录、Markdown 模板、front matter、JSONL/SRT
- 场景背景：预设、术语表导入/导出
- 插件：启用开关、本机命令、测试命令、事件流目录与状态
- 会话库：全文检索（FTS5）、跨场次问答、导出与删除
- 外观：主题、字号、置顶、浮标、localhost UI
- 关于与开源：版本、更新、LICENSE、第三方许可证、GitHub、导出诊断、贡献者

## D. 开源仓库清单（发布前）

- `LICENSE`（MIT 或 AGPL，与文档一致）
- `README.md`（主张、截图、三平台安装、本地/第三方说明、断网验证、硬件表、Tauri 依赖）
- `CONTRIBUTING.md`（Rust/前端开发、采集适配、模型适配、翻译流程）
- `CODE_OF_CONDUCT.md`、`SECURITY.md`
- Issue / PR 模板（系统版本 / 模型 / 路由 / 日志）
- `.github/workflows/release.yml`（tauri-action 矩阵 + 哈希 + Release）
- `THIRD_PARTY_NOTICES.md`（Tauri、coss ui、sherpa-onnx、whisper.cpp、capture crate 等）
- 模型许可证清单；updater 公钥与签名流程
- `docs/i18n.md`、`docs/adapters.md`、`docs/privacy.md`、`docs/tauri.md`
- `CHANGELOG.md`、`ROADMAP.md`
- 产物 SHA-256 与（可选）Sigstore 签名

## E. 许可证速查（以官方为准）

| 项目 | 用途 | 许可证 |
|---|---|---|
| Tauri 2 | 桌面壳 | MIT / Apache-2.0 |
| coss ui | UI 组件 | MIT |
| Base UI | 组件原语 | MIT |
| Tailwind CSS v4 | 样式 | MIT |
| sherpa-onnx | 流式 ASR / VAD / TTS | Apache-2.0 |
| whisper.cpp / whisper-rs | ASR | MIT |
| Silero VAD | 分段 | MIT |
| Qwen2.5-3B/7B-Instruct | 翻译/问答 | Apache-2.0 |
| Mistral-7B-Instruct | 翻译/问答 | Apache-2.0 |
| opus-mt en↔zh | 高速 NMT | CC-BY-4.0 |
| M2M100-418M | 多语 NMT | MIT |
| Kokoro-82M | TTS | Apache-2.0 |
| NLLB-200 | NMT | CC-BY-NC-4.0（非商业；本项目非商业可用，需标注） |
| Llama / Gemma | LLM | 各自社区许可（不作默认） |
| 第三方 API | 翻译/问答 | 各服务商条款；用户自备账号 |

## F. 与 Liveglot 的对照结论

| 维度 | Liveglot | 我们 |
|---|---|---|
| 形态 | 原生桌面（macOS/Windows） | Tauri 2（mac/win/linux）+ 静态官网 |
| UI | 原生（自绘） | React + coss ui（Base UI/Tailwind v4） |
| 价格 | $19.99 买断 | 免费、MIT |
| 账号/授权 | 授权码、2 台设备 | 无 |
| 识别 | 本地 Whisper 或 Soniox 云 | **仅本地**（sherpa / whisper-rs） |
| 翻译 | 云端 LLM（用户 Key） | 本地 NMT / 本地 LLM / 第三方 |
| 问答 | 云端 LLM | 本地 LLM / 第三方 |
| 采集 | 系统声 / 麦克风 | 同 + Linux；Rust 管线 |
| 数据路径 | 可全本地，也可全云 | 音频必本地；文本可选外发，边界可见 |
| 笔记 | 单场 .md | .md + JSONL/SRT |
| 维护 | 商业产品 | 社区项目：适配器、i18n、文档、Release 自动化 |

## G. Tauri 2 + coss ui 速查

**Tauri 命令与事件（示意）：**

```rust
#[tauri::command]
async fn start_capture(state: State<'_, AppState>, source: Source, ch: Channel<Event>) -> Result<()>;

#[tauri::command]
async fn stop_capture(state: State<'_, AppState>) -> Result<SessionSummary>;

#[tauri::command]
async fn test_provider(state: State<'_, AppState>, id: String) -> Result<TestResult>;

#[tauri::command]
async fn download_model(state: State<'_, AppState>, id: String, ch: Channel<Progress>) -> Result<()>;

#[tauri::command]
async fn ask(state: State<'_, AppState>, session_id: String, messages: Vec<Msg>, quote: Option<Quote>, ch: Channel<Token>) -> Result<()>;
```

**Capabilities（示意）：**

```json
{
  "identifier": "main-capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "opener:default",
    "log:default",
    "store:default",
    "updater:default"
  ]
}
```

**coss 初始化与主题：**

```
pnpm dlx shadcn@latest init @coss/style
pnpm dlx shadcn@latest add @coss/ui
```

- 根容器 `isolate`；`body` `relative`。
- 覆盖 `:root/.dark` 的颜色 token；保留 alpha 边框与阴影策略。
- 中文字体追加到 `--font-sans`；CJK 用系统字体，不随包分发（体积大）。

---

**一句话收尾：**

> 音频永远不出机，这是底线；文本去哪由用户决定，这是自由；Tauri 2 把管线放进 Rust，coss ui 把界面还给文字——三件事各自清楚，产品才稳。
