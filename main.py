"""
ScrollGallery 应用入口。
启动内嵌 HTTP 图片服务 + pywebview 窗口，通过 js_api 桥接前后端。
"""

import ctypes
import json
import os
import sys
import time

import webview

from backend.paths import get_data_root
from backend.scanner import list_directory, list_images
from backend.server import start_server, get_base_url


def _get_screen_size() -> tuple[int, int]:
    """主屏分辨率，折算为 pywebview 使用的逻辑像素(DIP)，与 create_window 坐标同基。"""
    user32 = ctypes.windll.user32
    scale = _system_scale() or 1.0
    return int(user32.GetSystemMetrics(0) / scale), int(user32.GetSystemMetrics(1) / scale)


def _find_hwnd(title: str = 'ScrollGallery'):
    """通过窗口标题获取 HWND。"""
    return ctypes.windll.user32.FindWindowW(None, title)


# ===== 标题栏深色（不随 Windows 系统主题变浅）=====
# 标题栏是原生非客户区，前端 CSS 的 color-scheme 管不到它，只能通过 DWM 窗口属性：
#   USE_IMMERSIVE_DARK_MODE 强制深色（Win10 1809+ 为 20，更早的内部构建为 19）；
#   Win11 额外支持钉住底色 / 文字 / 边框色，避免系统浅色主题下标题栏与黑色主区之间出现亮边。
# 不支持的属性调用会返回非 0 错误码，直接忽略（Win10 下仅靠上面的深色开关）。
_DWMWA_USE_IMMERSIVE_DARK_MODE = 20
_DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19
_DWMWA_BORDER_COLOR = 34      # 仅 Win11
_DWMWA_CAPTION_COLOR = 35     # 仅 Win11
_DWMWA_TEXT_COLOR = 36        # 仅 Win11
# COLORREF 为 0x00BBGGRR：以下两值对齐前端主题变量 --bg-main / --text-primary
_TITLEBAR_COLOR = 0x00000000  # 标题栏与边框底色：黑；改成 None 则用系统深色标题栏的默认灰
_TITLEBAR_TEXT = 0x00E0E0E0   # 标题文字色：浅灰


def _apply_dark_titlebar(hwnd) -> bool:
    """给窗口应用深色标题栏；hwnd 不存在时返回 False（供上层轮询重试）。"""
    if not hwnd:
        return False
    dwm = ctypes.windll.dwmapi
    size = ctypes.sizeof(ctypes.c_int)
    on = ctypes.c_int(1)
    if dwm.DwmSetWindowAttribute(hwnd, _DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(on), size) != 0:
        dwm.DwmSetWindowAttribute(hwnd, _DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ctypes.byref(on), size)
    if _TITLEBAR_COLOR is None:
        return True
    for attr, value in ((_DWMWA_BORDER_COLOR, _TITLEBAR_COLOR),
                        (_DWMWA_CAPTION_COLOR, _TITLEBAR_COLOR),
                        (_DWMWA_TEXT_COLOR, _TITLEBAR_TEXT)):
        color = ctypes.c_int(value)
        dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(color), size)
    return True


