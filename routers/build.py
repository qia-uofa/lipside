"""Build router – WebSocket streaming for lips build."""
import asyncio, json, os, sys
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

WINDOWS = sys.platform == "win32"


def _kill_tree(proc):
    """Kill the process and all its children, best-effort."""
    try:
        if WINDOWS:
            import subprocess as _sp
            _sp.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
            )
        else:
            os.killpg(os.getpgid(proc.pid), 9)  # SIGKILL entire process group
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


@router.websocket("/ws/build")
async def build_ws(ws: WebSocket, pipeline: str = "", stage: str = "", script: str = ""):
    await ws.accept()
    from .workspace import get_workspace
    ws_path = get_workspace()
    cwd = str(ws_path)

    stage_path = f"./{pipeline}/{stage}" if pipeline and stage else stage

    cmd = ["lips", "build"]
    if script:
        cmd.append(script)
    cmd.append(stage_path)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,      # own process group → tree-kill works
        )

        interrupted = False

        async def stream():
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                await ws.send_text(line.decode(errors="replace"))

        async def listen():
            nonlocal interrupted
            try:
                while True:
                    msg = await ws.receive_text()
                    if msg == "INTERRUPT":
                        interrupted = True
                        _kill_tree(proc)
                        break
            except WebSocketDisconnect:
                _kill_tree(proc)   # also kill if browser closes mid-build
            except Exception:
                pass

        stream_task = asyncio.create_task(stream())
        listen_task = asyncio.create_task(listen())

        done, pending = await asyncio.wait(
            [stream_task, listen_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()

        exit_code = await proc.wait()
        payload: dict = {"event": "done", "exit_code": exit_code}
        if interrupted:
            payload["interrupted"] = True
        await ws.send_text(json.dumps(payload))

    except FileNotFoundError:
        await ws.send_text(json.dumps({"event": "error", "message": "lips not found in PATH"}))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"event": "error", "message": str(e)}))
        except Exception:
            pass
