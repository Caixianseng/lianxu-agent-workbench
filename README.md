# Agent Workbench · 多 Agent 协同工作台

一个本地中文 Web 平台：添加多个 Agent，选择主导，主导拆解目标后询问每项任务使用哪个 Agent / 模型，确认后执行、审查和纠错。支持兼容 OpenAI 格式的模型 API、本机 CLI，以及无需账号的演示模式。

这是可运行的第一版编排平台。当前交付内容为文本、分析和代码方案，**尚未实现自动修改目标项目、运行代码测试和合并代码**。模型审查不能保证正确性，主导也可能犯错；未通过的任务会保留失败记录并请求人工处理。

## 启动

需要 Node.js 20.18 或更高版本。工作台核心无需安装第三方 npm 依赖；可选的 Qoder CLI 单独安装在项目的 `data/runtime/qoder` 中。在项目目录运行：

```powershell
npm start
```

打开 <http://127.0.0.1:4317>。如需其他端口，先设置 `$env:PORT = '4318'`。服务仅监听本机。

使用系统文件选择功能时，请在**当前 Windows 登录用户的交互桌面**中，通过普通 PowerShell 运行 `npm start`。不要把服务放在受限开发沙盒或 Session 0 后台服务中运行，这些环境可能无法显示或操作系统窗口。

```powershell
npm test
```

测试使用演示模型、模拟 HTTP 响应和本地 CLI 测试夹具，不调用付费模型。

## 体验协同流程

1. 在协作设置中选择主导，在“与主导对话”聊天框输入项目目标并发送。
2. 主导提供任务、依赖、验收标准，并询问每项任务使用哪个模型。
3. 可保留轻量/均衡模型建议或调整分配，确认后才执行子任务。
4. 开启演示故障，可观察轻量模型首次遗漏内容、主导驳回、执行者修复的过程。
5. 任务卡中可查看逐次尝试、验收证据和事件，运行报告可以导出为 Markdown。

演示输出是固定示例，用于验证流程，不是模型真实完成的项目成果。演示 Agent 与真实 Agent 不会在同一次运行中混用。

## 用聊天指定任务分工

新建协作时可直接输入目标及分工要求，例如：“计算交给 @OpenCode CLI（模型 ID），整理交给 @Qoder CLI（模型 ID）”。聊天框下方的 Agent 按钮会插入名称和已配置的模型；主导仍由协作设置选择。主导生成计划时，将明确匹配的要求转为任务分工建议。

计划等待确认时，可继续发送“把 T01 交给 @Qoder CLI（Qwen3.8-Flash），其余保持当前选择”，或用任务标题描述分工。聊天只更新指定任务的建议，不会自动开始执行；核对下方每项任务的模型后，点击“确认模型，开始执行”。有歧义、目标模型未配置或能力不符合时需要补充说明。不同模型可分别添加为 Agent，同名时请带上模型 ID。

聊天调用计入本次调用预算，历史消息和分工调整随运行保存并可导出。规划或执行期间不能聊天更改当前分工；新的目标使用“新建协作”。演示模式只按明确的任务编号和 Agent 名称/模型匹配分工，不代表真实模型的自然语言理解。

## 接入 API

在 Agent 管理中添加 `openai-compatible` 接入，填写名称、完整模型 ID、能力等级、技能标签和 Base URL（例如服务商给出的 `https://…/v1`）。平台使用 `/chat/completions` 和 JSON 输出协议；模型与服务需要支持相应消息接口，并能遵守 JSON 格式。原生 Anthropic Messages、Gemini 等不同协议尚未直接接入，可使用相应兼容服务或 CLI。

密钥配置填写**环境变量名**，不填写密钥值。在启动服务的 PowerShell 中设置，例如：

```powershell
$env:MY_MODEL_API_KEY = '在此填入你自己的密钥'
npm start
```

页面密钥变量填 `MY_MODEL_API_KEY`。不需要密钥的本地接口可留空；本地 HTTP API 允许使用 `localhost` 或 `127.0.0.1`。远端 API 要求 HTTPS。平台不会在状态文件或前端保存 API 密钥。任务目标和产物会发送到你选择的服务商。

