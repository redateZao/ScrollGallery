"""
目录扫描模块 —— 提供文件系统浏览与图片列表接口。
对齐前端 §2 契约（见 note/前端现状记录.md）。
"""

import ctypes
import os
import re
import string
import sys
from concurrent.futures import ThreadPoolExecutor
from functools import cmp_to_key
from urllib.parse import quote

from PIL import Image

# 支持的图片扩展名（小写，含点）
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}


def _natural_key(name: str):
    """
    自然排序键：把文件名按「非数字段 / 数字段」交替切分，
    数字段转 int 比较（使 '2' < '10'），非数字段小写比较（大小写不敏感），
    模拟 Windows 资源管理器的排序顺序，避免字典序下 '10' 排在 '2' 前。

    re.split 带捕获组返回 [非数字, 数字, 非数字, 数字, ...]，
    奇数索引必为数字段、偶数索引必为非数字段，故各字符串同位置类型一致，
    列表比较不会因 int 与 str 混排而报错。
    """
    parts = re.split(r'(\d+)', name)
    return [int(p) if i % 2 else p.lower() for i, p in enumerate(parts)]


# —— 优先用 Windows 资源管理器同款排序函数 shlwapi!StrCmpLogicalW——
# 它同时具备：数字段自然序（与 _natural_key 等价） + 按当前 locale 的字符串序
# （中文在 zh-CN 下即拼音序），能跟资源管理器看到的前后完全对齐。
# 非 Windows / 加载失败 → 下面回退到 _natural_key（仅英文数字命名下与 Windows一致）。
_str_cmp_logical = None
if sys.platform == 'win32':
    try:
        _shlwapi = ctypes.WinDLL('shlwapi')
        _str_cmp_logical = _shlwapi.StrCmpLogicalW
        _str_cmp_logical.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
        _str_cmp_logical.restype = ctypes.c_int
    except (OSError, AttributeError):
        _str_cmp_logical = None


def _cmp_names(a: str, b: str) -> int:
    """两个文件名的排序比较：能用 Win32 StrCmpLogicalW 就用，失败回退到自然序 key 比较。
    返回符号即可（负/0/正），Python sort 不要求具体量级。"""
    if _str_cmp_logical is not None:
        try:
            return _str_cmp_logical(a, b)
        except Exception:
            pass   # 单次异常不影响后续，回退到自然序
    ka, kb = _natural_key(a), _natural_key(b)
    return (ka > kb) - (ka < kb)


def _get_drives() -> list[str]:
    """枚举 Windows 可用盘符，返回如 ['C:\\\\', 'D:\\\\'] 的列表。"""
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    drives = []
    for i, letter in enumerate(string.ascii_uppercase):
        if bitmask & (1 << i):
            drives.append(f'{letter}:\\')
    return drives


def _parent_path(dir_path: str) -> str | None:
    """
    计算父路径：
    - '' (根级) → None
    - 'C:\\' (盘符根) → ''
    - 其余 → 截掉最后一段
    """
    if dir_path == '':
        return None
    # 盘符根目录：匹配 'X:\' 形式
    if len(dir_path) == 3 and dir_path[1] == ':' and dir_path[2] == '\\':
        return ''
    # 去掉尾部反斜杠后截断
    normalized = dir_path.rstrip('\\')
    idx = normalized.rfind('\\')
    if idx <= 2:
        # 截到盘符根，如 'C:\Users' → 'C:\'
        return normalized[:3]
    return normalized[:idx]


def _is_image_file(filename: str) -> bool:
    """判断文件名是否为支持的图片格式。"""
    _, ext = os.path.splitext(filename)
    return ext.lower() in IMAGE_EXTENSIONS


