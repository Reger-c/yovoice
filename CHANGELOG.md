# Changelog

各版本的重要更新记录。日常改动记入 `Unreleased`；发布前合并重复项，整理为简短的功能、改进和修复说明。

## [Unreleased]

- 音乐创作区的风格配置移至右侧检查器，参照情绪预设提供纯文本风格预设（无 emoji，网格布局，支持“更多风格”与“微调元素”分类折叠与重置）；左侧创作区移除多余的纯文本多行框，升级为一体化可输入风格标签盒，支持直接在胶囊后键入添加、退格删除与一键清空，大幅释放歌词创作垂直空间。
- AI 写作栏（写谱、写歌词）未配置时移除快捷连接按钮，统一通过“设置 AI”进入配置；打开 AI 设置时默认聚焦服务列表首项；右侧检查器移除“返回正文”按钮，窄屏下展开时保持与宽屏一致的面板宽度浮出，不再全屏覆盖正文。
- 音频读不到（如文件已被删除）时，播放器与故事时间线直接标出不可用，不再主动弹出“音频无法播放”，只在试听或播放时说明原因；打开作品只预读音频时长，再次试听同一段音频不再重新读取；弹窗背景去掉模糊，修复 macOS 上弹窗背后出现一圈边线的问题。
- 作品、音色、模型和设置改为保存在数据目录的 SQLite 数据库 `yovoice.db`：每次保存在一个事务中只写入改动的内容，断电或崩溃不会留下写了一半的数据，作品较多时保存也不再越来越慢；每次启动自动备份为 `yovoice.backup.db`，数据库损坏时自动从备份恢复并保留损坏原件。升级后首次启动自动导入原来的 `state.json`（原文件改名为 `state.migrated.json` 保留），本机接口设置和 AI 密钥也一并移入数据库，迁移数据目录后不再丢失。
- 数据安全：删除作品、历史、音频和清理残留统一按同一份引用登记判断文件是否仍在使用，共享的素材不会被误删；接口生成的历史 24 小时内不再被自动修剪；启动自检只在确认文件不存在时才移除时间线片段和素材，外置盘或目录暂时读不到时不再删除，修复前自动留存快照；迁移数据目录复制期间可以继续编辑和保存作品；存储配置损坏时明确提示而不是静默回到默认目录；连续迁移多次时每个旧目录都会被清理，清理只删除应用创建的内容，旧目录里用户自己放的文件保留。
- 修复迁移数据目录超过 2 分钟（如跨盘复制模型）时界面误报未知错误、Windows 也不提示重启的问题；修复模型失败与生成失败提示互相恢复已关闭提示、离开角色页后右上角面板开关偶尔无效的问题；CLI 与 `yovoice mcp` 默认使用桌面应用迁移后的数据目录，不再回到会被删除的 `~/.yovoice`。
- 修复 Windows 退出时本地服务未及时结束导致窗口卡在无法使用的状态、服务启动超时后残留进程的问题；Windows 关到托盘后原窗口位置不再拦截鼠标；macOS 退出时本地服务无响应可选择仍要退出。
- 本机接口与桌面界面同时生成时，接口不再误报失败或误取消界面里的生成；存储与本机接口设置读取失败时显示原因和重试，不再整组消失；更改数据目录时，选择文件夹期间不再提前弹出迁移进度。
- 创作区较窄时右侧面板自动收起，由窗口右上角开关展开或收回，正文不再显示额外的面板按钮；“填入示例”“AI 写作”和 OrcaRouter 连接改用更贴切的图标。
- 修复 Windows 窗口最小化后，原窗口位置仍拦截鼠标、桌面右键菜单无法弹出的问题；从托盘打开最小化的窗口时会直接还原。
- 下载或导入模型可与生成同时进行：模型进度单独显示并可单独暂停，生成不再被下载阻塞；正在下载的模型不能被移除或用于生成。
- 单个页面渲染出错时只显示该页的错误提示（可重试或重新加载，重新加载前先保存正文），不再整个窗口白屏。
- 本地服务意外停止时可在应用内一键重新启动，重启后自动补存停止前未保存的修改，补存失败可另存备份（Windows 与 macOS）。
- 应用异常退出后推理进程不再残留：Windows 随应用自动结束，下次启动也会清理上次遗留的推理进程。
- 推理与本地服务日志改为追加写入同一文件、每次启动写一行分隔，超过 5MB 才滚动为 `.1`；崩溃后重启时上一轮的出错原因仍保留在文件中。
- 更换模型目录时自动识别新目录中已有的完整模型（按应用下载的目录布局），无需重新下载或手动导入。
- 窗口最小宽度提高到 960；创作区宽度不足（如侧栏拖宽）时右侧面板自动改为与正文切换显示，正文和面板不再被挤压变形。
- 磁盘空间不足时明确提示“磁盘已满”，不再显示难以理解的系统错误。
- Windows 原生菜单、托盘、对话框与错误提示支持英文，跟随设置中的界面语言即时切换。
- Windows 自动更新在应用已签名时校验更新包的发行者签名，签名不一致时拒绝安装；正式发布配置证书后自动签名应用、服务与安装包。
- 自定义数据目录被删除、改名或所在磁盘未连接时，启动不再静默新建空目录，而是提示重试、退出或新建空目录；运行中数据目录丢失时保存会明确提示目录不存在；迁移后的新目录若是空的不再自动删除旧目录，避免误删唯一一份数据；Windows 退出时作品保存失败也可选择不备份直接退出。
- 新增 Breeze TTS 2（中英，Q4 / Q8 / BF16）：可用文字描述设计音色，或用参考音频和原文克隆并以描述调整语速、情绪和语气；默认缩短分段、限制单段生成长度并在显卡上使用 bf16 推理，减少拖音和长段静音。模型需要 v0.9.1 内核，权重仅限非商业用途。
- 新建作品菜单新增“导入文件配音”：导入 TXT 或 Markdown 文本直接生成语音作品，导入 SRT、VTT、ASS 字幕生成故事作品；自动识别 UTF-8、UTF-16 与 GBK 编码，Markdown 的标记符号会被去掉。
- CLI 新增 `yovoice mcp`，以 stdio 方式提供 MCP，Claude Desktop、Cursor 等本机客户端可直接作为子进程启动，无需令牌；结果直接返回生成音频的本机路径，`upload_voice` 也可按本机路径导入参考音频。
- 设置 › 常规新增“本机接口”：开启后在 127.0.0.1 上提供与 `yovoice serve` 相同的 HTTP / MCP 接口（默认端口 8080，可修改），本机其他软件凭访问令牌即可调用桌面应用里的模型生成语音；令牌可复制、重置，端口被占用时直接提示。
- AI 服务新增 OrcaRouter（兼容 OpenAI 接口）：点“免费连接 OrcaRouter”在浏览器登录并同意授权后自动添加，默认使用免费模型，不用复制密钥；免费模型被拒绝时分别提示还需等待几秒、内容超过免费长度上限或需要绑定 GitHub。
- Windows 与 macOS 应用内更新提示：发现新版本时弹出提示并在侧栏显示下载进度，可查看对应语言的更新内容，下载完成后一键重启更新；设置页新增“版本与更新”，可随时检查更新，更新后首次启动会提示新版本内容。
- 修复语音生成面板中“更多情绪”与“微调情绪”折叠按钮残留边框与背景的问题，统一为轻量幽灵折叠外观。
- 修复缺少乐谱数据的旧编曲作品在启动或打开时导致整个窗口白屏的问题，这类作品会自动补上空乐谱。
- 侧栏导航与新建作品菜单将“语音生成”置于首位（排在“故事配音”上方）；桌面端重新打开时默认展示作品列表（不自动打开内容页），并记住离开前所在的分类页面。
- 参考音频的“使用中”检查不再受生成历史阻断，删除音色时自动清空历史版本中的引用；删除作品时级联清理该作品的所有历史版本、导入的时间线素材及磁盘文件，异常条目和磁盘文件丢失也可正常删除。
- 设置 › 常规新增“存储”分组：直观展示数据目录与各类空间占用（模型、生成音频、参考声音与缓存），支持“更改位置”（带进度条弹窗把数据完整复制到新目录并改写路径，迁移中途失败不影响原目录；完全退出并重新打开后生效，旧目录随后自动删除以释放空间；重启前暂停保存修改，禁止设在应用安装目录或当前数据目录内）与“清理残留”（保护存活作品与时间线素材，回收超过 24 小时的孤儿历史版本与无引用文件）；Windows 全新安装在非系统盘时默认使用安装目录旁的 `yovoice-data` 目录并记住该选择，macOS 同样读取迁移后的数据目录。
- 优化 API 生成音频的生命周期管理：接口高频生成时只保留最新 50 条无所属作品的历史并释放物理音频，时间线仍在使用的版本不受影响。
- 数据生命周期治理：启动时自动修复时间线中指向已缺失版本或素材的悬空片段（此前会导致作品永久无法保存），并在后台自动清理残留，无需手动点击；“清理残留”额外回收故事作品中已被替换且 24 小时未编辑的逐句旧版本，以及 downloads 中超过 24 小时的内核安装包缓存；内核安装完成后立即删除安装包；移除应用下载的模型时同时删除模型文件释放空间，导入的模型仍只解除登记。
- 引用与重复数据治理：重复导入同一工程时复用内容完全相同的参考音频和角色，不再每次堆积副本；删除角色后作品与说话人自动解除关联并保留已复制的设置；字幕作品中被说话人设置覆盖、界面不可见的作品级音色不再阻止删除参考音频，删除时一并清理；启动自检额外清理指向已删除角色或音频的悬空引用；`state.corrupt-*.json` 最多保留 3 份；Windows `host-service.log` 超过 5MB 时滚动切分。
- 更改数据存储位置后自动重启：迁移完成时弹出提示并自动退出、重新打开应用，新目录立即生效，不再需要手动从托盘退出；迁移前先保存界面中尚未落盘的正文，迁移后退出不再因旧目录冻结而报“作品保存失败”。
- 修复迁移数据目录后退出时报 `@yovoice.error.storageRestartRequired`“退出前未能保存作品”且无法退出：旧目录冻结期间的退出保存直接跳过；工作台测试整体隔离用户目录，运行测试不再改写本机 `storage.json`（此前会把真实应用的数据目录指向测试临时目录）。
- macOS 退出时作品保存失败（如运行中删除了数据目录、磁盘已满或外置盘断开）不再只能强制结束：与 Windows 一致提供“备份后退出 / 直接退出 / 返回编辑”，错误提示附带具体原因而非仅显示错误码。
- “当前作品”只存在于作品编辑页（含版本记录）：切到设置、声音库或作品列表时立即保存未落盘的修改并关闭作品，这些页面退出不再保存作品；内容未变化的保存不再改写状态文件，数据目录不可写时也不会因此挡住退出；删除当前作品后切换到的空白新作品不会在退出时被意外创建。

