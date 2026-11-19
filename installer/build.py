"""组装离线载荷与校验清单；从项目根目录执行。"""

import hashlib
import json
import shutil
from pathlib import Path
from qqnt_installer import VERSION

root = Path(__file__).resolve().parents[1]
payload = root / "installer/payload"
sources = [
    ("group_cleaner", "group-cleaner", "群清理助手", True),
    ("anti_recall", "anti-recall-repair", "防撤回·本地修订版", False),
    ("target_reactor", "target-reactor", "定点表情回应", False),
    ("list-viewer", "downloads/list-viewer-v1.5.1", "插件市场", True),
    ("ipc_interceptor", "downloads/ipc-interceptor-v1.2.0", "IPC 事件拦截器", None),
]
plugins = []
for slug, source, label, default in sources:
    destination = payload / "plugins" / slug
    source = root / source
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".git", "__pycache__"))
    elif not destination.is_dir():
        raise FileNotFoundError(f"缺少组件源码：{source}")
    component = json.loads((destination / "manifest.json").read_text("utf-8-sig"))
    if component["slug"] != slug:
        raise ValueError(f"插件标识与目录不一致：{destination}")
    plugins.append({"slug": slug, "name": label, "version": component["version"],
                    "default": default, "dependencies": component.get("dependencies", [])})

# 防撤回的 LevelDB 依赖随离线包提供，并从已留档的上游发行包取用。
recall_dependencies = payload / "plugins/anti_recall/node_modules"
upstream_dependencies = root / "downloads/anti-recall-v0.3.0/node_modules"
if upstream_dependencies.is_dir():
    def ignore_dependencies(directory, names):
        if Path(directory).name == "prebuilds":
            return set(names) - {"win32-x64", "win32-ia32"}
        return set(names) & {".bin"}

    shutil.copytree(upstream_dependencies, recall_dependencies, dirs_exist_ok=True, ignore=ignore_dependencies)

recall_architectures = []
for prebuild, architecture in [("win32-x64", "x64"), ("win32-ia32", "x86")]:
    if (recall_dependencies / f"leveldown/prebuilds/{prebuild}/node.napi.node").is_file():
        recall_architectures.append(architecture)
if not recall_architectures or not (recall_dependencies / "level-party/package.json").is_file():
    raise FileNotFoundError("缺少防撤回的离线依赖或 Windows 原生模块")
next(plugin for plugin in plugins if plugin["slug"] == "anti_recall")["architectures"] = recall_architectures
store = payload / "liteloader/src/main/store.js"
text = store.read_text("utf8")
old = 'path.join(dirent.path, dirent.name, "manifest.json")'
text = text.replace(old, 'path.join(LiteLoader.path.plugins, dirent.name, "manifest.json")')
text = text.replace('exports.setConfig(slug, config);', 'exports.setPluginConfig(slug, config);')
assert "dirent.path" not in text
store.write_text(text, "utf8", newline="\n")
licenses = payload / "licenses"
licenses.mkdir(exist_ok=True)
shutil.copyfile(root / "installer/LICENSE.upstream", licenses / "LiteLoaderQQNT_Install.txt")
files = {file.relative_to(payload).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
         for file in sorted(payload.rglob("*"))
         if file.is_file() and file.name != "bundle.json" and ".bak-" not in file.name}
manifest = {"version": VERSION, "target_qq": "9.9.37-54395", "plugins": plugins, "files": files}
(payload / "bundle.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf8")
print(f"Offline payload ready: {len(files)} files")
