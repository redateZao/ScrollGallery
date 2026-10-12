"""
应用数据路径解析。
把磁盘缓存与 WebView2 持久化数据统一放在「程序所在目录」下的 .cache，
使"删除程序文件夹即无任何残留"成为默认行为；程序目录不可写时（如装进 Program Files）
自动回退到 %LOCALAPPDATA%\\ImageViewer，保证仍能运行。
"""

import os
import sys


def _program_dir() -> str:
    """
    程序所在目录：
    - PyInstaller 打包后：取 exe 所在目录（绝不能用 sys._MEIPASS —— 那是一次性临时目录，退出即删，
      且每次启动路径都变，放那儿缓存等于每次作废）。
    - 源码运行：本文件位于 backend/ 下，项目根是其上一级（main.py 所在目录）。
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _is_writable_dir(path: str) -> bool:
    """确保目录存在并实测可写（建一个探测文件再删）；任何失败都返回 False。"""
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, '.writeprobe')
        with open(probe, 'wb') as f:
            f.write(b'')
        os.remove(probe)
        return True
    except OSError:
        return False


def get_data_root() -> str:
    """
    可写的应用数据根目录（确保已存在）：
    优先 <程序目录>\\.cache（绿色可携带、删文件夹即净）；不可写时回退 %LOCALAPPDATA%\\ImageViewer。
    """
    primary = os.path.join(_program_dir(), '.cache')
    if _is_writable_dir(primary):
        return primary
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    fallback = os.path.join(base, 'ScrollGallery')
    os.makedirs(fallback, exist_ok=True)
    return fallback