def _apply_titlebar_theme(timeout: float = 3.0):
    """GUI 就绪回调：轮询等窗口创建出来再设置（HWND 可能略晚于本回调）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _apply_dark_titlebar(_find_hwnd()):
            return
        time.sleep(0.05)


def _is_window_maximized() -> bool:
    """使用 Win32 IsZoomed 检测窗口是否最大化。"""
    hwnd = _find_hwnd()
    if hwnd:
        return bool(ctypes.windll.user32.IsZoomed(hwnd))
    return False


def _force_maximize():
    """
    强制重新最大化窗口。
    先 SW_RESTORE 重置状态，再 SW_MAXIMIZE 让 Windows 重新计算正确的最大化尺寸。
    """
    hwnd = _find_hwnd()
    if not hwnd:
        return
    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    SW_MAXIMIZE = 3
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.ShowWindow(hwnd, SW_MAXIMIZE)


# ===== Win32 手动全屏（绕过 pywebview toggle_fullscreen 的状态破坏问题） =====
_GWL_STYLE = -16
_WS_CAPTION = 0x00C00000
_WS_THICKFRAME = 0x00040000
_SWP_NOZORDER = 0x0004
_SWP_FRAMECHANGED = 0x0020


class RECT(ctypes.Structure):
    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                ('right', ctypes.c_long), ('bottom', ctypes.c_long)]


def _enter_native_fullscreen(hwnd) -> tuple:
    """
    进入全屏：保存当前窗口样式和位置，去掉边框，铺满整个屏幕。
    返回 (saved_style, saved_rect) 供退出时恢复。
    """
    user32 = ctypes.windll.user32
    # 保存当前样式
    saved_style = user32.GetWindowLongW(hwnd, _GWL_STYLE)
    # 保存当前位置
    saved_rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(saved_rect))
    # 去掉标题栏和边框
    new_style = saved_style & ~(_WS_CAPTION | _WS_THICKFRAME)
    user32.SetWindowLongW(hwnd, _GWL_STYLE, new_style)
    # 铺满整个屏幕（含任务栏区域）
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)
    user32.SetWindowPos(hwnd, 0, 0, 0, screen_w, screen_h,
                        _SWP_NOZORDER | _SWP_FRAMECHANGED)
    return saved_style, saved_rect


def _exit_native_fullscreen(hwnd, saved_style: int, saved_rect: RECT, was_maximized: bool):
    """
    退出全屏：恢复窗口样式，然后根据之前的状态最大化或恢复到原位置。
    """
    user32 = ctypes.windll.user32
    # 恢复样式
    user32.SetWindowLongW(hwnd, _GWL_STYLE, saved_style)
    if was_maximized:
        # 先恢复到保存的位置（让 Windows 更新 restore bounds），再最大化
        user32.SetWindowPos(hwnd, 0,
                            saved_rect.left, saved_rect.top,
                            saved_rect.right - saved_rect.left,
                            saved_rect.bottom - saved_rect.top,
                            _SWP_NOZORDER | _SWP_FRAMECHANGED)
        user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
    else:
        # 恢复到原来的位置和大小
        user32.SetWindowPos(hwnd, 0,
                            saved_rect.left, saved_rect.top,
                            saved_rect.right - saved_rect.left,
                            saved_rect.bottom - saved_rect.top,
                            _SWP_NOZORDER | _SWP_FRAMECHANGED)
    # 退出全屏重建了非客户区（标题栏重现），重新钉一次深色
    _apply_dark_titlebar(hwnd)


# ===== 窗口几何持久化（记住退出时的位置 / 尺寸 / 最大化状态）=====
# 与缩略图 / localStorage 同根（get_data_root()），删程序文件夹即无残留。
# 坐标一律用 pywebview 的 window.x/y/width/height（逻辑像素 DIP，与 create_window 同基），
# 不碰 Win32 GetWindowRect/Placement 的物理像素，避免高 DPI 缩放下“存物理 / 读 DIP”造成错位。
_WINDOW_STATE_FILE = 'window.json'


def _system_scale() -> float:
    """系统 DPI 缩放比例（100%=1.0）。进程 DPI-aware 时 GetSystemMetrics 返回物理像素，
    需按此比例折算成 DIP 才能与窗口坐标同基比较。取不到按 1.0。"""
    try:
        dpi = ctypes.windll.shcore.GetDpiForSystem()
        if dpi:
            return dpi / 96.0
    except Exception:
        pass
    return 1.0


def _window_state_path() -> str:
    return os.path.join(get_data_root(), _WINDOW_STATE_FILE)


def _load_window_state():
    """读上次退出的窗口几何；无文件 / 解析失败 / 字段缺失 → None（启动回默认居中）。"""
    try:
        with open(_window_state_path(), 'r', encoding='utf-8') as f:
            d = json.load(f)
        return {
            'x': int(d['x']), 'y': int(d['y']),
            'w': int(d['w']), 'h': int(d['h']),
            'maximized': bool(d['maximized']),
        }
    except (OSError, ValueError, KeyError):
        return None


def _save_window_state(state: dict):
    try:
        with open(_window_state_path(), 'w', encoding='utf-8') as f:
            json.dump(state, f)
    except OSError:
        pass


def _is_on_screen(x, y, w, h, scale) -> bool:
    """判断窗口（DIP 坐标）是否与虚拟桌面（含多屏）有足够交集，避免恢复到抓不到的屏幕外。
    GetSystemMetrics 返回物理像素，先按 scale 折算成 DIP 再与窗口坐标同基比较。"""
    if scale <= 0:
        scale = 1.0
    user32 = ctypes.windll.user32
    vx = user32.GetSystemMetrics(76) / scale   # SM_XVIRTUALSCREEN
    vy = user32.GetSystemMetrics(77) / scale   # SM_YVIRTUALSCREEN
    vw = user32.GetSystemMetrics(78) / scale   # SM_CXVIRTUALSCREEN
    vh = user32.GetSystemMetrics(79) / scale   # SM_CYVIRTUALSCREEN
    if vw <= 0 or vh <= 0:
        return True                             # 取不到虚拟桌面尺寸则不作限制
    return (x < vx + vw - 40) and (x + w > vx + 40) and (y < vy + vh - 40) and (y + h > vy + 40)


def _get_frontend_path() -> str:
    """
    解析前端 index.html 的绝对路径。
    兼容开发环境（源码目录）和 PyInstaller 打包环境（_MEIPASS）。
    """
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后，资源在 sys._MEIPASS 下
        base = sys._MEIPASS
    else:
        # 开发环境：相对于本文件所在目录
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, 'frontend', 'index.html')


def _get_storage_path() -> str:
    """
    返回 WebView2 用户数据（localStorage/cookies）的持久化目录。
    private_mode=False 时 pywebview 用此目录保存数据，使“记住上次目录”跨启动生效。
    与缩略图缓存同根（程序目录下 .cache），做到删程序文件夹即无残留；不可写时回退 %LOCALAPPDATA%。
    """
    path = os.path.join(get_data_root(), 'webview')
    os.makedirs(path, exist_ok=True)
    return path


class Api:
    """暴露给前端 JS 的 API（通过 window.pywebview.api 调用）。"""

    def __init__(self):
        self._window = None
        self._is_fullscreen = False
        self._was_maximized = False
        self._saved_style = None
        self._saved_rect = None

    def set_window(self, window):
        """由 main() 在创建窗口后调用，保存窗口引用。"""
        self._window = window

    def list_images(self, dir_path: str) -> list:
        """
        列出目录中的图片详情。
        前端调用: await window.pywebview.api.list_images(dirPath)
        返回: [{ name, url, width, height, thumb_url }]
        """
        return list_images(dir_path, get_base_url())

    def list_directory(self, dir_path: str) -> dict:
        """
        列出目录信息（侧栏导航用）。
        前端调用: await window.pywebview.api.list_directory(dirPath)
        返回: { path, parent, dirs, images: [{name, thumb_url}] }
        """
        return list_directory(dir_path, get_base_url())

    def toggle_fullscreen(self):
        """
        切换窗口全屏状态（Win32 手动实现，绕过 pywebview 的状态破坏问题）。
        进入全屏：保存窗口样式/位置 → 去边框 → 铺满屏幕。
        退出全屏：恢复样式 → 最大化或恢复原位。
        """
        hwnd = _find_hwnd()
        if not hwnd:
            return

        if not self._is_fullscreen:
            # 进入全屏：先置 _is_fullscreen，屏蔽随后 SetWindowPos 触发的 move/resize 误记正常边界
            self._was_maximized = _is_window_maximized()
            self._is_fullscreen = True
            self._saved_style, self._saved_rect = _enter_native_fullscreen(hwnd)
        else:
            # 退出全屏
            _exit_native_fullscreen(hwnd, self._saved_style, self._saved_rect,
                                    self._was_maximized)
            self._is_fullscreen = False


def main():
    # 1. 启动内嵌 HTTP 图片服务（后台守护线程）
    start_server()
    print(f'[ScrollGallery] 图片服务已启动: {get_base_url()}')

    # 2. 创建 js_api 实例
    api = Api()

    # 3. 前端入口路径
    frontend_path = _get_frontend_path()
    print(f'[ScrollGallery] 前端路径: {frontend_path}')

    # 4. 创建窗口：优先恢复上次退出时记录的几何（位置 / 尺寸 / 是否最大化）；
    #    无记录（首次运行）则按默认尺寸在屏幕居中。
    default_w, default_h = 1100, 650
    screen_w, screen_h = _get_screen_size()
    saved = _load_window_state()
    if saved:
        win_w, win_h = saved['w'], saved['h']
        win_x, win_y = saved['x'], saved['y']
        win_maximized = saved['maximized']
        # 位置失效（多屏变化 / 记录异常）时只丢位置、保留尺寸并重新居中，避免窗口跑到屏幕外抓不到
        if not win_maximized and not _is_on_screen(win_x, win_y, win_w, win_h, _system_scale()):
            win_x = (screen_w - win_w) // 2
            win_y = (screen_h - win_h) // 2
    else:
        win_w, win_h = default_w, default_h
        win_x = (screen_w - win_w) // 2
        win_y = (screen_h - win_h) // 2
        win_maximized = False

    window = webview.create_window(
        title='ScrollGallery',
        url=frontend_path,
        js_api=api,
        width=win_w,
        height=win_h,
        x=win_x,
        y=win_y,
        maximized=win_maximized,
        min_size=(800, 600),
        background_color='#1e1e1e',  # 匹配深色主题 --bg-main
        zoomable=False,               # 禁用 Ctrl+滚轮缩放
        text_select=True,             # 允许文本选择（调试用，生产可关）
    )

    # 将窗口引用传给 Api，使全屏切换可调用原生方法
    api.set_window(window)

    # ---- 退出时记住窗口几何（供下次启动恢复）----
    # 用 pywebview 自己的 window.x/y/width/height（逻辑像素，与 create_window 同基，规避 DPI 错位）；
    # 最大化态用 IsZoomed 判定。正常态的位置 / 尺寸在每次移动 / 缩放后刷进 normal_bounds，
    # 以便“最大化时退出”也能存回还原边界（最大化时 window.width 反映的是铺满尺寸，不能用）。
    normal_bounds = {'x': win_x, 'y': win_y, 'w': win_w, 'h': win_h}

    def _in_normal() -> bool:
        # 非最大化、非最小化、非自制全屏时才算“正常态”，其 window.x/y/width/height 可作还原边界
        if api._is_fullscreen or _is_window_maximized():
            return False
        hwnd = _find_hwnd()
        if hwnd and ctypes.windll.user32.IsIconic(hwnd):
            return False
        return True

    def _track_normal(*_):
        if not _in_normal():
            return
        try:
            normal_bounds.update({'x': int(window.x), 'y': int(window.y),
                                  'w': int(window.width), 'h': int(window.height)})
        except (TypeError, ValueError):
            pass   # 拿不到就保留上一次记录，不用错误值覆盖

    def _on_window_closing(*_):
        _track_normal()   # 退出前再抓一次（正常态才生效）
        _save_window_state({**normal_bounds, 'maximized': _is_window_maximized()})

    window.events.moved += _track_normal
    window.events.resized += _track_normal
    window.events.closing += _on_window_closing

    # 5. 启动窗口（阻塞直到窗口关闭）
    #    debug 按运行方式自动切换：源码运行开（F12 开发者工具 + 右键刷新，方便前端微调）；
    #      打包成 exe（sys.frozen）后自动关，生产版不再带控制台/开发者工具。
    #    private_mode=False + storage_path: 持久化 localStorage，使“记住上次目录”跨启动生效
    #      （private_mode=False 时 pywebview 自动改用固定端口 42001，保证 origin 稳定）
    #    传入 _apply_titlebar_theme：GUI 就绪后把标题栏钉成深色，不受系统主题色影响
    # 关闭 WebView2 后台联网与组件下载：本地看图器不加载任何远程内容，只与 127.0.0.1
    # 回环通信，广告过滤库 / 证书吊销列表 / 安全浏览等对它无意义，却会在 .cache 里堆十几 MB。
    # 必须在 webview.start() 前设——浏览器进程只在首次创建时读一次环境变量。
    # 用 setdefault 而非直接赋值，将来要加别的 flag 时不被覆盖。
    os.environ.setdefault(
        'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
        '--disable-background-networking --disable-component-update',
    )

    is_frozen = getattr(sys, 'frozen', False)     # 打包后为 True
    webview.start(_apply_titlebar_theme, debug=not is_frozen, private_mode=False, storage_path=_get_storage_path())

    print('[ScrollGallery] 窗口已关闭，应用退出。')


if __name__ == '__main__':
    main()
