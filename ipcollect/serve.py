"""本地 debug 用的静态文件服务器 (仅标准库)。

生产环境部署到 Cloudflare Pages，无需服务器；此命令只是在本地把 `ipc build` 产出的
静态目录 (dist/) 托管起来，方便调试——你看到的就是将部署的同一份产物。
"""
from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import build, db, util


def serve(cfg: dict, out_dir: str = "dist", port: int = 8787,
          host: str = "127.0.0.1", rebuild: bool = False) -> None:
    out = Path(out_dir)
    if rebuild or not (out / "index.html").exists():
        if not rebuild:
            util.log(f"  {out}/ 不存在或不完整, 先 build…")
        conn = db.connect()
        try:
            r = build.build(cfg, conn, out_dir=out_dir)
            util.log(f"  build: {r['files']} 文件 / {util.human(r['bytes'])}B -> {r['out']}/")
        finally:
            conn.close()

    handler = partial(_QuietHandler, directory=str(out))
    httpd = ThreadingHTTPServer((host, port), handler)
    util.log(f"  静态看板: http://{host}:{port}/  (托管 {out}/, Ctrl-C 停止)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        util.log("  停止 Web 服务")


class _QuietHandler(SimpleHTTPRequestHandler):
    # 确保 .json/.js/.parquet 等 MIME 正确, 且静音默认日志
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".json": "application/json",
        ".js": "text/javascript",
        ".css": "text/css",
        ".parquet": "application/octet-stream",
    }

    def log_message(self, *a):
        pass

    def end_headers(self):
        # 告知客户端支持 Range(DuckDB-WASM 据此决定能否发字节区间请求)
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    # 支持 HTTP Range (206) —— DuckDB-WASM 对 parquet 发 Range 请求; Python 默认不支持。
    # 生产用 CF Pages(原生支持 Range), 此处仅让本地 debug 与生产一致、可测 Range 裁剪。
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes="):
            return super().send_head()
        import os
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.exists(path):
            return super().send_head()
        try:
            size = os.path.getsize(path)
            s, _, e = rng[len("bytes="):].partition("-")
            start = int(s) if s else 0
            end = int(e) if e else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_error(416, "Requested Range Not Satisfiable")
                return None
            f = open(path, "rb")
        except (OSError, ValueError):
            return super().send_head()
        f.seek(start)
        self.send_response(206)
        ctype = self.guess_type(path)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range = (start, end)
        return f

    def copyfile(self, source, outputfile):
        rng = getattr(self, "_range", None)
        if not rng:
            return super().copyfile(source, outputfile)
        start, end = rng
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
