# QQNT 安装与恢复工具 2.1.0

Windows QQNT 离线安装器。直接打开 `install_windows.exe` 使用图形界面即可。首次安装步骤和可复制的 AI 安装提示词见 [安装指南](../README.md)。

## 界面入口

- **检测状态**：读取 `versions/config.json` 中的活动版本、架构、原生入口和恢复能力，只读操作。
- **安装 / 修复** 安装 LiteLoader 1.4.1 兼容修正版并修补当前 QQ。群清理助手、防撤回、定点表情回应和插件市场分别勾选。依赖的 IPC 前置自动加入。
- **恢复原版 QQ**：还原同版本原始 `package.json` 和原始 QQ 二进制，保留插件、聊天数据和历史备份。残留的框架文件不会被 QQ 加载。
- **安全模式**：只把 LiteLoader 的 `enable_plugins` 设为 false，方便排查插件导致的启动问题；不删插件。可使用“撤销上次操作”恢复。
- **撤销上次操作**：恢复最近一次安装、恢复或安全模式操作之前的文件；如果文件在此后被其他程序修改，会停止而非覆盖。
- **打开备份目录**：查看每次操作记录与原版备份。

所有修改前都必须从托盘完全退出 QQ。工具不强制结束进程，也不自动启动 QQ。点击修改操作后会显示具体版本和目录供确认，写入 Program Files 时请求 Windows 管理员权限。

## 与旧版安装器的差异

版本选择以 `versions/config.json` 的 `curVersion` 为准，不按文件大小或字符串排序猜测。当前版本已存在的 `.bak` 仅在内容验证通过时用于接管原版备份；不删除、不覆盖旧安装器的备份，不修改 Everyone 权限。

二进制补丁要求原始或已修改特征唯一，重复安装不重复修补，无法识别时停止。原版备份有 SHA256 校验；每次写入前保存快照、写日志，失败自动回滚。原版备份保存在 `<QQ安装目录>/.qqnt-helper/<版本>/original`，逐次操作保存在 `history`。

启动入口固定使用界面选择的数据目录，不依赖旧进程是否收到环境变量广播。已有插件数据与禁用设置保留；选中的内置插件只更新程序文件。安全模式停用插件后需撤销该次操作或在 LiteLoader 设置中重新启用。

## 内置组件

- LiteLoaderQQNT 1.4.1：修复 Node 新版本的 `dirent.path` 兼容问题，以及首次写入默认配置时错误的方法名。
- 插件市场 1.5.1。
- IPC 事件拦截器 1.2.0。
- 群清理助手 0.1.4：QQ 9.9.37-54395 默认可退群，只有接口失效才提示手动校准；已有成功的手动校准优先使用。
- 防撤回·本地修订版 0.3.2-local.2，含图片保护、独立撤回记录查看器和 Windows x64/x86 的离线 LevelDB 依赖。
- 定点表情回应 0.1.0，支持按群和成员设置表情。首次启用前由用户配置规则，实际群内效果仍待验证。

默认退群参数来自本机已成功的原生操作，不包含个人群号或账号凭证。未来 QQ 版本的内部接口变化无法预先保证；不匹配时校准，而非自动重复发送退群请求。

## 命令行安装

GUI 适合日常安装。需要让 AI 或脚本执行时，可以用 PowerShell。将示例目录换成实际路径。检测和自检是只读或隔离操作，正式写入请在 QQ 完全退出后从管理员 PowerShell 执行。

```powershell
$exe = (Resolve-Path '.\install_windows.exe').Path
$detection = Join-Path $PWD 'qqnt-inspect.json'
$arguments = '--inspect --qq-root "C:\Program Files\Tencent\QQNT" --report "{0}"' -f $detection
$run = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru
$detected = Get-Content -LiteralPath $detection -Raw | ConvertFrom-Json
if ($run.ExitCode -ne 0 -or -not $detected.ok) { throw $detected.message }
$detected.message
```

核对报告中的 `root`、`profile`、`architecture` 和 `recovery`，在管理员 PowerShell 使用以下命令。需要保留其他插件选择时，按需调整 `--plugins` 后面的标识。

```powershell
$exe = (Resolve-Path '.\install_windows.exe').Path
$detected = Get-Content -LiteralPath '.\qqnt-inspect.json' -Raw | ConvertFrom-Json
if (-not $detected.ok) { throw $detected.message }
$report = Join-Path $PWD ('qqnt-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$arguments = '--apply install --qq-root "{0}" --profile "{1}" --report "{2}" --plugins group_cleaner anti_recall target_reactor list-viewer' -f $detected.message.root, $detected.message.profile, $report
$run = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru
$installed = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if ($run.ExitCode -ne 0 -or -not $installed.ok) { throw $installed.message }
$installed.message
```

`--plugins` 的空列表表示仅安装框架。省略该参数时按图形界面的默认项安装。需要检查发行包可运行 `install_windows.exe --self-test --report 检查结果.json`，程序会在临时目录测试完整离线安装、还原、撤销和安全模式。

## 构建与源代码

Python 3.12 + PyInstaller 6，代码拆分为 `layout.py`（布局/补丁识别）、`transaction.py`（事务备份）、`engine.py`（安装/恢复）、`app.py`（GUI/提权）、`selftest.py`（隔离测试）。

在项目根目录运行 `python installer/build.py` 组装插件与校验清单，再运行 `python -m PyInstaller --noconfirm --distpath artifacts/installer-2.1.0 installer/install_windows.spec`。防撤回的固定版本依赖位于 `installer/payload/plugins/anti_recall/node_modules/`，来自上游 0.3.0 发行包。构建时按校验清单打包离线组件。

补丁特征与旧安装方式参考 Mzdyl/LiteLoaderQQNT_Install，保留其 BSD-3-Clause 许可于 `LICENSE.upstream`。其余组件保留各自许可证。原项目：<https://github.com/Mzdyl/LiteLoaderQQNT_Install>。