## 接入本机 CLI

在 Agent 管理中选择 CLI 接入。已有 CLI 请先完成安装和登录；OpenCode、Qoder 也支持选择桌面程序，由平台定位对应 CLI：

1. 点击“选择本地文件”，打开 **Windows 系统文件窗口**。
2. 在系统窗口中选择 Codex / Claude Code 的原生 CLI `.exe`、OpenCode.exe、Qoder Launcher.exe / Qoder.exe，或者带模型列表的本地 `.json` 清单，然后点击打开。也可直接选择支持的 OpenCode / Qoder CLI 程序。
3. 平台自动加载模型列表，并显示来源、可用的更新时间及提示。OpenCode / Qoder 会定位并调用对应 CLI 的列模型命令；不会启动所选桌面程序，也不会发起推理任务。在模型下拉框中选择本次使用的模型，无需手写模型 ID。
4. 填写 Agent 名称、能力等级和技能，确认添加。只有此时服务器才注册已识别的固定 CLI 配置；选择文件本身不会保存配置。取消系统窗口则返回页面，不添加 Agent。

已有 CLI 配置也可直接从配置下拉框选择，平台会重新加载其模型列表，再让你选择模型。如果没有发现明确模型，添加按钮会保持不可用；按页面提示完成 CLI 登录、刷新模型缓存、保存本地模型设置或补充 JSON 清单后重新加载。未登录的 Qoder 返回空模型列表，不会补入猜测的模型，也不能添加为 Agent。

文件选择凭据在 30 分钟后失效，过期后重新点击“选择本地文件”即可。窗口默认等待最多 5 分钟；请求取消或超时会关闭本次选择器进程。

系统窗口由 `scripts/NativePicker.cs` 的 WinForms 程序提供。首次使用时，如果 `bin/NativePicker.exe` 不存在，或 C# 源码比它更新，平台会使用 Windows 本机 .NET Framework 的 `Framework64/v4.0.30319/csc.exe`，不可用时尝试 `Framework/v4.0.30319/csc.exe`，编译到项目的 `bin` 目录。无需下载外部包；缺少编译器或目录不可写时，页面会显示明确错误。此功能目前仅支持 Windows。

模型发现的范围如下：

- **Codex**：读取 `CODEX_HOME/models_cache.json`，未设置 `CODEX_HOME` 时使用用户目录下的 `.codex/models_cache.json`；仅显示缓存中可展示的模型。列表可能属于之前登录的账号，超过 24 小时会提示刷新。没有缓存时，先打开 Codex 并登录，让 CLI 或桌面端生成缓存。
- **Claude Code**：读取 `CLAUDE_CONFIG_DIR/settings.json`，未设置时使用用户目录下的 `.claude/settings.json`；只提取明确的 `model`、`availableModels` 和已配置的模型环境变量。此列表不是账号全部授权模型；没有明确配置时不会填入猜测的模型。
- **OpenCode**：选择 `OpenCode.exe` 后，若相邻 `resources/app.asar` 表明它是桌面程序，会在固定的资源目录及 PATH 对应安装目录中查找真正的 CLI，包括 npm 安装的 `node_modules/opencode-ai/bin/opencode.exe`。随后仅执行固定的 `models --pure` 命令，显示 CLI 返回的服务商/模型 ID。
- **Qoder**：选择 `Qoder Launcher.exe` / `Qoder.exe` 后，查找 PATH、用户目录下的固定 `qodercli` 安装位置，必要时使用项目内的官方 npm CLI。仅执行固定的 `--list-models` 命令。Qoder 桌面端登录不等于独立 CLI 已登录；CLI 未登录时需由用户完成下面的登录流程。
- **自定义 CLI**：读取用户选定 JSON 清单中的 `models`，不运行未知程序来探测模型。

