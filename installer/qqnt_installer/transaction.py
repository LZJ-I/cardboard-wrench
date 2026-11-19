"""此模块拥有不可覆盖的逐次备份、修改日志和按哈希校验的回滚。"""

import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from .layout import digest, json_bytes, read_json, safe_path


@contextmanager
def operation_lock(installation):
    import msvcrt
    installation.state.mkdir(parents=True, exist_ok=True)
    file = installation.state / ".operation.lock"
    with file.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError("另一个安装或恢复操作尚未结束，请稍后重试") from error
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def atomic_write(file, data):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()


class Transaction:
    def __init__(self, installation, profile, action):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:10]
        self.folder = installation.state / "history" / stamp
        self.folder.mkdir(parents=True, exist_ok=False)
        self.roots = {"qq": installation.root.resolve(), "profile": Path(profile).resolve()}
        self.manifest = {"schema": 1, "action": action, "version": installation.version, "status": "in_progress", "roots": {k: str(v) for k, v in self.roots.items()}, "files": []}
        self.save()

    def save(self):
        atomic_write(self.folder / "manifest.json", json_bytes(self.manifest))

    def write(self, root_name, relative, data):
        target = safe_path(self.roots[root_name], relative)
        before = target.read_bytes() if target.exists() else None
        if before == data:
            return
        backup = f"files/{len(self.manifest['files']):05d}.bin"
        if before is not None:
            atomic_write(safe_path(self.folder, backup), before)
        entry = {"root": root_name, "relative": Path(relative).as_posix(), "backup": backup,
                 "before": digest(before) if before is not None else None, "after": digest(data) if data is not None else None}
        self.manifest["files"].append(entry)
        self.save()
        if data is None:
            if target.exists():
                target.unlink()
        else:
            atomic_write(target, data)

    def commit(self):
        self.manifest["status"] = "complete"
        self.save()
        return self.folder

    def abort(self):
        restore_transaction(self.folder, self.roots, allow_before=True)
        self.manifest["status"] = "failed_rolled_back"
        self.save()


def restore_transaction(folder, expected_roots, allow_before=False):
    folder = Path(folder).resolve()
    manifest = read_json(folder / "manifest.json")
    roots = {key: Path(value).resolve() for key, value in manifest.get("roots", {}).items()}
    if roots != {key: Path(value).resolve() for key, value in expected_roots.items()}:
        raise ValueError("备份记录的安装目录不匹配，已停止恢复")
    # 先校验所有文件再恢复，避免遇到冲突后留下部分还原状态。
    targets = []
    for entry in reversed(manifest["files"]):
        target = safe_path(roots[entry["root"]], entry["relative"])
        current = digest(target.read_bytes()) if target.exists() else None
        if current != entry["after"] and not (allow_before and current == entry["before"]):
            raise ValueError(f"文件已被其他程序修改，未覆盖：{target}")
        before = None
        if entry["before"] is not None:
            before = safe_path(folder, entry["backup"]).read_bytes()
            if digest(before) != entry["before"]:
                raise ValueError("备份文件校验失败")
        targets.append((target, before))
    for target, before in targets:
        if before is None:
            if target.exists():
                target.unlink()
        else:
            atomic_write(target, before)
    manifest["status"] = "rolled_back"
    atomic_write(folder / "manifest.json", json_bytes(manifest))