## [0.2.0] - 2026-10-11

### English

- New Music projects: set the style with tags, write lyrics with section markers or go instrumental, and generate full songs with ACE-Step 1.5 Turbo / XL Turbo or YuE2 3B (vocal songs whose length follows the lyrics; CC BY-NC 4.0, non-commercial). Each take is kept as a version you can preview, compare, reuse and export. Models made of several files can now be downloaded.
- New Score projects: write notes per track by bar and beat, import MIDI, or let an agent compose, then render every track with a General MIDI sound font and mix by role. The track area spans the bottom of the window with sections on the timeline, zoom, scrolling and a playhead; export MIDI or score JSON. Choose MuseScore General, GeneralUser GS or SGM-V2.01. The CLI adds `yovoice score render|midi|from-midi` with stems, MCP adds `render_score`, and the Agent Skill adds a score guide.
- Optional AI providers (DeepSeek, Qwen, Zhipu, Kimi, Doubao, MiniMax, OpenAI, Anthropic, OpenRouter, coding plans, local and custom endpoints) write a whole score or song style, lyrics and title from one sentence, run in the background, and can switch models on the spot.
- A refreshed interface: ticket-style project lists with record and cassette covers, grouped settings, a separate sound font page, side panel toggles in the title bar (the right panel toggle only appears in a workspace), and hover hints only for truncated text or icon buttons.
- The audio.cpp engine is upgraded to v0.9.1 and updates separately from the app; new Windows CUDA 12.4 and 13.3 installers.
- Fixes for long AI requests timing out, saving on exit, Windows time-zone saves, timeline menus, deleting the last project, and clearer error messages and diagnostic logs.

