# 发布与自动更新

本项目用 Tauri 2 的构建产物发布：Windows 安装包（NSIS `.exe` / WiX `.msi`）、自动更新包与 `latest.json`。所有产物由 GitHub Actions 在 `windows-latest` 上构建，更新下载经 Minisign 公钥校验。

## 一次性准备

1. **仓库地址**：把 `apps/desktop/src-tauri/tauri.conf.json` 里的
   `https://github.com/OWNER/sabir/releases/latest/download/latest.json`
   改成实际仓库（`OWNER` 换成 GitHub 用户名或组织名）。自动更新只认这个地址。
2. **签名密钥**：仓库外已生成私钥 `C:\Users\86176\.livetrans\updater.key`
   （无密码）。这份私钥**不要提交、不要贴进 issue**；丢失后旧版本无法验证新更新，只能让用户手动重装。建议离线备份一份。
   在 GitHub 仓库 Settings → Secrets and variables → Actions 添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：`updater.key` 的完整内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：留空（生成时未设密码；若有密码则填密码）
   公钥已内嵌在 `tauri.conf.json` 的 `plugins.updater.pubkey`，与私钥配对，勿改。
3. **Actions 权限**：仓库 Settings → Actions → General 允许 workflow 写入内容（默认 `GITHUB_TOKEN` 带 `contents: write`，workflow 已声明）。
4. **运行库**：`scripts/fetch-vendor.ps1` 会在 CI 下载 sherpa-onnx、onnxruntime 与 Silero VAD；本地开发同样运行它（或按 README 第 2/4/5 节手动下载）。

## 发布步骤

```powershell
# 1. 决定版本号并同步三处 version 字段
node scripts/set-version.mjs 0.1.1

# 2. 确认改动、提交
git add -A
git commit -m "release: 0.1.1"

# 3. 打标签并推送（标签必须与 tauri.conf.json 的 version 一致）
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

推送标签后 `.github/workflows/release.yml` 会：

1. 校验 `package.json` / `tauri.conf.json` / `Cargo.toml` 版本一致，且标签 `v0.1.1` 等于版本号；
2. 跑 `cargo test --lib`；
3. `tauri build --bundles nsis,msi`，生成安装包、`.sig` 与 `latest.json`；
4. 在 GitHub Releases 建 **草稿**，上传全部产物。

## 发布后自检

1. 在 Releases 草稿里确认：`Sabir_0.1.1_x64-setup.exe`、`.msi`、对应的 `.sig`、`latest.json` 都在。
2. 安装上一版本，打开「设置 → 关于与诊断」→「检查更新」，应提示 `0.1.1`；下载安装后重启应显示新版本。
3. 手动安装新包做一次基本冒烟：能开始/停止录音、托盘可用、诊断包能导出。
4. 自检通过后再把草稿发布为正式 Release。`latest.json` 只在正式发布后对用户可见（`releases/latest/download/` 指向最新正式版）。

## 版本与标签约定

- 标签格式 `vMAJOR.MINOR.PATCH`；预发布用 `v0.2.0-beta.1`（`tauri.conf.json` 的 version 同步为 `0.2.0-beta.1`）。
- 同一个版本不要重复推标签；需要重发时先提升补丁号。
- `latest.json`、安装包与签名都由 CI 生成，不要手工上传或改名。
- 若要撤下某次更新：把该 Release 删除或转为 draft，用户端「检查更新」会回退到上一个正式 Release；已安装新版本的用户不受影响。

## 代码签名（可选）

当前 Windows 包未做 Authenticode 签名，首次安装会有 SmartScreen 提示；文档只说明如何核对来源与校验值，不引导关闭系统安全机制。若以后购入证书，在 `tauri.conf.json` 的 `bundle.windows` 增加证书配置，并把证书相关 secrets 加进 workflow。

## 本地构建安装包

```powershell
pwsh scripts/fetch-vendor.ps1
pnpm --dir apps/desktop install
pnpm --dir apps/desktop tauri build --bundles nsis
```

产物在 `apps/desktop/src-tauri/target/release/bundle/`。本地构建若要生成可用的 `latest.json` 与 `.sig`，需要先设置环境变量 `TAURI_SIGNING_PRIVATE_KEY`（指向 `updater.key` 内容或路径）；不设置时 `createUpdaterArtifacts` 的签名步骤会失败，普通安装包构建请用上面的 `--bundles nsis` 并忽略 updater 产物。
