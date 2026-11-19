"""只在独立临时目录测试，不调用真实 QQ，也不修改真实注册表。"""

import shutil
import json
import struct
import tempfile
from pathlib import Path
from .layout import ORIGINAL_MAIN, SIGNATURES, discover, digest, json_bytes, patched_bytes, patch_state, read_json, safe_path
from .engine import install, restore_original, rollback_last, safe_mode, inspect, resolve_plugins, verify_payload
from .transaction import Transaction


def run_selftest(release_payload):
    folder = Path(tempfile.mkdtemp(prefix="qqnt-installer-selftest-")).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if folder.parent != temp_root or not folder.name.startswith("qqnt-installer-selftest-"):
        raise ValueError("临时测试目录校验失败")
    checks = []
    try:
        root = folder / "QQNT"
        profile = folder / "Profile"
        app = root / "versions/9.9.37-54395/resources/app"
        app.mkdir(parents=True)
        profile.mkdir()
        binary = bytearray(b"\0" * 600)
        binary[:2] = b"MZ"
        struct.pack_into("<I", binary, 0x3C, 128)
        binary[128:132] = b"PE\0\0"
        struct.pack_into("<H", binary, 132, 0x8664)
        binary[300:318] = SIGNATURES[0x8664][0]
        raw = bytes(binary)
        (root / "QQ.exe").write_bytes(b"MZ-test-launcher")
        (root / "versions/config.json").write_bytes(json_bytes({"curVersion": "9.9.37-54395", "readyVersion": "99.0.0-99999"}))
        dll = app.parents[1] / "QQNT.dll"
        dll.write_bytes(raw)
        package = {"name": "qq-chat", "version": "9.9.37-54395", "main": ORIGINAL_MAIN}
        (app / "package.json").write_bytes(json_bytes(package))
        (app / "application.asar").write_bytes(b"asar-fixture")
        assert discover(root).version == "9.9.37-54395"
        checks.append("活动版本取自配置，忽略待更新版本")
        assert patch_state(patched_bytes(raw))[0] == "patched"
        assert patched_bytes(patched_bytes(raw)) == patched_bytes(raw)
        checks.append("唯一特征补丁与重复执行幂等")
        try:
            patched_bytes(raw + SIGNATURES[0x8664][0])
            raise AssertionError("应拒绝多个特征")
        except ValueError:
            pass
        checks.append("未知或多重特征在写入前停止")
        payload = folder / "Payload"
        (payload / "liteloader").mkdir(parents=True)
        (payload / "liteloader/package.json").write_bytes(json_bytes({"version": "1.4.1"}))
        (payload / "liteloader/index.js").write_bytes(b"// fixture")
        files = {p.relative_to(payload).as_posix(): digest(p.read_bytes()) for p in payload.rglob("*") if p.is_file()}
        (payload / "bundle.json").write_bytes(json_bytes({"files": files, "plugins": []}))
        guard = lambda: None
        install(root, profile, payload, guard=guard)
        assert read_json(app / "package.json")["main"].endswith("qqnt_helper.js")
        assert patch_state(dll.read_bytes())[0] == "patched"
        assert json.dumps(str(profile), ensure_ascii=False) in (app / "app_launcher/qqnt_helper.js").read_text("utf8")
        checks.append("安装入口、明确数据路径、二进制修补")
        (profile / "user-plugin-data.txt").write_bytes(b"keep-user-data")
        restore_original(root, profile, guard=guard)
        assert dll.read_bytes() == raw and read_json(app / "package.json") == package
        assert (profile / "user-plugin-data.txt").read_bytes() == b"keep-user-data"
        checks.append("完整还原原版文件并保留用户数据")
        rollback_last(root, profile, guard=guard)
        assert patch_state(dll.read_bytes())[0] == "patched"
        checks.append("撤销恢复操作")
        config = profile / "data/LiteLoader/config.json"
        safe_mode(root, profile, guard=guard)
        assert read_json(config)["enable_plugins"] is False
        rollback_last(root, profile, guard=guard)
        assert not config.exists()
        checks.append("安全模式可撤销，配置恢复原状")
        transaction = Transaction(discover(root), profile, "failure_test")
        transaction.write("profile", "test.txt", b"temporary")
        transaction.abort()
        assert not (profile / "test.txt").exists()
        checks.append("失败事务自动回滚")
        transaction = Transaction(discover(root), profile, "conflict_test")
        transaction.write("profile", "conflict.txt", b"installed")
        transaction.commit()
        (profile / "conflict.txt").write_bytes(b"new-user-edit")
        try:
            rollback_last(root, profile, guard=guard)
            raise AssertionError("应保护后续修改")
        except ValueError:
            pass
        assert (profile / "conflict.txt").read_bytes() == b"new-user-edit"
        checks.append("回滚保护后续用户修改")
        try:
            safe_path(root, "../outside.txt")
            raise AssertionError("应拒绝路径穿越")
        except ValueError:
            pass
        checks.append("拒绝目录越界")
        # 模拟旧安装器已修改 QQ 的情形，导入经过内容验证的原版 .bak。
        legacy = folder / "LegacyQQ"
        shutil.copytree(root, legacy, ignore=shutil.ignore_patterns(".qqnt-helper"))
        legacy_app = legacy / "versions/9.9.37-54395/resources/app"
        legacy_dll = legacy_app.parents[1] / "QQNT.dll"
        legacy_dll.with_name("QQNT.dll.bak").write_bytes(raw)
        (legacy_app / "package.json.bak").write_bytes(json_bytes(package))
        assert "完整恢复" in inspect(legacy)["recovery"]
        install(legacy, folder / "LegacyProfile", payload, guard=guard)
        restore_original(legacy, folder / "LegacyProfile", guard=guard)
        assert legacy_dll.read_bytes() == raw
        checks.append("接管旧安装器 .bak 并恢复原版")

        bundle = verify_payload(release_payload)
        def slugs(requested=None):
            return {plugin["slug"] for plugin in resolve_plugins(bundle, requested, "x64")}

        assert slugs() == {"group_cleaner", "ipc_interceptor", "list-viewer"}
        assert slugs([]) == set()
        assert slugs(["anti_recall"]) == {"anti_recall"}
        assert slugs(["target_reactor"]) == {"target_reactor", "ipc_interceptor"}
        try:
            resolve_plugins(bundle, ["anti_recall"], "ARM64")
        except ValueError as error:
            assert "ARM64" in str(error)
        else:
            raise AssertionError("应拒绝缺少原生依赖的架构")
        checks.append("各插件独立选择，自动安装前置，防撤回架构受限")

        clean_profile = folder / "ReleaseProfile"
        data_file = clean_profile / "data/target_reactor/test.txt"
        data_file.parent.mkdir(parents=True)
        data_file.write_bytes(b"existing data")
        install(legacy, clean_profile, release_payload, guard=guard,
                plugin_slugs=["group_cleaner", "anti_recall", "target_reactor"])
        installed = clean_profile / "plugins"
        assert {p.name for p in installed.iterdir()} == {"group_cleaner", "anti_recall", "target_reactor", "ipc_interceptor"}
        for slug in ["group_cleaner", "anti_recall", "target_reactor", "ipc_interceptor"]:
            assert read_json(installed / slug / "manifest.json")["slug"] == slug
        native = installed / "anti_recall/node_modules/leveldown/prebuilds/win32-x64/node.napi.node"
        assert native.is_file() and native.read_bytes().startswith(b"MZ")
        assert (installed / "anti_recall/viewer/viewer.html").is_file()
        assert data_file.read_bytes() == b"existing data"
        rollback_last(legacy, clean_profile, guard=guard)
        assert not native.exists() and not (installed / "target_reactor/manifest.json").exists()
        assert legacy_dll.read_bytes() == raw and data_file.read_bytes() == b"existing data"
        checks.append("完整发行载荷可离线安装与撤销，保留已有插件数据")
        return {"passed": True, "count": len(checks), "checks": checks, "real_qq_modified": False}
    finally:
        # 仅清理本函数创建且验证位于系统临时目录内的测试目录。
        if folder.parent == temp_root and folder.name.startswith("qqnt-installer-selftest-"):
            shutil.rmtree(folder)
