"""此模块编排安装、原版恢复、安全模式；每次写入都经事务保存原状。"""

import csv
import json
import os
import subprocess
from pathlib import Path
from .layout import HELPER_MAIN, ORIGINAL_MAIN, digest, discover, json_bytes, original_files, patched_bytes, patch_state, read_json, safe_path, ARCH_NAMES
from .transaction import Transaction, atomic_write, restore_transaction


def assert_qq_closed():
    if os.name != "nt":
        return
    output = subprocess.check_output(["tasklist.exe", "/FO", "CSV", "/NH"], creationflags=0x08000000).decode("mbcs", errors="replace")
    for row in csv.reader(output.splitlines()):
        if row and row[0].lower() in {"qq.exe", "qqex.exe"}:
            raise RuntimeError("请先从系统托盘完全退出 QQ，再执行安装、恢复或安全模式。工具不会强制结束进程。")


def verify_payload(payload):
    payload = Path(payload).resolve()
    manifest = read_json(payload / "bundle.json")
    for relative, expected in manifest["files"].items():
        target = safe_path(payload, relative)
        if not target.is_file() or digest(target.read_bytes()) != expected:
            raise ValueError(f"安装包文件校验失败：{relative}")
    for plugin in manifest["plugins"]:
        relative = f"plugins/{plugin['slug']}/manifest.json"
        if relative not in manifest["files"]:
            raise ValueError(f"安装包缺少插件清单：{relative}")
        component = read_json(safe_path(payload, relative))
        if (component["slug"], component["version"], component.get("dependencies", [])) != (
            plugin["slug"], plugin["version"], plugin["dependencies"]
        ):
            raise ValueError(f"安装包插件清单不一致：{relative}")
    return manifest


def resolve_plugins(bundle, requested=None, architecture=None):
    plugins = {plugin["slug"]: plugin for plugin in bundle["plugins"]}
    if requested is None:
        requested = [slug for slug, plugin in plugins.items() if plugin["default"] is True]
    selected = set()
    pending = list(requested)
    while pending:
        slug = pending.pop()
        if slug in selected:
            continue
        if slug not in plugins:
            raise ValueError(f"安装包没有此插件或前置：{slug}")
        plugin = plugins[slug]
        architectures = plugin.get("architectures")
        if architecture and architectures and architecture not in architectures:
            raise ValueError(f"{plugin['name']}暂不支持 {architecture} QQ，请取消勾选后重试")
        selected.add(slug)
        pending.extend(plugin["dependencies"])
    return [plugin for slug, plugin in plugins.items() if slug in selected]


def baseline(installation, create=False):
    folder = installation.state / "original"
    manifest_file = folder / "manifest.json"
    if manifest_file.exists():
        manifest = read_json(manifest_file)
        if manifest.get("version") != installation.version:
            raise ValueError("原版备份版本不匹配")
        result = {}
        for item in manifest["files"]:
            data = safe_path(folder, item["backup"]).read_bytes()
            if digest(data) != item["sha256"]:
                raise ValueError("原版备份哈希校验失败")
            result[safe_path(installation.root, item["relative"])] = data
        return result
    result = original_files(installation)
    if create:
        folder.mkdir(parents=True, exist_ok=True)
        records = []
        for index, (file, data) in enumerate(result.items()):
            backup = f"{index}.bin"
            atomic_write(folder / backup, data)
            records.append({"relative": file.relative_to(installation.root).as_posix(), "backup": backup, "sha256": digest(data)})
        atomic_write(manifest_file, json_bytes({"version": installation.version, "files": records}))
    return result


def inspect(root):
    installation = discover(root)
    state, machine = patch_state(installation.binary.read_bytes())
    try:
        baseline(installation)
        recovery = "可完整恢复原版 QQ 入口和二进制"
    except (OSError, ValueError) as error:
        recovery = str(error)
    return {"version": installation.version, "root": str(installation.root), "architecture": ARCH_NAMES[machine],
            "patch": state, "entry": read_json(installation.app / "package.json").get("main"), "recovery": recovery,
            "backups": str(installation.state)}


def run_transaction(installation, profile, action, callback):
    transaction = Transaction(installation, profile, action)
    try:
        callback(transaction)
        return str(transaction.commit())
    except BaseException as error:
        try:
            transaction.abort()
        except Exception as rollback_error:
            raise RuntimeError(f"操作失败，自动回滚未完成：{rollback_error}。备份记录：{transaction.folder}") from error
        raise


