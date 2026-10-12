"""
缩略图生成与缓存模块。
为侧栏网格提供下采样小图（长边 ≤ 300px），避免浏览器加载原图。
GIF 取首帧，输出统一为 JPEG（quality=80）。
缓存分两级：内存 LRU（进程内）+ 磁盘缓存（跨重启）；生成时对 JPEG/PNG 走降采样解码（draft）省 CPU。
"""

import hashlib
import io
import os
import threading
from collections import OrderedDict

from PIL import Image

from backend.paths import get_data_root

# ===== 配置 =====
THUMB_MAX_SIZE = (600, 600)   # 缩略图最大尺寸（长边≤600px，保持比例）
THUMB_QUALITY = 80            # JPEG 压缩质量
THUMB_BG_COLOR = (37, 37, 38) # 透明图片的背景填充色（匹配侧栏 --bg-sidebar: #252526）
CACHE_MAX_ENTRIES = 200       # 内存 LRU 上限，防止内存膨胀

# ===== 磁盘缓存（④-2）=====
# 内存缓存进程重启即失效；磁盘缓存按「绝对路径+mtime」哈希落盘，跨重启复用，
# 第二次及以后浏览同目录近乎即时。为避免无限增长，设容量上限并做 LRU 淘汰（按访问时间）。
DISK_CACHE_MAX_BYTES = 100 * 1024 * 1024   # 磁盘缓存上限 100MB（约 1800 张），超出删最久未访问的
DISK_EVICT_CHECK_EVERY = 64                # 每写入 N 张触发一次淘汰扫描（避免每次写盘都扫目录）
THUMB_VERSION = '1'                        # 生成参数版本号：改了尺寸/质量就 +1，旧条目自然失效被 LRU 挤掉


def _cache_root() -> str:
    """磁盘缓存目录：程序目录下的 .cache\\thumbs（删程序文件夹即无残留）；不可写时回退 %LOCALAPPDATA%。"""
    return os.path.join(get_data_root(), 'thumbs')


_DISK_CACHE_DIR = _cache_root()

# ===== 内存缓存 =====
# 结构: OrderedDict{ abs_path: (mtime: float, thumb_bytes: bytes) }
_cache: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
_cache_lock = threading.Lock()

# 磁盘淘汰相关轻量状态：写入计数 + 独立锁（淘汰扫描串行化）+ 目录就绪标志
_disk_writes_since_evict = 0
_disk_lock = threading.Lock()
_disk_dir_ready = False


def _generate_thumb(file_path: str) -> bytes:
    """
    生成缩略图字节流（JPEG 格式）。
    - 使用 Pillow thumbnail() 等比缩放
    - GIF 自动取首帧（Image.open 默认行为）
    - 透明通道图片先贴到深色背景再转 JPEG
    """
    with Image.open(file_path) as img:
        # ④-1 降采样解码：JPEG/PNG 在解码阶段就按目标尺寸缩小(1/2·1/4·1/8)，
        # 避免把 4000px 大图整幅解码后再缩小——少解数倍像素，更快更省内存。
        # mode 传 None：不改色彩空间（保留 alpha 供下面透明合成），只做尺寸缩减。
        try:
            img.draft(None, THUMB_MAX_SIZE)
        except Exception:
            pass  # 个别格式不支持 draft：忽略，走原逻辑

        # GIF/多帧图片：确保停在首帧
        if hasattr(img, 'n_frames') and img.n_frames > 1:
            img.seek(0)

        # 转为 RGB（处理 RGBA/P/LA 等模式）
        if img.mode in ('RGBA', 'LA', 'PA'):
            # 有透明通道：贴到深色背景
            background = Image.new('RGB', img.size, THUMB_BG_COLOR)
            # 需要先把 img 转为 RGBA 以获取 alpha 通道
            rgba = img.convert('RGBA')
            background.paste(rgba, mask=rgba.split()[-1])  # 用 alpha 通道作蒙版
            rgb_img = background
        elif img.mode != 'RGB':
            rgb_img = img.convert('RGB')
        else:
            rgb_img = img.copy()  # copy 以便在 with 块外使用

        # 等比缩放
        rgb_img.thumbnail(THUMB_MAX_SIZE, Image.LANCZOS)

        # 输出为 JPEG 字节流
        buffer = io.BytesIO()
        rgb_img.save(buffer, format='JPEG', quality=THUMB_QUALITY)
        return buffer.getvalue()


def _disk_cache_path(file_path: str, mtime: float) -> str:
    """按「绝对路径(小写)+mtime+版本」哈希生成磁盘缓存文件名；同一图恒定同名 → 天然去重。"""
    raw = f'{os.path.abspath(file_path).lower()}|{mtime}|v{THUMB_VERSION}'.encode('utf-8')
    return os.path.join(_DISK_CACHE_DIR, hashlib.sha1(raw).hexdigest() + '.jpg')


