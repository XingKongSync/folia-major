# 本分支的定制清单（LOCAL-PATCHES）

这个文件只属于我们自己的定制分支 `folia-local`，**不提交给上游、不提 PR**。它的用途只有一个：当下次把上游新版合并进来时，能一眼看出"哪些冲突必须认真解、哪些可以无脑取上游、每个补丁该怎么验"。

- 基线：上游 `v0.7.22`（`1f6d0f46`，2026-10-23），本次同步于 2026-10-24
- 分支：`folia-local`（`origin` = 上游，只 fetch 不 push）
- 部署：unraid 上的 `folia-web` 容器，前端通过卷挂载到 `/usr/share/nginx/html`

---

## 同步流程（跟 tag，不跟 main）

上游一天可能好几个提交，跟 `main` 没有意义；跟 **发布 tag** 才有明确的边界和版本号。

```bash
cd folia-major
git switch folia-local
git fetch origin --tags
git log --oneline HEAD..v0.7.xx        # 先看有什么，再决定值不值得合
git merge v0.7.xx
git diff --name-only --diff-filter=U   # 冲突清单
# 依赖变了就要重装（2026-10 那次新增了 qishui-music-api）
git diff --name-only HEAD@{1} -- package.json package-lock.json && npm ci
npm run typecheck && npm run test:unit && npm exec vite build
git tag local-v0.7.xx                  # 验收通过才打标签，便于回滚
```

**用 merge，不要 rebase**：`1d814de6` 已经是一个真实的 merge 提交，所以下一次 `git merge` 只处理新增的部分；rebase 会让我们的提交每次都被重写、冲突重复解、推 fork 还得 force-push。

**发布与合并解耦**：合并与构建都发生在开发机上，产物在 `dist/`；线上只在确认可用后更新挂载目录。合并验不过就保持线上旧版。

---

## 四个补丁

### 1. iOS 直通音频（最关键）

- **为什么**：iOS WebKit 上只要调用 `createMediaElementSource`，元素在**外部输出路由**上就再没有声音——AirPlay 完全静音，CarPlay 放约 1 秒后静音。三次实测（扬声器 / HomePod / CarPlay）的对照表与 WebKit 缺陷见 `src/utils/platform.ts` 的注释，相关报告：WebKit 293891、311000。
- **改了什么**：`canBuildPlaybackGraph()` 在 iOS 上返回 false，`setupAudioAnalyzer` 直接跳过建图，元素保留原生输出。
- **涉及文件**：`src/utils/platform.ts`、`src/components/app/playback/bridges/usePlaybackAudioBridge.ts`
- **上游高概率改这里**：`usePlaybackAudioBridge.ts` 的 `setupAudioAnalyzer`。冲突时取上游结构，把"不建图"的提前返回重新放在函数最前面即可。
- **验证**：手机日志出现 `[AudioContext] direct output: the media element is not wired into Web Audio on iOS`；**并在车上确认真的有声**（这条只能上车验）。

### 2. 包络驱动的可视化（无 analyser 时的替代数据源）

- **为什么**：直通之后没有 analyser，可视化的五个频段值就没有来源，会永久停在"呼吸"分支。可视化本身只需要 `audioPower` + `audioBands.{bass,lowMid,mid,vocal,treble}` 这六个数值，所以能改由**预分析包络**驱动。
- **改了什么**：离线解码（22.05 kHz）→ 逐帧算五个频段（沿用实时路径的 0..255 刻度、21.53 Hz 的 bin 宽度、Blackman 窗、0.6 平滑）→ 播放时按 `audio.time` 查表。
- **涉及文件**：`src/services/audioEnvelope/*`（新增）、`src/hooks/useAudioEnvelopeTrack.ts`（新增）、`src/components/app/playback/bridges/usePlaybackVisualizerBridge.ts`
- **上游高概率改这里**：可视化循环本身（2026-10 那次上游在此文件改了 205 行，加了后台节流与预览片段时钟）。冲突时以**上游的循环结构为准**，把"包络分支"重新插到 `else if (hasAudibleSignal && analyserRef.current)` 之后。
- **刻度标定**：2026-10-22 在同一首歌上对比 Safari 实时值与包络值，前 60 秒 p50 逐频段差 ≤3（treble 差 8，因为离线只有 11 kHz 奈奎斯特）。**当时没有改任何常量**，所以这套 -100..-30 dB / ÷fftSize 的复刻是准的；如果哪天观感明显偏平，先怀疑这里。
- **验证**：手机日志出现 `[AudioEnvelope] ... p50/p90/max ...`。

### 3. 安全区让位（CarPlay 分屏时的系统坞）

