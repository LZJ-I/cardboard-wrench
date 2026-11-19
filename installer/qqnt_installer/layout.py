"""此模块只识别 QQ 安装布局与补丁状态，不修改文件。"""

import hashlib
import json
import re
import struct
from dataclasses import dataclass
from pathlib import Path

ORIGINAL_MAIN = "./application.asar/app_launcher/index.js"
HELPER_MAIN = "./app_launcher/qqnt_helper.js"
# 特征来源：Mzdyl/LiteLoaderQQNT_Install，BSD-3-Clause，保留许可证于发行包。
SIGNATURES = {
    0x8664: (bytes.fromhex("4889ce488b114c8b41084929d0488b4918e8"), bytes.fromhex("4889ce488b114c8b41084929d0488b4918b801000000")),
    0x14C: (bytes.fromhex("89ce8b018b490429c15150ff760ce8"), bytes.fromhex("89ce8b018b490429c15150ff760cb801000000")),
    0xAA64: (bytes.fromhex("98010035b2edff97"), bytes.fromhex("98010035200080d2")),
}
ARCH_NAMES = {0x8664: "x64", 0x14C: "x86", 0xAA64: "ARM64"}


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pe_machine(data):
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("不是有效的 Windows PE 文件")
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if offset + 6 > len(data) or data[offset:offset + 4] != b"PE\0\0":
        raise ValueError("PE 文件头无效")
    machine = struct.unpack_from("<H", data, offset + 4)[0]
    if machine not in SIGNATURES:
        raise ValueError(f"暂不支持的 PE 架构：{machine:#x}")
    return machine


def patch_state(data):
    machine = pe_machine(data)
    original, patched = SIGNATURES[machine]
    counts = data.count(original), data.count(patched)
    if counts == (1, 0):
        return "original", machine
    if counts == (0, 1):
        return "patched", machine
    raise ValueError(f"无法唯一识别此版本的补丁位置（原始/已修补特征数：{counts}），未修改文件")


def patched_bytes(data):
    state, machine = patch_state(data)
    if state == "patched":
        return data
    original, replacement = SIGNATURES[machine]
    offset = data.index(original)
    if offset + len(replacement) > len(data):
        raise ValueError("补丁位置超过文件边界")
    result = data[:offset] + replacement + data[offset + len(replacement):]
    if len(result) != len(data) or patch_state(result)[0] != "patched":
        raise ValueError("补丁自检失败")
    return result


def safe_path(root, relative):
    root = Path(root).resolve()
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError("不允许访问目标目录以外的路径")
    candidate = root / relative
    cursor = candidate
    while cursor != root:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError(f"拒绝通过符号链接或目录联接修改文件：{cursor}")
        cursor = cursor.parent
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("目标路径超出安装目录")
    return candidate


@dataclass(frozen=True)
class Installation:
    root: Path
    version: str
    base: Path
    app: Path
    binary: Path

    @property
    def state(self):
        return safe_path(self.root, f".qqnt-helper/{self.version}")


def discover(root, version=None):
    root = Path(root).resolve()
    if not (root / "QQ.exe").is_file():
        raise ValueError("所选目录没有 QQ.exe")
    versions = root / "versions"
    if versions.is_dir():
        current = read_json(versions / "config.json").get("curVersion") if not version else version
        if not isinstance(current, str) or not re.fullmatch(r"\d+\.\d+\.\d+-\d+", current):
            raise ValueError("无法确定 QQ 活动版本，请检查 versions/config.json")
        base = safe_path(root, f"versions/{current}")
        binary = base / "QQNT.dll"
    else:
        base = root
        current = read_json(root / "resources/app/package.json").get("version", "")
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-\d+)?", current):
            raise ValueError("无法识别 QQ 版本")
        binary = root / "QQ.exe"
    app = base / "resources/app"
    package = read_json(app / "package.json")
    if package.get("name") != "qq-chat" or package.get("version") != current:
        raise ValueError("QQ 版本目录与 package.json 不匹配")
    if not binary.is_file() or not (app / "application.asar").is_file():
        raise ValueError("QQ 安装文件不完整，请先修复 QQ 本体")
    safe_path(root, binary.relative_to(root))
    return Installation(root, current, base, app, binary)


def original_files(installation):
    package_path = installation.app / "package.json"
    package = read_json(package_path)
    if package.get("main") == ORIGINAL_MAIN:
        original_package = package_path.read_bytes()
    else:
        backup = package_path.with_name("package.json.bak")
        candidate = read_json(backup) if backup.exists() else {}
        if candidate.get("main") != ORIGINAL_MAIN or candidate.get("version") != installation.version or candidate.get("name") != "qq-chat":
            raise ValueError("找不到可信的原版 package.json 备份，无法保证完整恢复，请先用 QQ 官方安装包修复")
        original_package = backup.read_bytes()
    binary = installation.binary.read_bytes()
    state, _ = patch_state(binary)
    if state == "original":
        original_binary = binary
    else:
        backup = installation.binary.with_name(installation.binary.name + ".bak")
        if not backup.exists():
            raise ValueError("QQ 已修补但没有原版二进制备份，未覆盖现有文件")
        original_binary = backup.read_bytes()
        if patch_state(original_binary)[0] != "original" or patched_bytes(original_binary) != binary:
            raise ValueError("旧二进制备份与当前 QQ 不匹配，未覆盖备份")
    return {package_path: original_package, installation.binary: original_binary}