`src/cli-locations.mjs` 只检查固定路径和文件信息，不执行程序、不递归扫描用户目录。`src/cli-models.mjs` 仅对支持的 OpenCode / Qoder CLI 执行上述固定列模型命令，不经 shell，不启动桌面 exe，不调用推理；查询限制为 30 秒、输出缓冲 2 MiB，并支持取消。Codex、Claude 和 JSON 清单的模型发现保持本地文件读取。选择文件阶段不会持久化 Agent 配置。

列表中的候选模型不等于已通过真实任务的权限验证：缓存、配置和列模型命令都有各自的覆盖范围。文件名用于识别 Codex / Claude / OpenCode / Qoder 适配协议，平台不校验发布者签名，请选择可信的官方程序。

需要 Qoder 时，可将官方 `@qoder-ai/qodercli@1.1.77` 安装到项目的 `data/runtime/qoder`，在项目目录运行：

```powershell
npm run setup:qoder
```

安装固定版本到项目目录，不修改全局 CLI。Qoder 需要用户单独登录；请在自己的 PowerShell 中运行：

```powershell
npm run login:qoder
```

也可双击 `scripts/login-qoder.cmd`，在独立窗口中完成官方登录。完成后返回工作台重新选择 Qoder 程序，加载当前账号的模型列表。工作台不会在网页中索取账号密码或登录令牌。

执行已确认的协作任务时，CLI 通过标准输入接收提示，不经 shell 拼接命令。Codex 使用只读模式并关闭相关工具，Claude 使用受限工具配置；OpenCode / Qoder 使用关闭工具的固定配置，分别通过 `opencode-jsonl` / `qoder-json` 适配器提取结果。每次调用限制时间与输出。默认配置针对本次核对的 CLI 接口，版本差异或企业网关配置可能需要调整。

自定义 CLI 可以先保存以下形式的 JSON 文件，再通过 Windows 系统文件窗口选择它。示例中的路径与模型名称需要替换为你实际适配器提供的值：

```json
{
  "name": "我的本机适配器",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["D:\\agents\\adapter.mjs", "--model", "{model}"],
  "outputFormat": "json",
  "models": [
    { "id": "adapter-model-a", "name": "适配器模型 A" },
    { "id": "adapter-model-b", "name": "适配器模型 B" }
  ],
  "envAllowList": ["MY_LOCAL_MODEL_API_KEY"],
  "timeoutMs": 120000
}
```

清单中的 `command` 和 `args` 是你在本地文件中定义的固定配置。网页不能直接提交自由命令或参数；添加时，服务器只保存先前识别且未被修改的配置到 `config/cli-profiles.json`，保留已有条目。也可参考 `config/cli-profiles.example.json` 直接维护这份受信任配置；自定义条目需声明 `models` 才能供页面下拉选择。

Windows 下 `.cmd`、`.bat` 和 PowerShell 包装脚本不作为 Agent 执行入口；通过 npm 安装的 JS CLI 可在清单中指定 `node.exe` 加脚本绝对路径。`scripts/login-qoder.cmd` 是用户手动打开的独立登录辅助程序，不是任务执行入口。`envAllowList` 只填环境变量名称，不放密钥值。

自定义程序从 stdin 读取完整提示，按 `outputFormat` 输出 JSON。通用 JSON 格式返回规划的 `tasks`、执行/汇总的 `content`、审查的 `passed/feedback/criteria`。参数 `{model}` 被替换为选定模型。程序自身的权限、文件和网络范围仍需要你配置，平台调用限制不等同于操作系统沙盒。

## 分工与纠错规则

