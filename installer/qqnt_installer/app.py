"""此模块拥有图形界面、用户选择和管理员工作进程，不自动启动 QQ。"""

import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from . import VERSION
from .engine import inspect, install, resolve_plugins, restore_original, rollback_last, safe_mode, verify_payload
from .layout import discover, json_bytes, read_json
from .transaction import atomic_write, operation_lock


def payload_root():
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "payload"


def default_profile(qq_root=None):
    if qq_root:
        try:
            settings = discover(qq_root).state / "settings.json"
            remembered = json.loads(settings.read_text("utf8"))["profile"]
            if Path(remembered).is_absolute(): return remembered
        except (OSError, ValueError, KeyError):
            pass
    import winreg
    for key, name in [(r"Environment", "LITELOADERQQNT_PROFILE"), (r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders", "Personal")]:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                value = os.path.expandvars(winreg.QueryValueEx(handle, name)[0])
                return value if name == "LITELOADERQQNT_PROFILE" else str(Path(value) / "LiteloaderQQNT")
        except OSError:
            pass
    return str(Path.home() / "Documents/LiteloaderQQNT")


def find_qq():
    for base in [os.environ.get("ProgramFiles", "C:/Program Files"), os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")]:
        candidate = Path(base) / "Tencent/QQNT"
        if (candidate / "QQ.exe").is_file():
            return str(candidate)
    return ""


def is_admin():
    return bool(ctypes.windll.shell32.IsUserAnAdmin())


def entry_command():
    return [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve().parents[1] / "install_windows.py")]


class ElevatedWorker:
    def __init__(self, args):
        from ctypes import wintypes
        class ShellInfo(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
                        ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                        ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                        ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
                        ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE)]
        info = ShellInfo()
        info.cbSize = ctypes.sizeof(info)
        info.fMask = 0x40
        info.lpVerb = "runas"
        info.lpFile = args[0]
        info.lpParameters = subprocess.list2cmdline(args[1:])
        info.nShow = 0
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        shell.ShellExecuteExW.argtypes = [ctypes.POINTER(ShellInfo)]
        if not shell.ShellExecuteExW(ctypes.byref(info)):
            raise RuntimeError("管理员权限请求已取消，未执行操作")
        self.handle = info.hProcess

    def poll(self):
        from ctypes import wintypes
        if not self.handle: return 0
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        code = wintypes.DWORD()
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        if not kernel.GetExitCodeProcess(self.handle, ctypes.byref(code)): raise ctypes.WinError(ctypes.get_last_error())
        if code.value == 259: return None
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(self.handle)
        self.handle = None
        return code.value


class InstallerWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(f"QQNT 安装与恢复工具 {VERSION}")
        self.root.geometry("880x660")
        self.root.minsize(760, 640)
        self.busy = False
        self.qq_root = tk.StringVar(value=find_qq())
        self.profile = tk.StringVar(value=default_profile(self.qq_root.get()))
        self.bundle = read_json(payload_root() / "bundle.json")
        self.plugin_checks = {}
        frame = ttk.Frame(self.root, padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="QQNT 安装与恢复", font=("Microsoft YaHei UI", 22, "bold")).pack(anchor="w")
        ttk.Label(frame, text="适配当前 QQ 活动版本 · 安装前备份 · 失败回滚 · 保留插件数据").pack(anchor="w", pady=(5, 18))
        for label, variable in [("QQ 安装目录", self.qq_root), ("插件与数据目录", self.profile)]:
            row = ttk.Frame(frame)
            row.pack(fill="x", pady=5)
            ttk.Label(row, text=label, width=16).pack(side="left")
            ttk.Entry(row, textvariable=variable).pack(side="left", fill="x", expand=True)
            ttk.Button(row, text="选择…", command=lambda value=variable: self.choose(value)).pack(side="right", padx=(8, 0))
        checks = ttk.LabelFrame(frame, text="安装 / 更新插件", padding=(10, 6))
        checks.pack(fill="x", pady=12)
        for plugin in self.bundle["plugins"]:
            if plugin["default"] is None:
                continue
            index = len(self.plugin_checks)
            choice = tk.BooleanVar(value=plugin["default"])
            self.plugin_checks[plugin["slug"]] = choice
            ttk.Checkbutton(checks, text=f"{plugin['name']}  {plugin['version']}", variable=choice).grid(
                row=index // 2, column=index % 2, sticky="w", padx=(0, 20), pady=1
            )
        ttk.Label(checks, text="群清理助手和定点表情回应会自动安装 IPC 前置。未勾选的已有插件继续保留。"
                  ).grid(row=2, column=0, columnspan=2, sticky="w", pady=(5, 0))
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(0, 10))
        self.action_buttons = []
        for text, action in [("检测状态", "inspect"), ("安装 / 修复", "install"), ("恢复原版 QQ", "restore"), ("安全模式", "safe"), ("撤销上次操作", "rollback")]:
            button = ttk.Button(buttons, text=text, command=lambda value=action: self.perform(value))
            button.pack(side="left", padx=(0, 7))
            self.action_buttons.append(button)
        ttk.Label(frame, text="恢复原版：还原 QQ 原始入口和二进制，保留插件与数据。安全模式：暂时停用所有插件。", wraplength=800).pack(anchor="w", pady=7)
        self.status = tk.Text(frame, height=14, wrap="word", font=("Microsoft YaHei UI", 10))
        self.status.pack(fill="both", expand=True)
        ttk.Button(frame, text="打开备份目录", command=self.open_backups).pack(anchor="e", pady=(10, 0))
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(150, lambda: self.perform("inspect"))

    def choose(self, value):
        selected = filedialog.askdirectory(parent=self.root, initialdir=value.get() or None)
        if selected:
            value.set(selected)

    def log(self, text):
        self.status.insert("end", text + "\n")
        self.status.see("end")

    def perform(self, action):
        if self.busy:
            return
        try:
            details = inspect(self.qq_root.get())
            if action == "inspect":
                bundle = verify_payload(payload_root())
                available = [f"{plugin['name']} {plugin['version']}" for plugin in bundle["plugins"]]
                self.status.delete("1.0", "end")
                self.log(f"QQ {details['version']} · {details['architecture']}\n安装目录：{details['root']}\n补丁状态：{details['patch']}\n恢复能力：{details['recovery']}\n备份目录：{details['backups']}\n\n内置 LiteLoader 1.4.1 及{'、'.join(available)}。\n操作前请完全退出 QQ。")
                return
            from .engine import assert_qq_closed
            assert_qq_closed()
            descriptions = {"install": "安装或修复插件框架与勾选组件", "restore": "恢复原版 QQ 入口及二进制，保留插件数据", "safe": "停用所有第三方插件以便恢复启动", "rollback": "撤销最近一次安装、恢复或安全模式操作"}
            selected = [slug for slug, choice in self.plugin_checks.items() if choice.get()]
            plugin_summary = ""
            if action == "install":
                plugins = resolve_plugins(self.bundle, selected, details["architecture"])
                names = "、".join(plugin["name"] for plugin in plugins) or "仅安装框架"
                plugin_summary = f"\n插件：{names}"
            if not messagebox.askyesno("确认操作", f"{descriptions[action]}\n\nQQ：{details['version']}\n目录：{details['root']}{plugin_summary}\n\n修改前会自动保存备份，是否继续？", parent=self.root, default="no"):
                return
            result = Path(tempfile.gettempdir()) / f"qqnt-installer-result-{uuid.uuid4().hex}.json"
            args = entry_command() + ["--apply", action, "--qq-root", details["root"], "--profile", self.profile.get(), "--report", str(result)]
            if action == "install":
                args.extend(["--plugins", *selected])
            if is_admin():
                self.worker = subprocess.Popen(args, creationflags=0x08000000)
            else:
                self.worker = ElevatedWorker(args)
            self.busy = True
            for button in self.action_buttons: button.state(["disabled"])
            self.log("正在处理，请等待；不要启动 QQ…")
            self.root.after(300, lambda: self.poll(result))
        except Exception as error:
            self.log(f"未执行：{error}")
            if action != "inspect": messagebox.showerror("操作未完成", str(error), parent=self.root)

    def poll(self, result):
        if not result.exists():
            if self.worker.poll() is not None:
                self.busy = False
                for button in self.action_buttons: button.state(["!disabled"])
                self.log("工作进程提前退出。请检查备份记录；如有未完成操作，可点击撤销上次操作。")
                return
            self.root.after(500, lambda: self.poll(result))
            return
        try:
            data = json.loads(result.read_text("utf8"))
            self.log(("完成：" if data["ok"] else "失败：") + data["message"])
            if not data["ok"]: messagebox.showerror("操作未完成", data["message"], parent=self.root)
        finally:
            self.worker.poll()
            self.busy = False
            for button in self.action_buttons: button.state(["!disabled"])

    def open_backups(self):
        try:
            folder = discover(self.qq_root.get()).state
            if not folder.exists(): raise ValueError("尚未创建备份，首次安装或恢复时会自动创建")
            os.startfile(str(folder))
        except Exception as error: messagebox.showinfo("备份目录", str(error), parent=self.root)

    def close(self):
        if self.busy:
            messagebox.showinfo("正在操作", "请等待当前操作完成后再关闭。", parent=self.root)
        else:
            self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description="QQNT 安装与恢复工具")
    parser.add_argument("--apply", choices=["install", "restore", "safe", "rollback"])
    parser.add_argument("--qq-root")
    parser.add_argument("--profile")
    parser.add_argument("--report")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--gui-test", action="store_true")
    parser.add_argument("--no-groups", action="store_true")
    parser.add_argument("--no-market", action="store_true")
    parser.add_argument("--plugins", nargs="*", metavar="SLUG",
                        help="明确指定安装的插件标识，自动带上前置。空列表只安装框架。")
    args = parser.parse_args()
    if not (args.apply or args.inspect or args.self_test or args.gui_test):
        InstallerWindow().root.mainloop()
        return 0
    try:
        if args.gui_test:
            window = InstallerWindow()
            window.root.withdraw()
            window.root.update_idletasks()
            labels = [button.cget("text") for button in window.action_buttons]
            if "恢复原版 QQ" not in labels or "撤销上次操作" not in labels or "安全模式" not in labels:
                raise RuntimeError("恢复入口缺失")
            choices = {slug: checkbox.get() for slug, checkbox in window.plugin_checks.items()}
            if not {"group_cleaner", "anti_recall", "target_reactor", "list-viewer"}.issubset(choices) or "ipc_interceptor" in choices:
                raise RuntimeError("插件勾选项缺失或前置配置错误")
            message = {"gui_initialized": True, "actions": labels, "choices": choices,
                       "payload_verified": verify_payload(payload_root())["version"]}
            window.root.destroy()
        elif args.self_test:
            from .selftest import run_selftest
            message = run_selftest(payload_root())
        elif args.inspect:
            message = inspect(args.qq_root or find_qq())
            bundle = verify_payload(payload_root())
            message["bundle"] = bundle["version"]
            message["plugins"] = bundle["plugins"]
            message["profile"] = args.profile or default_profile(message["root"])
        else:
            if not args.qq_root or not args.profile or not args.report:
                raise ValueError("工作进程缺少目录或结果文件参数")
            if not is_admin(): raise PermissionError("写入 QQ 目录需要 Windows 管理员权限")
            if args.plugins is not None and (args.no_groups or args.no_market):
                raise ValueError("--plugins 和旧版的 --no-groups、--no-market 需分开使用")
            with operation_lock(discover(args.qq_root)):
                if args.apply == "install":
                    message = install(args.qq_root, args.profile, payload_root(), not args.no_groups,
                                      not args.no_market, plugin_slugs=args.plugins)
                elif args.apply == "restore": message = restore_original(args.qq_root, args.profile)
                elif args.apply == "safe": message = safe_mode(args.qq_root, args.profile)
                else: message = rollback_last(args.qq_root, args.profile)
            message = f"操作已完成，备份记录：{message}。QQ 尚未启动，请自行启动验证。"
        result = {"ok": True, "version": VERSION, "message": message}
    except Exception as error:
        result = {"ok": False, "version": VERSION, "message": str(error) or type(error).__name__}
    if args.report:
        atomic_write(Path(args.report), json_bytes(result))
    elif sys.stdout:
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1
