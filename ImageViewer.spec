# -*- mode: python ; coding: utf-8 -*-
"""
ScrollGallery 打包配置（PyInstaller onedir 模式）。

用法：
    .venv/Scripts/pyinstaller.exe --noconfirm ImageViewer.spec

产物：
    dist/ScrollGallery/ScrollGallery.exe （+ 同目录 _internal/ 依赖）

说明：
    前端资源只打包 index.html 实际引用的文件，
    排除 mock 阶段遗留的 js/mock.js、images/、thumbs/（假数据，已由后端 HTTP 取代）。
    frontend/idle.png 是空态提示图（非 mock，因 images/ 未被 git 跟踪而放 frontend 根），需单独列入 datas。
"""

# 前端静态资源：(源路径, 打包后所在目录)
datas = [
    ('frontend/index.html', 'frontend'),
    ('frontend/css/style.css', 'frontend/css'),
    ('frontend/js/api.js', 'frontend/js'),
    ('frontend/js/main.js', 'frontend/js'),
    ('frontend/js/sidebar.js', 'frontend/js'),
    ('frontend/idle.png', 'frontend'),   # 空态提示图（未选图时显示在“单击图片开始浏览”上方；因 images/ 未被 git 跟踪，改放 frontend 根）
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PIL.AvifImagePlugin'],
    noarchive=False,
    optimize=0,
)

# 裁掉 AVIF 解码器：项目仅支持 jpg/jpeg/png/webp/gif（不含 AVIF），
# 但 PyInstaller 的 Pillow 钩子会把 _avif.*.pyd 当二进制依赖收进来（约 7.5MB），此处显式剔除以减小体积。
a.binaries = [b for b in a.binaries if 'avif' not in b[0].lower()]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ScrollGallery',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    console=False,                 # GUI 应用：不弹黑色控制台窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='favicon.ico',           # 项目根目录的应用图标
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='ScrollGallery',
)