- 能力等级为手动估计：1 轻量、2 均衡、3 强力。平台优先建议满足等级和技能的较轻量模型；不根据模型名字猜测能力或价格。
- 技能标签必须匹配，`*` 表示全技能。复杂度 3 或高风险任务由满足条件的主导负责。没有合格候选则停止规划并给出原因。
- 用户逐项确认执行模型；所有计划最多 8 个任务，依赖必须无环。通过验收的结果才供后续任务使用。
- 执行者首次失败后修复一次，再由合格的主导接管一次；原本由主导执行的任务最多尝试两次。每次产物都要通过主导逐项审查。
- 逐条验收必须完整、有依据且全部通过。模型自称成功、格式正确、模型审查通过，均不能代替独立测试。
- 调用次数预算包括规划、执行、审查、纠错、接管与汇总，默认 40 次；并发数默认 2。次数不是金额上限，也无法衡量 CLI 内部推理的 token 花费。
- 任一任务未通过则停止依赖分支，运行标记需要处理。取消会终止活动请求；重启时进行中的运行标记中断，已有产物保留，不自动重放外部调用。

API Agent 每次只有一个配置模型。要给同一服务配置多个模型，添加多个 Agent 条目即可。当前用户确认的是执行者选择及预告的“主导审查/接管”规则；不会偷偷改用未配置的第三方模型。

## 文件与后续开发

- `src/engine.mjs`：任务依赖、路由、人工确认、审查和有限纠错。
- `src/providers.mjs`：API、CLI、演示适配。
- `src/cli-catalog.mjs`：识别适配协议，读取 Codex / Claude 本地模型信息或调用受支持 CLI 列模型，确认添加后原子注册固定配置。
- `src/cli-locations.mjs`：只读检查固定安装位置，将 OpenCode / Qoder 桌面入口定位到真正的 CLI。
- `src/cli-models.mjs`：受限的 OpenCode / Qoder 列模型查询与解析，不执行推理。
- `src/opencode-runtime.mjs`：单次 OpenCode 调用的临时配置，只保留服务商连接设置并关闭工具、MCP 和外部插件；调用结束后清理临时目录。
- `src/native-picker.mjs`：Windows 文件选择器的编译与进程桥接、超时和取消处理。
- `scripts/NativePicker.cs`：带可见所属窗口及消息循环的 WinForms 系统文件选择器。
- `scripts/login-qoder.cmd`：用户手动打开的 Qoder 独立登录窗口；也可使用 `npm run login:qoder`。
- `bin/NativePicker.exe`：本机编译生成的选择器程序，源码更新后自动重编。
- `src/server.mjs`：本机 HTTP 接口、系统文件窗口请求与选择凭据、访问来源校验。
- `public/`：中文界面。
- `config/cli-profiles.json`：用户确认添加的 CLI 配置及已有受信任配置；模型清单可以单独保存在本机 JSON 文件中。
- `tests/cli-catalog.test.mjs`：模型来源、发现流程、注册完整性及配置边界测试。
- `tests/cli-locations.test.mjs`：固定安装路径、桌面与 CLI 区分、npm 入口和只读定位测试。
- `data/runtime/qoder`：项目内安装的官方 Qoder CLI，可使用 `npm run setup:qoder` 重装。
- `tests/native-picker.test.mjs`：通过注入模拟进程测试编译、取消、超时及结果解析，不弹出真实窗口。
- `data/state.json`：本机持久化记录，已加入 Git 忽略。包含任务及模型输出，请按项目资料管理。
- `docs/ARCHITECTURE.md`：完整设计及后续隔离工作区、工具执行、测试验收方案。

下一步应先实现独立工作区和受控测试执行器，再开放自动写文件、并行开发与主导合并。要实现“较弱模型做错后可纠正”，真实测试证据、可回退的改动和清晰失败状态比增加模型数量更关键。

## 设计参考

本次检查了 `pi-agent` 技能的多 Agent 与隔离接入资料；当前实现使用独立适配器，没有引入 Pi SDK。API/CLI 接口结合官方文档核对：

- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：主导/执行者与评估/修复的编排模式。
- [OpenAI：结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)：JSON 输出格式与模型支持边界。
- [OpenAI：Codex 非交互运行](https://developers.openai.com/codex/noninteractive)：CLI 集成。
- [Claude Code：CLI reference](https://code.claude.com/docs/en/cli-reference)：打印模式及 CLI 参数。
- [Claude Code：Model configuration](https://code.claude.com/docs/en/model-config)：本地模型设置及模型环境变量。
