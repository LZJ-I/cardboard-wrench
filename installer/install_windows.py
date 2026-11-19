"""Windows 安装器入口；写入操作仅发生在用户选择并确认之后。"""
from qqnt_installer.app import main

if __name__ == "__main__":
    raise SystemExit(main())