### 简体中文

- 新增“音乐生成”：用标签定风格，写带段落标记的歌词或改为纯音乐，由 ACE-Step 1.5 Turbo / XL Turbo 或 YuE2 3B（带人声、长度随歌词，CC BY-NC 4.0 仅限非商业）生成整首歌曲；每次生成保留为版本，可试听、对比、复用和导出。支持下载由多个文件组成的模型。
- 新增“编曲”：按小节和拍写各声部音符，或导入 MIDI、让 Agent 写谱，用 General MIDI 音色库逐声部渲染并按角色混音。轨道区横跨窗口底部，段落标在时间轴上，可缩放、滚动并显示播放指针；可导出 MIDI 或乐谱 JSON。音色库可选 MuseScore General、GeneralUser GS 或 SGM-V2.01。CLI 新增 `yovoice score render|midi|from-midi`（含分轨），MCP 新增 `render_score`，Agent Skill 新增编曲参考。
- 可选接入 AI 服务（DeepSeek、通义千问、智谱、Kimi、豆包、MiniMax、OpenAI、Anthropic、OpenRouter、编程套餐、本地与自定义接口），一句话写出整份编曲或歌曲的风格、歌词和标题，在后台进行，可随时切换模型。
- 界面焕新：票根式作品列表配唱片与磁带封面，设置页分组，音色库单独成页，左右面板开关集成到标题栏（右侧面板开关只在工作区显示），悬浮提示只在文字被截断或图标按钮需要说明时出现。
- 推理内核升级到 audio.cpp v0.9.1，与应用分开更新；新增 Windows CUDA 12.4 与 13.3 安装包。
- 修复长 AI 请求超时、退出保存、Windows 时区作品保存、时间线菜单、删除最后一个作品等问题，错误提示和诊断日志更具体。

