"""LIPSIDE - FastAPI entry point."""
import argparse, sys, uvicorn, webbrowser, threading
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response, JSONResponse
from pathlib import Path

from lipside.routers import workspace, files, build, create, config, purge, terminal

BASE = Path(__file__).parent
LOCALHOST_IPS = {"127.0.0.1", "::1", "localhost"}
ALLOWED_IPS: set[str] = set(LOCALHOST_IPS)


def load_whitelist(workspace_dir: Path) -> list[str]:
    """Read <workspace>/whitelist.txt; create it with one empty line if missing.

    Returns the list of non-empty, non-comment IP entries. An empty
    whitelist means localhost only.
    """
    path = workspace_dir / "whitelist.txt"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n")
        print(f"[LIPSIDE] Created {path} (empty -> localhost only)")
        return []
    entries = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(line)
    return entries

_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

def _serve_no_cache(filepath: Path, media_type: str) -> Response:
    return Response(filepath.read_bytes(), media_type=media_type, headers=_NO_CACHE)

app = FastAPI(title="LIPSIDE")


@app.middleware("http")
async def ip_whitelist_middleware(request: Request, call_next):
    # "0.0.0.0" in the whitelist means allow everyone.
    if "0.0.0.0" in ALLOWED_IPS:
        return await call_next(request)
    client_ip = request.client.host if request.client else None
    if client_ip not in ALLOWED_IPS:
        return JSONResponse(
            {"detail": f"Forbidden: {client_ip} not in whitelist"},
            status_code=403,
        )
    return await call_next(request)


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
    workspace_dir = Path(args.workspace).resolve()
    workspace.set_workspace(str(workspace_dir))
    active = workspace.get_active_pipeline()
    if active:
        print(f"[LIPSIDE] PIPELINE={active}")

    # Load whitelist from the workspace; populate the in-process allow-set used by middleware.
    whitelist = load_whitelist(workspace_dir)
    ALLOWED_IPS.clear()
    ALLOWED_IPS.update(LOCALHOST_IPS)
    ALLOWED_IPS.update(whitelist)

    if whitelist:
        # External IPs were listed -> bind to all interfaces so they can reach us.
        host = "0.0.0.0"
        if "0.0.0.0" in whitelist:
            print("[LIPSIDE] Whitelist contains 0.0.0.0 -> ALL IPs allowed")
        else:
            print(f"[LIPSIDE] Whitelist active: {sorted(whitelist)} (+ localhost)")
    else:
        # Empty whitelist -> localhost only.
        host = "127.0.0.1"
        print("[LIPSIDE] Whitelist empty -> localhost only")

    # CLI flags can still force a different bind, but the middleware enforces the whitelist either way.
    if args.all_interfaces:
        host = "0.0.0.0"
    elif args.host != "127.0.0.1":
        host = args.host

    url = f"http://127.0.0.1:{args.port}"
    threading.Timer(1.2, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
