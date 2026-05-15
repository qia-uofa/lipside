"""Build router – WebSocket streaming for lips build."""
import asyncio, json, shlex
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


@router.websocket("/ws/build")
async def build_ws(ws: WebSocket, pipeline: str = "", stage: str = "", script: str = ""):
    await ws.accept()
    from .workspace import get_workspace
    ws_path = get_workspace()
    cwd = str(ws_path)           # always run from workspace root

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
        )

        async def stream():
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                await ws.send_text(line.decode(errors="replace"))

        await stream()
        exit_code = await proc.wait()
        await ws.send_text(json.dumps({"event": "done", "exit_code": exit_code}))

    except FileNotFoundError:
        await ws.send_text(json.dumps({"event": "error", "message": "lips not found in PATH"}))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"event": "error", "message": str(e)}))
        except Exception:
            pass
