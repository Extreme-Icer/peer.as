import sys

from .cli import main

if __name__ == "__main__":
    # 必须透传退出码: `./ipc` 经 `python -m ipcollect` 走本文件(非 cli.py 的 __main__)。
    # 漏了 sys.exit 会让任何 ipc 失败都退出 0, 架空 deploy.sh 的 set -e -> 失败的 ingest/export
    # 仍继续 build+部署, 把空数据推上线(2026-06-05 主站炸库事故根因)。
    sys.exit(main())