def bootstrap(loader_path, profile):
    # 写入完整路径，用户环境变量尚未广播到 Explorer 时仍可正常启动。
    return ("// QQNT Helper managed launcher\n" +
            f"process.env.LITELOADERQQNT_PROFILE = {json.dumps(str(profile), ensure_ascii=False)};\n" +
            f"require({json.dumps(str(loader_path), ensure_ascii=False)});\n").encode("utf-8")


def install(root, profile, payload, include_groups=True, include_market=True, guard=assert_qq_closed, *, plugin_slugs=None):
    installation = discover(root)
    profile = Path(profile).resolve()
    if profile == installation.root or profile.is_relative_to(installation.root):
        raise ValueError("插件数据目录必须放在 QQ 安装目录以外，避免权限和更新问题")
    guard()
    bundle = verify_payload(payload)
    binary_before = installation.binary.read_bytes()
    architecture = ARCH_NAMES[patch_state(binary_before)[1]]
    if plugin_slugs is None:
        excluded = set()
        if not include_groups:
            excluded.add("group_cleaner")
        if not include_market:
            excluded.add("list-viewer")
        plugin_slugs = [plugin["slug"] for plugin in bundle["plugins"]
                        if plugin["default"] is True and plugin["slug"] not in excluded]
    selected = {plugin["slug"] for plugin in resolve_plugins(bundle, plugin_slugs, architecture)}
    originals = baseline(installation, create=True)
    pristine = originals[installation.binary]
    if binary_before not in (pristine, patched_bytes(pristine)):
        raise ValueError("当前 QQ 二进制与原版备份不一致，未覆盖其他修改")
    binary_after = patched_bytes(binary_before)
    package_file = installation.app / "package.json"
    package = read_json(package_file)
    package["main"] = HELPER_MAIN
    loader = installation.root / "resources/app/LiteLoaderQQNT"

    def apply(transaction):
        for relative in bundle["files"]:
            source = safe_path(payload, relative)
            if relative.startswith("liteloader/"):
                destination = loader / relative[len("liteloader/"):]
                transaction.write("qq", destination.relative_to(installation.root), source.read_bytes())
            elif relative.startswith("plugins/"):
                slug = relative.split("/")[1]
                if slug in selected:
                    transaction.write("profile", relative, source.read_bytes())
        transaction.write("qq", installation.binary.relative_to(installation.root), binary_after)
        transaction.write("qq", (installation.app / "app_launcher/qqnt_helper.js").relative_to(installation.root), bootstrap(loader, profile))
        transaction.write("qq", package_file.relative_to(installation.root), json_bytes(package))
        transaction.write("qq", (installation.state / "settings.json").relative_to(installation.root), json_bytes({"profile": str(profile)}))
    return run_transaction(installation, profile, "install", apply)


def restore_original(root, profile, guard=assert_qq_closed):
    installation = discover(root)
    guard()
    originals = baseline(installation, create=True)
    current = installation.binary.read_bytes()
    if current not in (originals[installation.binary], patched_bytes(originals[installation.binary])):
        raise ValueError("当前 QQ 二进制与备份不一致，已停止恢复")
    def apply(transaction):
        for target, data in originals.items():
            transaction.write("qq", target.relative_to(installation.root), data)
        launcher = installation.app / "app_launcher/qqnt_helper.js"
        if launcher.exists():
            transaction.write("qq", launcher.relative_to(installation.root), None)
    return run_transaction(installation, profile, "restore_original", apply)


def safe_mode(root, profile, guard=assert_qq_closed):
    installation = discover(root)
    guard()
    config_path = Path(profile) / "data/LiteLoader/config.json"
    config = read_json(config_path) if config_path.exists() else {"enable_plugins": True, "disabled_plugins": [], "deleting_plugins": {}}
    config["enable_plugins"] = False
    return run_transaction(installation, profile, "safe_mode", lambda transaction: transaction.write("profile", "data/LiteLoader/config.json", json_bytes(config)))


def rollback_last(root, profile, guard=assert_qq_closed):
    installation = discover(root)
    guard()
    history = installation.state / "history"
    candidates = sorted(history.glob("*/manifest.json"), reverse=True) if history.exists() else []
    for file in candidates:
        manifest = read_json(file)
        if manifest["status"] in {"complete", "in_progress"}:
            restore_transaction(file.parent, {"qq": installation.root, "profile": Path(profile)}, allow_before=True)
            return str(file.parent)
    raise ValueError("没有可撤销的操作；旧安装器的备份请使用“恢复原版 QQ”")
