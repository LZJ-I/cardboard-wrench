# -*- mode: python ; coding: utf-8 -*-

import json
from pathlib import Path

installer_dir = Path(SPECPATH)
payload_dir = installer_dir / "payload"
bundle = payload_dir / "bundle.json"
files = json.loads(bundle.read_text("utf-8"))["files"]
datas = [(str(payload_dir / file), str(Path("payload") / Path(file).parent)) for file in files]
datas.append((str(bundle), "payload"))

a = Analysis(
    [str(installer_dir / 'install_windows.py')],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='install_windows',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
