"""
内嵌 HTTP 图片服务 —— 向前端提供原图和缩略图的字节流。
使用 bottle 微框架 + wsgiref 实现，监听 127.0.0.1 随机端口。
"""

import mimetypes
import os
import threading
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server, WSGIRequestHandler, WSGIServer

from bottle import Bottle, request, response, HTTPError

from backend.scanner import IMAGE_EXTENSIONS
from backend.thumbnail import get_thumbnail

# 创建 bottle 应用实例
app = Bottle()

# 模块级变量：记录实际绑定的端口
_server = None
_port = None


def _get_path_param() -> str:
    """
    从原始 QUERY_STRING 中提取 path 参数并正确解码为 UTF-8。
    不依赖 bottle 的 FormsDict（其 WSGI 层可能以 latin-1 解码导致中文乱码）。
    """
    qs = request.environ.get('QUERY_STRING', '')
    params = parse_qs(qs, encoding='utf-8')
    return params.get('path', [''])[0]


def _validate_image_path(file_path: str) -> str:
    """
    校验图片路径。
    - 确认文件存在
    - 确认扩展名在白名单内（防止读取任意文件）
    返回绝对路径，校验失败则抛出 HTTPError。
    """
    if not file_path:
        raise HTTPError(400, 'Missing "path" query parameter')

    if not os.path.isfile(file_path):
        raise HTTPError(404, f'File not found: {file_path}')

    _, ext = os.path.splitext(file_path)
    if ext.lower() not in IMAGE_EXTENSIONS:
        raise HTTPError(403, f'Unsupported file type: {ext}')

    return file_path


def _guess_content_type(file_path: str) -> str:
    """根据文件扩展名推断 MIME 类型。"""
    mime, _ = mimetypes.guess_type(file_path)
    if mime:
        return mime
    # 兜底：webp 在某些系统 mimetypes 中可能未注册
    ext = os.path.splitext(file_path)[1].lower()
    fallback = {
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
    }
    return fallback.get(ext, 'application/octet-stream')


def _iter_file(file_path: str, chunk_size: int = 64 * 1024):
    """分块流式读取文件：每次只读 chunk_size 字节 yield 出去，读完或异常都在 finally 关闭句柄。
    避免把整张原图一次性读进内存后驻留（多线程并发下尤其省峰值内存）。"""
    f = open(file_path, 'rb')
    try:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        f.close()


@app.route('/image')
def serve_image():
    """提供原图字节流（分块流式返回，不把整张图读进内存）。"""
    file_path = _validate_image_path(_get_path_param())
    response.content_type = _guess_content_type(file_path)
    # 原图不入 Chromium 磁盘缓存：本地 loopback 多一次读盘 + 几 ms HTTP 开销，会被 50–100 ms
    # 的 JPEG 解码吞掉，肉眼无差；换来 .cache\webview\...\Cache_Data 不再随浏览规模
    # 疯涨（实测能省几百 MB）。内存 cache 仍会短暂持有本 session 里刚看过的图，回看不受影响。
    response.set_header('Cache-Control', 'no-store')
    # 显式给出长度：浏览器可显示进度、走普通短连接而非 chunked；生成器 yield 的总字节与之吻合
    response.set_header('Content-Length', str(os.path.getsize(file_path)))
    return _iter_file(file_path)


@app.route('/thumb')
def serve_thumb():
    """提供缩略图字节流（JPEG，长边≤300px，GIF取首帧）。"""
    file_path = _validate_image_path(_get_path_param())
    response.content_type = 'image/jpeg'
    # 缩略图同样不入浏览器磁盘缓存：bottle 绑随机端口（127.0.0.1:0），每次启动 URL 都变，
    # max-age 跨会话根本命中不了，只会把每个会话浏览过的缩略图当新条目越堆越多（实测能堆到上百 MB）。
    # 真正的缩略图缓存在我们自己那套有上限、LRU 淘汰的磁盘缓存 .cache\\thumbs（见 thumbnail.py），
    # 回看时命中内存/磁盘是亚毫秒级，浏览器 no-store 再多请求一次也察觉不到。
    response.set_header('Cache-Control', 'no-store')
    return get_thumbnail(file_path)


class _QuietHandler(WSGIRequestHandler):
    """抑制 wsgiref 默认的请求日志输出。"""
    def log_message(self, format, *args):
        pass


class _ThreadingServer(ThreadingMixIn, WSGIServer):
    """每个请求独立线程处理：多图 / 缩略图请求不再串行排队。
    daemon_threads=True 让请求线程随主进程退出，不阻塞关闭窗口。"""
    daemon_threads = True


def start_server():
    """
    在后台守护线程中启动 HTTP 服务。
    绑定 127.0.0.1:0（由 OS 分配随机可用端口）。
    调用后可通过 get_base_url() 获取实际地址。
    """
    global _server, _port

    _server = make_server('127.0.0.1', 0, app,
                          server_class=_ThreadingServer, handler_class=_QuietHandler)
    _port = _server.server_address[1]

    thread = threading.Thread(target=_server.serve_forever, daemon=True)
    thread.start()


def get_base_url() -> str:
    """返回 HTTP 服务的基础 URL，如 'http://127.0.0.1:54321'。"""
    if _port is None:
        raise RuntimeError('HTTP server not started. Call start_server() first.')
    return f'http://127.0.0.1:{_port}'


def stop_server():
    """停止 HTTP 服务（用于测试/清理）。"""
    global _server, _port
    if _server:
        _server.shutdown()
        _server = None
        _port = None
