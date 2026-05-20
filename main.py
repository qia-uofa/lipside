"""LIPSIDE - FastAPI entry point."""
import argparse, sys, uvicorn, webbrowser, threading, time
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response, JSONResponse, RedirectResponse
from pathlib import Path

from lipside import auth
from lipside.tls import _ensure_tls_cert, _print_cert_info
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


@app.middleware("http")
async def ip_whitelist_middleware(request: Request, call_next):
    if "0.0.0.0" in auth.ALLOWED_IPS:
        return await call_next(request)
    client_ip = request.client.host if request.client else None
    if client_ip in auth.ALLOWED_IPS:
        return await call_next(request)
    if client_ip and auth.ip_currently_unlocked(client_ip):
        return await call_next(request)
    if request.url.path == "/unlock":
        return await call_next(request)
    if auth.PASSKEY_CONFIG.get("allow_passkey"):
        return auth.passkey_form(error=False)
    return JSONResponse(
        {"detail": f"Forbidden: {client_ip} not in whitelist"},
        status_code=403,
    )


@app.post("/unlock")
async def unlock(request: Request):
    client_ip = request.client.host if request.client else None
    if not auth.PASSKEY_CONFIG.get("allow_passkey"):
        return JSONResponse({"detail": "Passkey disabled"}, status_code=403)
    body = await request.body()
    submitted = auth.extract_passkey(request.headers.get("content-type", ""), body)
    current = auth.PASSKEY_CONFIG.get("passkey", "")
    if not current or submitted != current:
        print(
            f"[LIPSIDE] Rejected unlock from {client_ip}: "
            f"got={submitted!r} (len={len(submitted)}), expected len={len(current)}"
        )
        return auth.passkey_form(error=True)
    timeout = int(auth.PASSKEY_CONFIG.get("timeout", 600))
    auth.UNLOCKED_IPS[client_ip] = time.time() + timeout
    new_key = auth.rotate_passkey()
    print(f"[LIPSIDE] Unlocked {client_ip} for {timeout}s; new passkey: {new_key}")
    return RedirectResponse("/", status_code=303)


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
    return Response(content, media_type="text/html", headers=_NO_CACHE)


def main():
    parser = argparse.ArgumentParser(description="LIPSIDE dev server")
    parser.add_argument("--workspace", default=".", help="Path to LIPS workspace")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    parser.add_argument("--all-interfaces", action="store_true", help="Bind to 0.0.0.0 (all network interfaces)")
    parser.add_argument("--no-tls", action="store_true", help="Disable HTTPS and serve plain HTTP (not recommended outside loopback)")
    parser.add_argument("--cert", metavar="PATH", help="Path to a TLS certificate file (PEM). Disables auto-generation.")
    parser.add_argument("--key",  metavar="PATH", help="Path to the matching TLS private key (PEM). Required with --cert.")
    args = parser.parse_args()

    workspace_dir = Path(args.workspace).resolve()
    auth.WORKSPACE_DIR = workspace_dir
    workspace.set_workspace(str(workspace_dir))
    active = workspace.get_active_pipeline()
    if active:
        print(f"[LIPSIDE] PIPELINE={active}")

    whitelist, cfg = auth.load_whitelist(workspace_dir)
    auth.PASSKEY_CONFIG.update(cfg)
    auth.PASSKEY_CONFIG["passkey"] = auth.load_env_passkey(workspace_dir)
    auth.ALLOWED_IPS.clear()
    auth.ALLOWED_IPS.update(auth.LOCALHOST_IPS)
    auth.ALLOWED_IPS.update(whitelist)

    if auth.PASSKEY_CONFIG["allow_passkey"]:
        needs_new = (
            not auth.PASSKEY_CONFIG["passkey"]
            or len(auth.PASSKEY_CONFIG["passkey"]) != auth.PASSKEY_CONFIG["passkey_digit"]
            or not auth.PASSKEY_CONFIG["passkey"].isdigit()
        )
        if needs_new:
            auth.rotate_passkey()
        print(f"[LIPSIDE] Passkey enabled. Current passkey: {auth.PASSKEY_CONFIG['passkey']}"
              f" (timeout={auth.PASSKEY_CONFIG['timeout']}s, digits={auth.PASSKEY_CONFIG['passkey_digit']})")

    if whitelist:
        host = "0.0.0.0"
        if "0.0.0.0" in whitelist:
            print("[LIPSIDE] Whitelist contains 0.0.0.0 -> ALL IPs allowed")
        else:
            print(f"[LIPSIDE] Whitelist active: {sorted(whitelist)} (+ localhost)")
    elif auth.PASSKEY_CONFIG["allow_passkey"]:
        host = "0.0.0.0"
        print("[LIPSIDE] No static IPs; passkey gating active for unknown IPs")
    else:
        host = "127.0.0.1"
        print("[LIPSIDE] Whitelist empty -> localhost only")

    if args.all_interfaces:
        host = "0.0.0.0"
    elif args.host != "127.0.0.1":
        host = args.host

    ssl_kwargs: dict = {}
    if args.no_tls:
        scheme = "http"
        print("[LIPSIDE] TLS disabled (--no-tls). Traffic is unencrypted.")
    elif args.cert or args.key:
        if not (args.cert and args.key):
            print("[LIPSIDE] ERROR: --cert and --key must be supplied together.", file=sys.stderr)
            sys.exit(1)
        cert_path = Path(args.cert).expanduser().resolve()
        key_path  = Path(args.key).expanduser().resolve()
        if not cert_path.exists():
            print(f"[LIPSIDE] ERROR: cert file not found: {cert_path}", file=sys.stderr)
            sys.exit(1)
        if not key_path.exists():
            print(f"[LIPSIDE] ERROR: key file not found: {key_path}", file=sys.stderr)
            sys.exit(1)
        ssl_kwargs = {"ssl_keyfile": str(key_path), "ssl_certfile": str(cert_path)}
        scheme = "https"
        print(f"[LIPSIDE] TLS: using provided cert {cert_path}")
        _print_cert_info(cert_path)
    else:
        cert_path, key_path = _ensure_tls_cert()
        ssl_kwargs = {"ssl_keyfile": str(key_path), "ssl_certfile": str(cert_path)}
        scheme = "https"
        _print_cert_info(cert_path)

    url = f"{scheme}://127.0.0.1:{args.port}"
    threading.Timer(1.2, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=host, port=args.port, log_level="info", **ssl_kwargs)


if __name__ == "__main__":
    main()
