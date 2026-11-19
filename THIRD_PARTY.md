# 第三方组件

离线安装器把以下独立组件打包在同一个发行包里。各组件保留原许可证。

| 组件 | 版本与许可证 | 对应源码 |
|---|---|---|
| LiteLoader 安装方式参考 | BSD-3-Clause | [LiteLoaderQQNT_Install](https://github.com/Mzdyl/LiteLoaderQQNT_Install) |
| LiteLoaderQQNT | 1.4.1 兼容修正版，MIT | [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT/tree/1.4.1)，修订版在本仓库 `installer/payload/liteloader/` |
| 防撤回 | 基于 0.3.0 的本地修订版，MIT | [LiteLoaderQQNT-Anti-Recall 0.3.0](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall/releases/tag/0.3.0)，修订版在本仓库 `anti-recall-repair/` |
| 插件列表查看 | 1.5.1，GPL-3.0 | [对应版本](https://github.com/ltxhhz/LL-plugin-list-viewer/tree/v1.5.1)，发行包内 `sources/list-viewer-v1.5.1-source.zip` |
| IPC 事件拦截器 | 1.2.0，GPL-3.0 | [对应版本](https://github.com/qwqnt-community/qwqnt-ipc-interceptor/tree/v1.2.0)，发行包内 `sources/ipc-interceptor-v1.2.0-source.zip` |

防撤回附带的 LevelDB 和 Node.js 依赖保留在 `installer/payload/plugins/anti_recall/node_modules/`，其许可证与版本见各依赖目录。离线 EXE 使用 Python、Tk 和 PyInstaller 构建。