def _ensure_disk_dir() -> None:
    global _disk_dir_ready
    if not _disk_dir_ready:
        try:
            os.makedirs(_DISK_CACHE_DIR, exist_ok=True)
        except OSError:
            pass
        _disk_dir_ready = True


def _remember_in_memory(file_path: str, mtime: float, data: bytes) -> None:
    """写入内存 LRU 并做上限淘汰。"""
    with _cache_lock:
        _cache[file_path] = (mtime, data)
        _cache.move_to_end(file_path)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)


def _read_disk(path: str) -> bytes | None:
    try:
        with open(path, 'rb') as f:
            return f.read()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _write_disk(path: str, data: bytes) -> None:
    """原子写入磁盘缓存（先写 .tmp 再 replace），并按节流触发 LRU 淘汰。"""
    global _disk_writes_since_evict
    _ensure_disk_dir()
    tmp = path + '.tmp'
    try:
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    except OSError:
        return
    with _disk_lock:
        _disk_writes_since_evict += 1
        if _disk_writes_since_evict >= DISK_EVICT_CHECK_EVERY:
            _disk_writes_since_evict = 0
            _evict_disk_cache_locked()


def _evict_disk_cache_locked() -> None:
    """LRU 淘汰：磁盘缓存超上限时按访问时间升序删最旧的一批，直到回到线下。调用方须持有 _disk_lock。"""
    entries = []
    total = 0
    try:
        with os.scandir(_DISK_CACHE_DIR) as it:
            for e in it:
                if not e.name.endswith('.jpg'):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                entries.append((e.path, st.st_atime, st.st_size))
                total += st.st_size
    except OSError:
        return
    if total <= DISK_CACHE_MAX_BYTES:
        return
    entries.sort(key=lambda x: x[1])           # 最久未访问在前
    for path, _, size in entries:
        if total <= DISK_CACHE_MAX_BYTES:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass


def get_thumbnail(file_path: str) -> bytes:
    """
    获取缩略图字节流：内存 LRU → 磁盘缓存 → 现算（三级）。
    - 命中内存且文件未改 → 直接返回（最快）
    - 命中磁盘 → 读回并回填内存 + touch 访问时间（跨重启复用的关键）
    - 均未命中 → 降采样生成 → 写内存 + 写磁盘
    """
    try:
        mtime = os.path.getmtime(file_path)
    except OSError:
        raise FileNotFoundError(f'Cannot stat file: {file_path}')

    # 1. 内存缓存命中
    with _cache_lock:
        if file_path in _cache:
            cached_mtime, cached_bytes = _cache[file_path]
            if cached_mtime == mtime:
                _cache.move_to_end(file_path)
                return cached_bytes
            del _cache[file_path]          # 文件已修改，作废旧缓存

    # 2. 磁盘缓存命中
    disk_path = _disk_cache_path(file_path, mtime)
    disk_bytes = _read_disk(disk_path)
    if disk_bytes is not None:
        try:
            os.utime(disk_path, None)       # 标记最近访问，供磁盘 LRU 使用
        except OSError:
            pass
        _remember_in_memory(file_path, mtime, disk_bytes)
        return disk_bytes

    # 3. 现算（锁外执行，避免阻塞其他并发请求）
    thumb_bytes = _generate_thumb(file_path)
    _remember_in_memory(file_path, mtime, thumb_bytes)
    _write_disk(disk_path, thumb_bytes)
    return thumb_bytes


def get_cache_stats() -> dict:
    """返回缓存统计信息（调试用）：内存 LRU + 磁盘缓存目录占用。"""
    with _cache_lock:
        total_bytes = sum(len(data) for _, (_, data) in _cache.items())
        result = {
            'entries': len(_cache),
            'max_entries': CACHE_MAX_ENTRIES,
            'total_memory_kb': round(total_bytes / 1024, 1),
        }
    disk_files = 0
    disk_bytes = 0
    try:
        with os.scandir(_DISK_CACHE_DIR) as it:
            for e in it:
                if e.name.endswith('.jpg'):
                    disk_files += 1
                    try:
                        disk_bytes += e.stat().st_size
                    except OSError:
                        pass
    except OSError:
        pass
    result['disk_files'] = disk_files
    result['disk_total_mb'] = round(disk_bytes / 1024 / 1024, 2)
    result['disk_max_mb'] = round(DISK_CACHE_MAX_BYTES / 1024 / 1024, 2)
    result['disk_dir'] = _DISK_CACHE_DIR
    return result


def clear_cache(clear_disk: bool = False):
    """清空缩略图缓存。默认仅清内存 LRU；clear_disk=True 时一并清空磁盘缓存目录。"""
    with _cache_lock:
        _cache.clear()
    if clear_disk:
        try:
            with os.scandir(_DISK_CACHE_DIR) as it:
                for e in it:
                    if e.name.endswith('.jpg') or e.name.endswith('.tmp'):
                        try:
                            os.remove(e.path)
                        except OSError:
                            pass
        except OSError:
            pass