## [0.1.7] - 2026-10-05

### English

- Run a remote speech service with HTTP API and MCP support. Submit, query, cancel, and download generation tasks with authentication, retry deduplication, and configurable timeouts.
- Use the Agent Skill with either a local CLI or a remote service. User guides and CLI packages now include separate English and Chinese documentation.
- Fix Windows save-error reporting and allow a recovery backup when saving on exit fails. Improve diagnostic logs for saving and generation failures.

### 简体中文

- 新增 HTTP API 与 MCP 远程语音服务，支持任务提交、查询、取消和音频下载，提供认证、重试去重与可配置超时。
- Agent Skill 支持本地 CLI 和远程服务；用户指南与 CLI 安装包提供独立中英文文档。
- 修复 Windows 保存错误提示，退出保存失败时可备份作品；完善保存和生成失败的诊断日志。

## [0.1.6] - 2026-10-01

### Added

- 角色支持保存多种演绎方式，每种演绎可独立选择模型和参数，故事台词和语音项目可分别选用。

### Fixed

- 统一演绎选择框与新增、更多按钮的尺寸和对齐。
- 修复音轨面板调高区域遮挡播放按钮的问题，拖拽仅在顶部横线附近触发，横线贴近面板上边线外侧，并缩小播放控制图标。
- 移除应用图标底板边缘的光带，清理透明轮廓杂点，并校准 macOS 图标的主体边界和小尺寸留白。

## [0.1.5] - 2026-09-29

### Added

- 新增故事配音与语音生成两类作品，支持字幕导入、分段生成和可编辑音轨。
- 新增音轨裁剪、撤销与重做、混音及 WAV 导出，支持作品归档导入导出与状态恢复。
- 新增 Kokoro 官方 BF16 模型下载。
- 新增版本变更日志，发布时自动将对应版本的说明展示到 GitHub Release 页面。

### Changed

- 移除待处理台词批量生成，播放时正文始终自动跟随。

### Fixed

- 优化音轨缩放、滚动、片段拖动与磁吸裁剪交互，统一单人和多人播放指针样式。
- 修复旧版 WebKit 下拉浮层样式，通知展示不再挤动工作台布局。
- 改进 Windows 窗口尺寸适配与位置保存，以及 macOS 应用启动和图标边距。

## [0.1.4] - 2026-09-26

### Added

- 新增角色库，保存并复用音色与声音设置；声音库与创作流程共用编辑能力。
- 新增 Kokoro 官方 Q8 模型下载及 49 个内置音色，支持实验性多语言和中文版本导入。

### Changed

- 优化声音库、生成历史、参考音频片段与原文管理，统一搜索、头像、音频试听和弹窗交互。

### Fixed

- 修复 macOS 麦克风权限回调崩溃，兼容旧版 macOS 的下拉选择器。
- 修复 VoxCPM2 长参考音频的编码器容量问题。
- 修复服务退出时未等待清理完成的问题，并保留 Windows 界面兼容修复。

## [0.1.3] - 2026-09-19

### Changed

- 优化 Windows 窗口边框、滚动、原生菜单与应用对话框。
- 新增代理开关和设置自动保存，调整下拉菜单定位。

### Fixed

- 修复 Windows 下载归档目录路径处理，完善 .NET 8 构建兼容性。

## [0.1.2] - 2026-09-18

### Added

- 新增 OmniVoice 与 Qwen3-TTS 模型及对应的声音设计、克隆和生成参数。
- 新增英文界面，支持语言偏好及 macOS 菜单、提示本地化。

### Changed

- 整理偏好设置、模型目录操作与生成控制面板。

### Fixed

- 修复 macOS 自动更新时 `lipo` 架构校验参数顺序错误。

## [0.1.1] - 2026-09-16

### Added

- 新增 VoxCPM2 Q8 / BF16，支持声音设计、音色克隆和参考原文辅助克隆，App 与 CLI 均可使用。
- 新增声音描述、引导强度、推理步数和随机种子设置。

### Changed

- 优化模型管理布局与按钮，下载期间可移除其他模型的登记。
- 简化 `make app-run`，分离日常启动与安装包制作；采用完整生成后播放。

### Fixed

- 修复 macOS 麦克风权限归属，改用原生权限请求。

## [0.1.0] - 2026-09-16

### Added

- 首个公开版本，提供 macOS Apple Silicon 与 Windows 桌面安装包。
- 支持 IndexTTS 2.0 / 2.5 本地生成、模型下载及 GGUF 导入。
- 支持参考音色、参考演绎、情绪调节、文字引导和参考音频录制。
- 提供声音库、作品历史、版本管理与音频试听。
- 提供 macOS、Windows、Linux 独立 CLI 与 Agent Skill，内置精简 FFmpeg 处理常见音频格式。
