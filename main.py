"""LIPSIDE - FastAPI entry point."""
import argparse, sys, uvicorn, webbrowser, threading
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response
from pathlib import Path

from lipside.routers import workspace, files, build, create, config, purge, terminal

BASE = Path(__file__).parent

_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

def _serve_no_cache(filepath: Path, media_type: str) -> Response:
    return Response(filepath.read_bytes(), media_type=media_type, headers=_NO_CACHE)

app = FastAPI(title="LIPSIDE")

# Serve these two files directly so the browser always gets the latest version.
@app.get("/static/app.js")
async def serve_appjs():
    return _serve_no_cache(BASE / "static" / "app.js", "application/javascript")

@app.get("/static/style.css")
async def serve_css():
    return _serve_no_cache(BASE / "static" / "style.css", "text/css")

app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

app.include_router(workspace.router)
app.include_router(files.router)
app.include_router(build.router)
app.include_router(create.router)
app.include_router(config.router)
app.include_router(purge.router)
app.include_router(terminal.router)

@app.get("/")
async def index():
    content = (BASE / "static" / "index.html").read_bytes()
    return Response(content, media_type="text/html", headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })


def main():
    parser = argparse.ArgumentParser(description="LIPSIDE dev server")
    parser.add_argument("--workspace", default=".", help="Path to LIPS workspace")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    parser.add_argument("--all-interfaces", action="store_true", help="Bind to 0.0.0.0 (all network interfaces)")
    args = parser.parse_args()
    workspace.set_workspace(str(Path(args.workspace).resolve()))
    active = workspace.get_active_pipeline()
    if active:
        print(f"[LIPSIDE] PIPELINE={active}")
    host = "0.0.0.0" if args.all_interfaces else args.host
    url = f"http://127.0.0.1:{args.port}"
    threading.Timer(1.2, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