- **为什么**：CarPlay 1/3、2/3 布局时系统坞贴在屏幕底部、覆盖在页面上，把进度条和右下圆钮压住。实测 1/3 = 355×592、2/3 = 736×592 时 `env(safe-area-inset-bottom)` = **49px**，全屏 1076×592 时为 0（坞移到左侧）。
- **改了什么**：`index.html` 的 viewport 加 `viewport-fit=cover`（**不写这一项，`env()` 恒为 0**）；底部基线统一从 `playerBottomBarLayout.ts` 取补偿量，值由一个一次性探针元素的 `paddingBottom` 读出（不经过 CSS 自定义属性——`--x: env(...)` 的 `getPropertyValue` 不保证解析成像素）。
- **涉及文件**：`index.html`、`src/index.css`、`src/utils/playerBottomBarLayout.ts`
- **上游改动**：目前 0 次，冲突风险最低。
- **验证**：车上 1/3 与 2/3 布局底栏整体上移 49px；iPhone PWA 上底栏上移约 34px（主屏指示条），属预期；桌面逐像素不变（`env()` 为 0）。

### 4. Navidrome 歌词导出与导入

- **为什么**：批量导出原来只覆盖「在线音源缓存」和「本地曲库」两类，Navidrome 两不沾边：它的匹配结果存在 `navidrome_match_<id>`，而 Navidrome 歌曲也不在 `getLocalSongs()` 里。于是 Navidrome 用户能匹配、能看，却一首也导不出。
- **改了什么**：
  - 导出新增 `navidrome` 范围：枚举 `navidrome_match_*`，用 `navidromeApi.getSong` 补标题/艺人/专辑（失败也保留歌词）。
  - 导入新增命令「Import lyrics from an archive」：读 zip 里的 `.fia`，**按 `song.key` 归位**，不需要正在播放；`navidrome:` 写匹配缓存、`online:` 写 `lyric_*_state`，`local:` 与无 key 的文件如实拒绝。
  - Navidrome 页签也支持单曲导入（写同一个匹配缓存）。
- **涉及文件**：`src/services/lyricExport/{collectNavidromeLyrics,importLyricArchive,runLyricExport,types}.ts`、`src/utils/{appNavidromeLyrics,onlineLyricsState}.ts`、`src/utils/lyrics/foliaLyricDocument.ts`、`src/components/panelTab/NaviTab.tsx`、`src/components/UnifiedPanel.tsx`、`src/components/command-palette/**`、三份 i18n
- **上游改动**：除 i18n 外目前 0 次。
- **验证**：导出范围里出现「Navidrome 匹配歌词」；导出的 zip 在另一台设备批量导入后，同一首歌下次播放即为导入的歌词。

---

## 四条不变量（每次同步后逐条过）

| # | 不变量 | 判据 | 只能在车上验？ |
|---|---|---|---|
| 1 | iOS 不建图 | 日志 `[AudioContext] direct output: ...` | 否（日志）；**能出声要上车** |
| 2 | 包络驱动可视化 | 日志 `[AudioEnvelope] ... p50/p90/max ...` | 否 |
| 3 | 安全区让位 | 分屏时底栏不被系统坞压住 | **是** |
| 4 | 歌词导入导出 | 导出范围含 Navidrome；`.fia` 往返成功 | 否 |

构建期三条：`npm run typecheck`、`npm run test:unit`、`npm exec vite build`。构建时需带上网关镜像的编译期变量（否则在线音源会变成"未配置"）：

```
VITE_NETEASE_API_BASE=/netease  VITE_KUGOU_API_BASE=/kugou  VITE_QQ_API_BASE=/qq
VITE_AI_PROVIDER=google  APP_VERSION_LABEL=Docker  APP_RELEASE_CHANNEL=docker
DOCKER_STACK_VERSION=<deploy/docker/VERSION>  GITHUB_REPOSITORY=chthollyphile/folia-major
```

---

## 稀疏检出的目录清单

仓库是稀疏检出（`--filter=blob:none` + sparse）。**上游只要新增一个顶层目录，构建就会失败**（已经踩过 `dev`、`api`、`packaging`、`public`、`assets`、`build` 六次），补上即可：

```
git sparse-checkout add <目录名>
```

当前需要：`src shared electron docs test skills dev api api-ts worker mods .github packaging public assets build img sync-server deploy`

## 其他约定

- 每次同步验收通过后打本地 tag：`git tag local-v0.7.xx`，出问题一条命令回到上一个可用版本。
- 浅克隆（`--depth=200`）迟早不够，需要时 `git fetch --deepen 1000` 或 `git fetch --unshallow`。
- **什么时候该删掉某个补丁**：
  - 上游自己实现了 iOS 直通 / 兼容模式 → 用他们的，删我们的门；
  - WebKit 修好 293891（元素接图不再掐断外部路由）→ 直通门可以撤，恢复完整音频能力。
  第 1 条补丁的注释里保留了 WebKit 链接，就是为这件事留的。
