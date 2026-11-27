# Sabir

本机实时双语字幕、句子级翻译、基于转录的问答、带时间戳的 Markdown 笔记。开源、离线优先、不登录、不付费、无遥测。

仓库：[github.com/yixin8875/sabir](https://github.com/yixin8875/sabir)。

> **状态：Sprint 1（P1）。** Windows 上已经可以把系统正在播放的声音实时识别成中英文字幕，识别模型与本地翻译模型都在应用内按需下载（安装包不再带任何模型权重），并在每句定稿后做句级翻译：默认离线 NMT，也可切到本机 LLM 或自带 Key 的第三方，失败自动回退本地。音源可选系统声、麦克风、两者混音或单个应用（WASAPI 进程回环）；字幕边听边写入本地 SQLite，可导出 Markdown / JSONL / SRT，顶栏「会话库」能跨场次搜索、查看、重命名与删除，「跨场次问答」会在全部历史字幕里检索并让模型带行号引用作答；字幕栏右侧可以直接就当前转录提问，回答带行号引用；设置里的场景预设与术语表会统一 LLM 译法、作为问答背景，流式模型还会用作识别热词；首页空闲时也能直接切换场景，术语表与 Provider 配置档都能导出/导入 JSON。「设置 → 配音」还能用本机 Kokoro 模型逐句朗读译文（中英双语，约 370MB，按需下载，默认关闭）。暂停/继续、字号、置顶与内存/Ollama 探测也已就位。首次启动有三步引导（边界说明、音源、识别模型）；导出目录可在设置里改；界面支持简体中文 / English，切换后重载窗口。会话库里的「全文检索」用本机 SQLite FTS5 三元组索引跨场次找字幕；「设置 → 插件」能把每句事件以 JSONL 交给本机脚本并取回改写，事件也会写进 `%APPDATA%\app.sabir.desktop\streams\<会话 id>.jsonl`；`sabir` CLI 可列会话、检索、导出与跟随事件流。关闭主窗口默认先停止录音再缩到系统托盘（设置里可关）；「设置 → 关于与诊断」可手动检查更新（安装包与 `latest.json` 经 Minisign 签名校验，下载后重启生效）并导出脱敏诊断包；发布由 GitHub Actions 在版本标签上构建安装包与更新源，流程见 [RELEASING.md](RELEASING.md)，整个仓库由 Git 管理。macOS/Linux 采集是后续里程碑。完整方案见 [sabir-plan.md](sabir-plan.md)。

## 边界

| 数据 | 位置 | 是否离开本机 |
|---|---|---|
| 音频 | Rust 进程内存，回环采集 → 16 kHz → 流式识别 | 从不 |
| 字幕文本 | WebView（仅文本与电平事件） | 从不 |
| 会话记录 | 本地 SQLite（`%APPDATA%\app.sabir.desktop\sabir.db`） | 从不 |
| 翻译 | 默认 opus-mt ONNX（应用内下载后离线运行）；可切本机 LLM；第三方仅发送句子上文 | 仅第三方且用户授权时 |
| 问答 | 本地 LLM / 第三方（使用「翻译与聊天」里的接口） | 仅提问与相关字幕 |
| 配音 | 译文文本 → Rust 本机合成 WAV，WebView 仅负责播放 | 从不 |
| 事件流 | `%APPDATA%\app.sabir.desktop\streams\<会话 id>.jsonl`（JSONL） | 从不（本机文件） |
| 脚本插件 | 你填写的本机命令；stdin / stdout 走 JSONL | 取决于脚本自身；应用不联网 |

音频和语音识别永远在本机完成；这是产品契约，不是设置项。

改名后首次启动会把旧的 `%APPDATA%\app.livetrans.desktop` 目录一次性搬到 `%APPDATA%\app.sabir.desktop`（会话库、已下载模型与设置一起保留）；系统钥匙串里的旧 API Key 仍可读取，下次保存时写到新的服务名下。

## 目录

- [`sabir-plan.md`](sabir-plan.md) — 产品、技术、UI 与路线图
- [`apps/desktop`](apps/desktop) — Tauri 2 + React 19 + Vite 8 + Tailwind 4 + coss ui
- `research/` — 竞品与设计系统的调研材料
- [`RELEASING.md`](RELEASING.md) — 版本号、签名密钥、GitHub Actions 发布与更新自检
- `scripts/` — 发布辅助脚本（`fetch-vendor.ps1` 下载运行库，`set-version.mjs` 同步版本）
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — 打 `v*` 标签后构建安装包与 `latest.json`

## 快速开始（Windows）

前置：Node 20+、pnpm、Rust stable、MSVC Build Tools。**不需要 CMake**：sherpa-onnx 走预编译库。

```powershell
pnpm --dir apps/desktop install
```

### 1. 识别模型（应用内下载）

识别模型不再打进安装包。首次启动后打开 **设置 → 识别**，选一个模型点「下载」：

- 流式（边说边出字）：中英双语 Zipformer（约 190MB，推荐）、英文 Zipformer（约 69MB）、中文轻量 Zipformer（约 30MB）。
- 整段（按停顿切句后整句解码）：Whisper Large v3 Turbo（约 1.0GB，多语种准确率最高）、Whisper Small（约 358MB，轻量）。两者都是 CPU 推理；Turbo 每句停顿后再花约一秒出字。

每个文件下载完都会按仓库公布的 SHA-256 校验；大小或校验值不符时该文件会被删除并报错，重新下载会从头开始，不会把坏文件当成已安装。校验通过后自动选为当前模型，底部「保存」后按 Listen 即可。Whisper 需要的 `silero_vad.onnx`（约 630KB）随安装包分发，不单独下载。

权重落在 `%APPDATA%\app.sabir.desktop\models\asr\<模型 id>\`；「高级 → 下载位置」可以改到别的目录，之后下载的模型都放那里。下载站默认先试 `hf-mirror.com`，再试 `huggingface.co`；需要别的镜像时设置环境变量 `SABIR_MODEL_BASE`。

开发时也可以不放模型目录：把已有的 sherpa 流式模型目录用 `SABIR_MODEL_DIR` 指向，或在设置里用「浏览…」选目录。

### 2. sherpa-onnx 运行库

Windows 的静态库是 `/MT`，和 Rust 默认的 `/MD` 不兼容，因此项目使用 shared 版本：

```powershell
cd apps/desktop/src-tauri
New-Item -ItemType Directory -Force vendor/sherpa
curl -L -o vendor/sherpa/sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib.tar.bz2
tar -xjf vendor/sherpa/sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib.tar.bz2 -C vendor/sherpa --strip-components=2 "sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib/lib/sherpa-onnx-c-api.dll" "sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib/lib/sherpa-onnx-cxx-api.dll"
```

`src-tauri/.cargo/config.toml` 已把 `SHERPA_ONNX_ARCHIVE_DIR` 指向这里，构建时无需联网。解出来的两个 DLL 是运行期依赖，`tauri.conf.json` 会把它们打进安装包；它们和翻译用的 `onnxruntime.dll` 都放在安装目录根下。

### 3. 本地翻译模型

句级翻译默认走 opus-mt en→zh 的 int8 ONNX（约 421MB），同样不随安装包分发。打开 **设置 → 翻译与聊天**，选中「本地 NMT」，点「下载模型」即可；下载位置默认 `%APPDATA%\app.sabir.desktop\models\translate\en-zh`，同一张卡片里可以改目录、浏览已有目录或用「重新扫描」认出来。

开发时可以用 `SABIR_TRANSLATE_DIR` 指向已有目录，或把文件放到 `apps/desktop/models/translate/en-zh/`（仅 debug 构建会从这里加载）。不装这个模型也能用：设置里切到本地 LLM 或第三方。

### 4. 译文配音模型（可选）

「设置 → 配音」下载 Kokoro v1.1 中英双语模型（约 370MB，103 个音色，24 kHz）。下载站与识别/翻译相同（默认先试 `hf-mirror.com`，可用 `SABIR_MODEL_BASE` 改镜像），支持续传与取消，每个文件按仓库公布的 SHA-256 校验。权重落在 `%APPDATA%\app.sabir.desktop\models\tts\kokoro-zh-en-v1.1\`，不随安装包分发，也不影响识别/翻译模型。

装好后打开「朗读译文」并保存即可；没有模型时开关是禁用的。它只朗读译文，不需要额外运行库——复用的是第 2 步的 sherpa-onnx DLL。

### 5. ONNX Runtime（翻译用）

`ort` 预编译的 ONNX Runtime 是 `/MT` 静态库，和 Rust 默认的 `/MD` 冲突，因此翻译走 `load-dynamic`：运行时加载 `onnxruntime.dll`。把 x64 共享库放到：

```powershell
cd apps/desktop/src-tauri
New-Item -ItemType Directory -Force vendor/onnxruntime
Copy-Item target/debug/onnxruntime.dll vendor/onnxruntime/
```

`target/debug/onnxruntime.dll` 是 ort 构建缓存里的一份（本机实测 1.28.2）；任何兼容版本的 `onnxruntime.dll` 都可以，或用 `ORT_DYLIB_PATH` 指定路径。发布包会把该 DLL 映射到安装目录。

### 6. 运行

```powershell
pnpm --dir apps/desktop tauri dev
```

开发端口是 5180。首次启动会显示三步引导：说明音频边界、选默认音源、下载推荐识别模型（可跳过）。之后还没有识别模型时，Listen 会直接打开 **设置 → 识别**；下好模型并保存后，播放任意系统声音（课程、会议、视频），点 **Listen** 或按 `Ctrl+M`（macOS 为 `⌘M`），字幕会逐字出现并在静音处收束成句。每句定稿后，译文出现在原文下方；句子同时写进本地 `sabir.db`，字幕栏的「导出」可生成 Markdown 笔记、JSONL 或 SRT（默认 `Documents\Sabir`，可在 **设置 → 记录** 改目录，目录不存在会自动创建）。停止记录时（包括关闭主窗口与托盘退出）默认把这一场自动写成一份 Markdown 笔记，文件名与手动导出一致（`sabir-<日期>-<时分>.md`），可在 **设置 → 记录** 关掉。若在 **设置 → 配音** 下载了 Kokoro 模型并打开「朗读译文」，每句译文定稿后由 Rust 在本机合成 WAV，前端按原文顺序排队播放；只读译文，不翻译或本来就是中文的句子不读，停止录音、暂停或关闭窗口时立即停止。模型首次朗读时才加载。

听的过程中：`Ctrl+P` 暂停/继续（暂停时字幕与会话保留），`Esc` 停止。顶栏的图钉让窗口始终置顶，字幕栏的 A−/A+ 调字号。**设置 → 通用 → 显示录音浮标**打开后，录音时主窗口右下角会出现一个置顶小胶囊，上面可直接暂停/继续或停止，拖动可移动位置。**设置 → 通用 → 显示字幕浮窗**打开后，记录时屏幕底部会出现一个无边框的置顶双语字幕窗：只显示最近两句的原文与译文，尚未定稿的预览句以灰色斜体跟在后面；拖动字幕框即可移动（位置会记住，换了显示器也能落回去），右上角可调字号、回到主窗口或关闭。它不抢焦点（不会把正在看的视频或课程切到后台），暂停时保留，停止记录后自动隐藏；点它的关闭按钮等同于关掉这个开关。关闭主窗口默认不会退出：应用先停止正在进行的录音，再把窗口缩到系统托盘；单击托盘图标或菜单「显示主窗口」恢复，菜单里也能打开设置或退出。**设置 → 通用**的「关闭窗口时留在托盘」可以关掉这个行为，关掉后关闭主窗口就直接退出。**顶栏「Live session」右侧有音源下拉**，空闲时可直接在系统声音、麦克风、系统声音 + 麦克风之间切换（写入 `audio.json`，下一次开始录音生效）；「选择单个应用…」和「选择应用与设备…」会打开 **设置 → 识别**。设置页仍可选四种音源：系统声音、麦克风、系统声音 + 麦克风（两路混音）、单个应用（只抓某个正在播放的程序，Windows 10 2004+），并可分别指定输出/输入设备；没有模型时还会显示本机内存、核心数与推荐的首个模型。

顶栏的书本图标打开**会话库**：本机所有场次按时间列出，可按标题、音源或字幕内容搜索，点开可读原文与译文、导出三种格式，或删除整场。标题右侧的铅笔可直接改名（Enter 保存、Esc 取消，最多 80 字，空标题会被拒绝），列表与详情同步更新。字幕栏右侧的 **Ask this session** 用当前转录回答问题：设置里配好本地 LLM 或第三方接口后，输入问题回车即可，回答会边流式输出边标注引用行（悬停时间戳即可对照原文）。没有接口时这里会明确提示先去「翻译与聊天」配置。会话库顶栏的「跨场次问答」把范围扩到本机全部场次：提问后 Rust 从历史字幕里按词检索（最多送回 40 行，每场最多 12 行，按命中词数与新旧排序），把带编号的原文交给当前配置档的模型，回答流式输出并用 `[n]` 标注引用；下方「检索依据」列出用到的每一行，点一下会打开对应场次并滚动到那句话。「只检索」按钮只列匹配行，不调用模型。会话库顶栏的「全文检索」是另一套：它用本机 SQLite FTS5 的 `trigram` 索引在全部原文与译文里查找，按 bm25 相关度排序，结果显示场次、时间和命中片段，点一下会打开对应会话并跳到那一句；不足 3 个字的词自动退化为普通包含匹配。

右上角齿轮或底栏的翻译徽章打开设置：三条路径（本地 NMT / 本地 LLM / 第三方）、翻译成什么语言、「不翻译只记录原文」、上文句数、失败回退。第三方路线支持多套 **Provider 配置档**（最多 10 套）：每套有自己的名称、接口地址、模型、授权记录与 API Key，可随时切换当前配置档；「新增」从空白开始，也可以用 OpenAI / DeepSeek / OpenRouter 快速新建。当前配置档同时用于翻译与问答，删除配置档会一并删除它的 Key。每套 Key 分开存系统钥匙串（Windows 凭据管理器），设置写在 `%APPDATA%\app.sabir.desktop\settings.json`，Key 不在其中。「导入配置档… / 导出配置档…」读写一份 JSON，只含名称、接口地址与模型，不含 API Key、授权记录和内部 id；导入会先加到未保存的列表（总数仍受 10 套上限约束），点「保存」后生效，Key 需要重新填写，首次发送前也要重新勾选同意。

**设置 → 场景与术语**支持多个场景预设：每个预设有自己的名称、一两句场景背景和一张「原文 → 期望译法」术语表（每预设最多 200 条，最多 20 个预设），保存时自动去掉空行与重复原文。首页空闲时可以直接在下拉里切换当前预设，点「管理…」进入设置编辑；「通用（不限场景）」预设始终保留。当前预设会统一本地 LLM 与第三方翻译的译法，并作为问答的理解背景；流式 Zipformer 还会把当前预设的原文术语作为识别热词（下一次开始录音生效）。内容存在 `glossary.json`，只在本机；本地 NMT 与 Whisper 整段识别不读取术语表。「导入预设… / 导出预设…」读写一份 JSON（名称、场景与术语，不含内部 id，也不含「通用」预设）；导入的预设会追加到当前列表并标为当前项，点「保存」后才落盘，预设数与术语条数仍受上限约束。

**设置 → 插件**负责脚本插件与事件流：命令保存在 `%APPDATA%\app.sabir.desktop\plugins.json`，只有点「保存」才写入；「测试命令」会临时启动一次并等一个改写结果给反馈。事件流不受开关影响，每场监听都写 `streams\<会话 id>.jsonl`（开始时截断重建），协议与命令示例见上文第 7 节。

本地 LLM 的默认地址是 `http://127.0.0.1:11434/v1`（Ollama），模型名按你本地已有的填，例如 `qwen2.5:3b`。

**设置 → 通用**管两件全局偏好：「界面语言」可选简体中文或 English，保存后窗口重载，识别/翻译语言仍在各自下拉里单独设置；「关闭窗口时留在托盘」默认开启，关闭主窗口时先停止录音再隐藏到托盘，托盘菜单可恢复或退出。**设置 → 记录**管目录与笔记：「记录目录」指定自动笔记与手动导出的落点（点「选择…」选目录，或恢复默认的 `Documents\Sabir`）；「会话结束后自动保存 Markdown 笔记」默认开启，每次停止记录时把这一场的原文与译文写成一份笔记，没有字幕的会话不写。偏好都存在 `%APPDATA%\app.sabir.desktop\general.json`，Rust 读取它决定导出落点、自动笔记、后端提示语言与关闭行为。

### 7. 命令行与脚本插件（可选）

命令行工具不在默认构建里，单独打开 `cli` feature：

```powershell
cd apps/desktop/src-tauri
cargo build --release --features cli --bin sabir
```

产物是 `target\release\sabir.exe`，默认读 `%APPDATA%\app.sabir.desktop\sabir.db`（可用环境变量 `SABIR_DB` 指到别处），事件流目录是同级的 `streams\`：

```powershell
sabir list
sabir search "灰度发布" --limit 20
sabir show 3 --format md
sabir export 3 --format srt --out notes\demo.srt
sabir stream --follow
```

`search` 每个结果输出一行 JSON；`list --json` 输出整个数组；`stream` 不带参数打印最新一场的事件流，`--follow` 从文件当前末尾持续追加（每 250ms 轮询，文件被截断会从头读）。

脚本插件在 **设置 → 插件** 开启：填一条本机 shell 命令（例如 `python C:\plugins\sabir.py`）。每次开始监听时启动，stdin 收到 JSONL 事件，stdout 每行返回一个 JSON 即可改写译文：

```json
{"type":"rewrite","id":1,"text":"改写后的译文"}
```

事件以 `session` 头开始（`id`、`title`、`startedAt`、`endedAt`、`source`、`asrModel`、`translateRoute`），之后是 `status`、`partial`、`final`、`translationDelta`、`translationDone`、`translationError`、`error`，结尾 `sessionEnd`；每行都带 `sessionId`，电平事件不发送。`translationDone` 发出后应用最多等 400ms 的改写，超时或返回空文本就用原译文；改写后的译文会一并写进 SQLite、导出与配音。命令经系统 shell 运行，应用不联网；脚本 stderr 与 `{"type":"log","message":"…"}` 只进日志。`sabir stream --follow` 可用于调试同一份事件流。

## 托盘、自动更新与诊断

- **托盘**：关闭主窗口时，应用先停止当前录音，再把窗口隐藏到系统托盘（不会在后台继续采集）。单击托盘图标恢复窗口；右键菜单有「显示主窗口」「设置…」「退出 Sabir」。**设置 → 通用 → 关闭窗口时留在托盘**默认开启，关掉后关闭窗口即退出。
- **自动更新**：打开 **设置 → 关于与诊断**，点「检查更新」；只在打开面板后手动检查，不在后台轮询。发现新版本后可「下载并安装」，进度与错误都显示在同一张卡片里，安装完成后点「立即重启」。更新源是 `tauri.conf.json` 里的 `plugins.updater.endpoints`，当前指向 `https://github.com/yixin8875/sabir/releases/latest/download/latest.json`；安装包与 `latest.json` 都由私钥签名，客户端用内嵌公钥校验。
- **诊断包**：同一面板的「导出」会写出一个 zip，包含应用/系统版本、数据库计数与 `integrity_check`、脱敏后的设置副本（`general` / `audio` / `asr` / `translate` / `voice` / `plugins`，去掉 Key、token、password、consent、command 等字段）与日志尾部（每个日志最多 256KB）。**不含**字幕正文、音频、SQLite 数据库、术语表内容、JSONL 事件流或 API Key；日志里可能有会话标题等元数据。导出只写到你选择的路径，不上传。
- **发布**：版本号用 `node scripts/set-version.mjs x.y.z` 同步到 `package.json`、`tauri.conf.json` 与 `Cargo.toml`，推送 `vX.Y.Z` 标签后由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 构建 NSIS/MSI 安装包、签名与 `latest.json` 并创建草稿 Release；签名密钥、自检与回滚步骤见 [RELEASING.md](RELEASING.md)。
- **Git**：远程为 `https://github.com/yixin8875/sabir`，以 `main` 为基线；功能在独立分支开发后合入。运行库与模型权重不进仓库，由 `scripts/fetch-vendor.ps1` 与应用内下载获得。

## 已知限制

- 只实现了 Windows 的 WASAPI 采集；macOS（ScreenCaptureKit）和 Linux（PipeWire）尚未接入。
- 混音是两路 16 kHz 单声道直接相加，按到达顺序对齐，不做精细时钟校正；按进程采集依赖 WASAPI 进程回环，只有已经产生音频会话的应用才出现在列表里，且系统声音/其它应用不会混入。
- 问答分两种：就当前屏幕字幕提问（上下文上限约 1.2 万字），以及会话库里的跨场次问答。跨场次检索用 SQLite `LIKE` 做关键词匹配（英文按单词、中文按字二元组，并去掉常见疑问词/助词），按命中词数和新旧排序，最多送回 40 行（每场最多 12 行）；没有 FTS 索引或向量检索，问法太抽象、同义词或只出现在译文里的词可能找不到，此时可退回「只检索」。回答质量取决于配置的模型。
- 会话库的「全文检索」用 SQLite FTS5 `trigram`：每个检索词至少 3 个字符（英文按单词、中文按连续 3 字），不足 3 字时退化为 `LIKE` 包含匹配；只索引原文与译文，不含问答或导入文件；按 bm25 排序，没有向量、同义词或模糊检索，片段由 Rust 截取而不是原文高亮。旧数据库首次打开会自动重建一次索引。
- 脚本插件是单条本机命令、每场监听一个进程：改写只作用于 `translationDone` 的译文，等待上限 400ms，超时、空输出或与原译文相同就不改；stdout 必须是 UTF-8 JSONL，非 JSON 行与 stderr 只进日志。插件崩溃后本场不再改写（下次开始监听才重启），事件流不受影响；浏览器预览不会运行本机脚本。
- CLI 与桌面应用共用同一个 SQLite 与 `streams/`，只读会话、检索、导出和事件流，不提供写入或删除；应用正在录音时也能读（WAL），但导出只包含当时已落盘的内容。
- 默认的双语 int8 模型中文表现稳定，英文准确率一般；词表全大写，Rust 侧已归一化为句首大写。
- 句末判定依赖 2.4 秒静音；连续说话时不切句。Whisper 模型按 0.55 秒停顿切句，停顿后整句解码才出字，Turbo 每句再多约一秒；连续不停顿时 VAD 最多切到 12 秒一段。解码在独立线程，采集不会被它阻塞；解码跟不上时最多积压 6 段，超出会丢最旧的一段并在日志里记一条 warning，停止记录会先把积压的段解完再结束会话。
- 识别只有 CPU 推理：预编译的 sherpa-onnx 运行库不带 CUDA/DirectML provider，暂不支持显卡加速。
- 本地 NMT 只做 en→zh，且逐句翻译不带上下文；中文句子直接跳过（标为「已是中文」）。译文可读性优先用本地 LLM 或第三方。
- 场景预设与术语只作用于本地 LLM / 第三方翻译和问答；本地 NMT 逐句翻译不读取术语表，Whisper 整段识别不支持热词（Zipformer 流式模型支持）。切换预设后翻译与问答立即生效，识别热词要到下一次开始录音才更新；热词效果取决于所选模型的词表与解码器，未逐模型校准。
- 英文界面覆盖全部前端文案、模型目录、引擎状态与导出文件表头；少量底层错误、系统提供的设备名，以及旧会话里已存的中文音源字段可能仍显示中文。
- 语言切换通过重载窗口生效；三步引导的「已完成」标记存在 WebView 的 localStorage，清空站点数据后会再次出现。
- 术语表 / 配置档的导入导出只覆盖可分享的内容：不含 API Key、授权记录与内部 id；导入配置档后 Key 要重填，第三方仍须重新同意。浏览器预览里用下载文件与隐藏的文件选择框模拟，安装版走系统文件对话框。
- 配音只支持中英双语 Kokoro：103 个音色里固定用中文女声 `zf_001` 与英文女声 `af_maple`，语速固定；只朗读译文，不读原文；词典里查不到的英文单词会被跳过，`RSI` 这类短缩写按字母朗读。没有音色/语速/音量选择，也没有「落后自动加速」。
- 配音模型约 370MB，首次朗读才加载进内存（额外数百 MB）；播放走 WebView 的 `Audio`（base64 WAV），队列最多 6 句，长时间落后会丢弃新句而不是加速。
- 自动更新只在「设置 → 关于与诊断」里手动检查，没有后台轮询、启动自检或静默下载；更新源已指向 `yixin8875/sabir` 的 Releases，仓库还没有发布版本时「检查更新」会报 404。
- 关闭到托盘前会先停止当前录音（与点停止一样会落自动笔记），所以托盘应用不会在后台继续采集；托盘菜单「退出 Sabir」在录音中也会先结束这一场再退出。托盘图标固定使用应用图标，录音中不改变外观，也没有录音时长提示。
- 诊断包只含环境、计数、脱敏设置与日志尾部：不含字幕正文、音频、数据库文件、术语表、事件流和 API Key。日志可能带会话标题与路径等元数据；导出路径由用户选择，不会自动上传。
- 安装包不含任何模型权重（识别、本地 NMT 与配音都在设置里下载，识别模型可改下载目录）；尚未做代码签名，首次安装会有 SmartScreen 提示。
- 自动笔记只在正常结束一场时写（点停止、关闭主窗口、托盘退出），进程崩溃或被强制结束时没有；没有定稿字幕的会话跳过；文件名按开始时间精确到分钟，同一分钟内开始并结束的两场会写到同一个文件并覆盖；笔记只是 Markdown 导出，不含问答内容。写入失败只记日志，不弹窗。
- 字幕浮窗只在记录中显示，且只显示最近两句原文与译文加尚未定稿的预览句，不显示问答或会话库；位置与字号存在 WebView 的 localStorage，清空站点数据或重装后回到默认位置与字号；窗口无边框，Alt+F4 等同关掉这个开关；它不抢焦点，所以不能在浮窗里输入或切换音源。

## 许可

计划以 MIT 发布；第三方模型与库的许可见方案文档附录。
