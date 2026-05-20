"""Terminal router – WebSocket PTY."""
import asyncio, os, sys
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

WINDOWS = sys.platform == "win32"


@router.websocket("/ws/terminal")
async def terminal_ws(ws: WebSocket, cwd: str = "."):
    await ws.accept()
    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        cwd = os.path.expanduser("~")

    if WINDOWS:
        await _run_winpty(ws, cwd)
    else:
        await _run_pty(ws, cwd)


async def _run_pty(ws: WebSocket, cwd: str):
    import pty, termios, struct, fcntl, signal
    shell = os.environ.get("SHELL", "/bin/bash")
    master_fd, slave_fd = pty.openpty()

    env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
    proc = await asyncio.create_subprocess_exec(
        shell, "--login",
        stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        cwd=cwd, env=env,
        start_new_session=True,
    )
    os.close(slave_fd)

    loop = asyncio.get_event_loop()

    async def read_pty():
        try:
            while True:
                data = await loop.run_in_executor(None, lambda: os.read(master_fd, 4096))
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass

    async def read_ws():
        try:
            while True:
                msg = await ws.receive_text()
                if msg.startswith("RESIZE:"):
                    _, dims = msg.split(":", 1)
                    rows, cols = (int(x) for x in dims.split(","))
                    winsize = struct.pack("HHHH", rows, cols, 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                else:
                    os.write(master_fd, msg.encode())
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    read_task = asyncio.create_task(read_pty())
    write_task = asyncio.create_task(read_ws())

    done, pending = await asyncio.wait(
        [read_task, write_task], return_when=asyncio.FIRST_COMPLETED
    )
    for t in pending:
        t.cancel()

    try:
        proc.kill()
    except Exception:
        pass
    try:
        os.close(master_fd)
    except Exception:
        pass


async def _run_winpty(ws: WebSocket, cwd: str):
    """Windows PTY using pywinpty if available, else bare subprocess."""
    try:
        from winpty import PtyProcess
        # Use PowerShell for better PATH/venv inheritance; pass current env
        # explicitly so the venv where `lips` is installed is on PATH.
        env = dict(os.environ)
        shell = os.environ.get("COMSPEC", "cmd.exe")
        # Prefer PowerShell if available (inherits venv PATH more reliably)
        import shutil
        if shutil.which("powershell.exe"):
            argv = ["powershell.exe", "-NoLogo", "-NoProfile"]
        else:
            argv = [shell]
        proc = PtyProcess.spawn(
            argv,
            cwd=cwd,
            dimensions=(24, 220),
            env=env,
        )

        loop = asyncio.get_event_loop()

        async def read_pty():
            try:
                while proc.isalive():
                    data = await loop.run_in_executor(None, proc.read, 4096)
                    if data:
                        await ws.send_text(data)
            except Exception:
                pass

        async def read_ws():
            try:
                while True:
                    msg = await ws.receive_text()
                    if msg.startswith("RESIZE:"):
                        _, dims = msg.split(":", 1)
                        rows, cols = (int(x) for x in dims.split(","))
                        proc.setwinsize(rows, cols)
                    else:
                        proc.write(msg)
            except WebSocketDisconnect:
                pass
            except Exception:
                pass

        read_task = asyncio.create_task(read_pty())
        write_task = asyncio.create_task(read_ws())
        done, pending = await asyncio.wait(
            [read_task, write_task], return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
        try:
            proc.terminate()
        except Exception:
            pass

    except ImportError:
        # bare subprocess fallback
        proc = await asyncio.create_subprocess_shell(
            "cmd.exe", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            cwd=cwd,
        )

        async def read_out():
            try:
                while True:
                    data = await proc.stdout.read(4096)
                    if not data:
                        break
                    await ws.send_bytes(data)
            except Exception:
                pass

        async def write_in():
            try:
                while True:
                    msg = await ws.receive_text()
                    if not msg.startswith("RESIZE:"):
                        proc.stdin.write(msg.encode())
                        await proc.stdin.drain()
            except WebSocketDisconnect:
                pass
            except Exception:
                pass

        rt = asyncio.create_task(read_out())
        wt = asyncio.create_task(write_in())
        done, pending = await asyncio.wait([rt, wt], return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        proc.kill()
