#!/usr/bin/env python3
"""
Runtime preload launcher for bytedance/trae-agent (Zero upstream file edits).

Fixes two Windows Chinese-locale issues in trae-agent:
1. cmd.exe /v:on outputs CP936/GBK bytes (e.g. 0xb0) that cause _BashSession.run()
   to raise UnicodeDecodeError BEFORE clearing stdout/stderr _buffer, poisoning all
   subsequent tool calls.
2. Reconfigures stdout/stderr to UTF-8 with errors='replace'.
"""

import asyncio
import os
import sys

for stream_name in ("stdout", "stderr"):
    stream = getattr(sys, stream_name, None)
    if stream is not None and hasattr(stream, "reconfigure"):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

import trae_agent.tools.bash_tool as bt  # noqa: E402
from trae_agent.cli import main  # noqa: E402

_orig_start = bt._BashSession.start


async def _patched_start(self):
    await _orig_start(self)
    if os.name == "nt" and self._process and self._process.stdin:
        self._process.stdin.write(b"chcp 65001 >nul 2>&1\r\n")
        await self._process.stdin.drain()
        await asyncio.sleep(0.15)
        if hasattr(self._process.stdout, "_buffer"):
            self._process.stdout._buffer.clear()
        if hasattr(self._process.stderr, "_buffer"):
            self._process.stderr._buffer.clear()


_orig_run = bt._BashSession.run


async def _safe_run(self, command):
    try:
        return await _orig_run(self, command)
    except UnicodeDecodeError:
        out_b = bytes(self._process.stdout._buffer) if hasattr(self._process.stdout, "_buffer") else b""
        err_b = bytes(self._process.stderr._buffer) if hasattr(self._process.stderr, "_buffer") else b""
        if hasattr(self._process.stdout, "_buffer"):
            self._process.stdout._buffer.clear()
        if hasattr(self._process.stderr, "_buffer"):
            self._process.stderr._buffer.clear()
        return bt.ToolExecResult(
            output=out_b.decode("mbcs", errors="replace"),
            error=err_b.decode("mbcs", errors="replace"),
            error_code=1,
        )


bt._BashSession.start = _patched_start
bt._BashSession.run = _safe_run

if __name__ == "__main__":
    main()