def list_directory(dir_path: str, base_url: str = '') -> dict:
    """
    列出目录信息（侧栏导航用）。

    参数:
        dir_path: 目录路径；'' 表示根级（盘符列表）
        base_url: HTTP 服务基础 URL，用于生成 thumb_url

    返回:
        { path, parent, dirs, images }
        - path: 当前路径（'' 表示根级）
        - parent: 父路径（根级为 None；盘符根目录为 ''）
        - dirs: 子目录名列表（已排序）；根级时为盘符名（如 'C:\\'）
        - images: 图片对象列表 [{name, thumb_url}]（已排序）
    """
    if dir_path == '':
        # 根级：返回盘符列表
        return {
            'path': '',
            'parent': None,
            'dirs': _get_drives(),
            'images': [],
        }

    # 正常目录扫描
    dirs = []
    images = []

    try:
        # ③-1 os.scandir 一次遍历即得类型（自带缓存 stat），省掉逐条 os.path.isdir/isfile 的额外系统调用
        with os.scandir(dir_path) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir()
                    is_file = entry.is_file()
                except OSError:
                    continue
                if is_dir:
                    dirs.append(entry.name)
                elif is_file and _is_image_file(entry.name):
                    encoded_path = quote(entry.path, safe='')
                    images.append({
                        'name': entry.name,
                        'thumb_url': f'{base_url}/thumb?path={encoded_path}',
                    })
    except (PermissionError, FileNotFoundError, OSError):
        # 无权限或路径不存在，返回空
        return {
            'path': dir_path,
            'parent': _parent_path(dir_path),
            'dirs': [],
            'images': [],
        }

    dirs.sort(key=cmp_to_key(_cmp_names))
    images.sort(key=cmp_to_key(lambda a, b: _cmp_names(a['name'], b['name'])))

    return {
        'path': dir_path,
        'parent': _parent_path(dir_path),
        'dirs': dirs,
        'images': images,
    }


def _read_size(file_path: str):
    """读取图片像素尺寸（仅解析文件头，不解码全图）；失败返回 None 供上层跳过。"""
    try:
        with Image.open(file_path) as img:
            return img.size
    except Exception:
        return None


def _size_pool_size() -> int:
    """并发读尺寸的线程数：IO 密集，取 CPU 核数若干倍并封顶，避免超大目录开太多线程。"""
    return min(16, max(4, (os.cpu_count() or 4) * 2))


def list_images(dir_path: str, base_url: str) -> list[dict]:
    """
    列出目录中所有图片的详细信息（主预览区用）。

    参数:
        dir_path: 目录绝对路径
        base_url: HTTP 服务基础 URL，如 'http://127.0.0.1:8080'

    返回:
        [{ name, url, width, height, thumb_url }]（按文件名排序）
        - url: 原图 HTTP 地址
        - thumb_url: 缩略图 HTTP 地址
        - width/height: 图片像素尺寸
    """
    # ③-1 os.scandir 一次遍历筛出图片文件（自带类型判断，省逐条 isfile）
    try:
        with os.scandir(dir_path) as it:
            names = []
            for e in it:
                try:
                    if e.is_file() and _is_image_file(e.name):
                        names.append(e.name)
                except OSError:
                    continue
    except (PermissionError, FileNotFoundError, OSError):
        return []

    names.sort(key=cmp_to_key(_cmp_names))
    full_paths = [os.path.join(dir_path, n) for n in names]

    # ③-2 线程池并发读尺寸：Image.open 只解析文件头（IO 密集，GIL 大部分时间释放），
    #     几百张时总耗时明显缩短；ex.map 保序，读失败返回 None 后跳过（维持原“损坏文件跳过”语义）
    with ThreadPoolExecutor(max_workers=_size_pool_size()) as ex:
        dims = list(ex.map(_read_size, full_paths))

    results = []
    for name, full_path, dim in zip(names, full_paths, dims):
        if dim is None:
            continue
        width, height = dim
        encoded_path = quote(full_path, safe='')
        results.append({
            'name': name,
            'url': f'{base_url}/image?path={encoded_path}',
            'width': width,
            'height': height,
            'thumb_url': f'{base_url}/thumb?path={encoded_path}',
        })

    return results
