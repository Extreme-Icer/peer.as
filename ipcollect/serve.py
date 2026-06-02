"""本地 debug 用的静态文件服务器 (仅标准库)。

生产环境部署到 Cloudflare Pages，无需服务器；此命令只是在本地把 `ipc build` 产出的
静态目录 (dist/) 托管起来，方便调试——你看到的就是将部署的同一份产物。
"""
from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import parquet_export, util


def serve(cfg: dict, out_dir: str = "dist", port: int = 8787,
          host: str = "127.0.0.1", rebuild: bool = False) -> None:
    out = Path(out_dir)
    if rebuild:                                    # 只重拷前端(数据需 `ipc export-parquet`)
        n = parquet_export.copy_web(out_dir=out_dir)
        util.log(f"  sync-web: 拷 {n} 文件 (web/dist -> {out}/)")
    if not (out / "index.html").exists():
        util.log(f"  ! {out}/index.html 不存在 —— 先跑 `ipc export-parquet`(出数据) 或 `ipc build`(只前端)", err=True)

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
        import os
        # SPA 回退(与生产 CF/Caddy try_files 一致): 缺失路径(客户端路由 /4842、/1.1.1.0/24 等)改服务 index.html。
        # 真实文件(/assets、/data、/c、wasm 等)存在即原样服务。
        # 例外: /cdn-cgi/* 不回退(保持 404) —— 前端靠它是否 404 判定是否在 CF(见 db.js configure)。
        if not os.path.exists(self.translate_path(self.path)) and not self.path.startswith("/cdn-cgi/"):
            self.path = "/index.html"
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes="):
            return super().send_head()
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
