"""LIPSIDE - FastAPI entry point."""
import argparse, sys, uvicorn, webbrowser, threading, time, secrets, ipaddress
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response, JSONResponse, HTMLResponse, RedirectResponse
from pathlib import Path

from lipside.routers import workspace, files, build, create, config, purge, terminal

BASE = Path(__file__).parent
LOCALHOST_IPS = {"127.0.0.1", "::1", "localhost"}


# ── TLS ───────────────────────────────────────────────────────────────────────

def _collect_san_entries() -> tuple[set[str], set]:
    """Return (dns_names, ip_addresses) covering loopback + this machine."""
    import socket
    dns_names: set[str] = {"localhost"}
    ip_addrs: set = {
        ipaddress.IPv4Address("127.0.0.1"),
        ipaddress.IPv6Address("::1"),
    }
    # Machine hostname
    try:
        hostname = socket.gethostname()
        if hostname:
            dns_names.add(hostname)
            try:
                ip_addrs.add(ipaddress.ip_address(socket.gethostbyname(hostname)))
            except Exception:
                pass
    except Exception:
        pass
    # Primary outbound IP (no packets sent; just picks the right interface)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip_addrs.add(ipaddress.ip_address(s.getsockname()[0]))
    except Exception:
        pass
    return dns_names, ip_addrs


def _cert_fingerprint(cert_pem: bytes) -> str:
    """Return a human-readable SHA-256 fingerprint of a PEM certificate."""
    import hashlib
    from cryptography import x509 as _x509
    from cryptography.hazmat.primitives.serialization import Encoding
    der = _x509.load_pem_x509_certificate(cert_pem).public_bytes(Encoding.DER)
    h = hashlib.sha256(der).hexdigest().upper()
    return ":".join(h[i:i+2] for i in range(0, len(h), 2))


def _print_cert_info(cert_path: Path) -> None:
    """Print fingerprint and SAN entries for the active certificate."""
    from cryptography import x509 as _x509
    try:
        pem = cert_path.read_bytes()
        fp = _cert_fingerprint(pem)
        cert = _x509.load_pem_x509_certificate(pem)
        try:
            san = cert.extensions.get_extension_for_class(_x509.SubjectAlternativeName)
            dns  = san.value.get_values_for_type(_x509.DNSName)
            ips  = [str(a) for a in san.value.get_values_for_type(_x509.IPAddress)]
            print(f"[LIPSIDE] TLS cert SANs: DNS={dns} IPs={ips}")
        except Exception:
            pass
        print(f"[LIPSIDE] TLS cert SHA-256 fingerprint:")
        print(f"[LIPSIDE]   {fp}")
        print(f"[LIPSIDE] Verify this fingerprint in your browser's cert viewer to confirm")
        print(f"[LIPSIDE] the connection is not being intercepted.")
    except Exception:
        pass


def _ensure_tls_cert() -> tuple[Path, Path]:
    """Return (cert_path, key_path), generating a self-signed cert if missing.

    The cert lives in ~/.lipside/ and is reused across all workspaces.  It
    includes the machine's hostname and primary outbound IP in the SAN so
    remote browsers don't hit a hostname-mismatch error.

    The cert is valid for 10 years.  To force regeneration (e.g. after the
    machine's IP changes), delete ~/.lipside/lipside.crt and lipside.key and
    restart LIPSIDE, or use --cert / --key to supply your own certificate.
    """
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime

    tls_dir = Path.home() / ".lipside"
    tls_dir.mkdir(parents=True, exist_ok=True)
    cert_path = tls_dir / "lipside.crt"
    key_path  = tls_dir / "lipside.key"

    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    print("[LIPSIDE] Generating self-signed TLS certificate …")

    dns_names, ip_addrs = _collect_san_entries()

    # 2048-bit RSA key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)

    san_entries: list = [x509.DNSName(n) for n in sorted(dns_names)]
    for addr in sorted(ip_addrs, key=str):
        san_entries.append(x509.IPAddress(addr))

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "LIPSIDE"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "LIPSIDE"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=3650)
        )
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"[LIPSIDE] Certificate written to {cert_path}")
    print(f"[LIPSIDE] SANs: DNS={sorted(dns_names)}  IPs={sorted(ip_addrs, key=str)}")
    print(f"[LIPSIDE] To permanently dismiss the browser warning, import {cert_path}")
    print(f"[LIPSIDE] into your OS/browser CA trust store.")
    print(f"[LIPSIDE] To regenerate (e.g. after an IP change): delete {cert_path}")
    return cert_path, key_path


ALLOWED_IPS: set[str] = set(LOCALHOST_IPS)

# Passkey config (read from whitelist.txt at startup).
PASSKEY_CONFIG = {
    "allow_passkey": False,
    "passkey": "",
    "timeout": 600,        # seconds
    "passkey_digit": 6,    # length of the generated numeric passkey
}
# IP -> epoch seconds when its temporary unlock expires
UNLOCKED_IPS: dict[str, float] = {}
WORKSPACE_DIR: Path | None = None
_WHITELIST_LOCK = threading.Lock()


def _parse_bool(v: str) -> bool:
    return v.strip().lower() in ("true", "1", "yes", "on")


def load_whitelist(workspace_dir: Path) -> tuple[list[str], dict]:
    """Read <workspace>/whitelist.txt; create it with one empty line if missing.

    Returns (ips, config). IP lines are bare addresses. Config lines look like
    key=value and recognize: allow_passkey, passkey, timeout, passkey_digit.
    Comments (#...) and blank lines are ignored.
    """
    path = workspace_dir / "whitelist.txt"
    cfg = dict(PASSKEY_CONFIG)  # start from defaults
    ips: list[str] = []
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n")
        print(f"[LIPSIDE] Created {path} (empty -> localhost only)")
        return ips, cfg
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if key == "allow_passkey":
                cfg["allow_passkey"] = _parse_bool(val)
            elif key == "passkey":
                cfg["passkey"] = val
            elif key == "timeout":
                try: cfg["timeout"] = int(val)
                except ValueError: pass
            elif key == "passkey_digit":
                try: cfg["passkey_digit"] = max(1, int(val))
                except ValueError: pass
            # unknown keys silently ignored
        else:
            ips.append(line)
    return ips, cfg


def write_whitelist(workspace_dir: Path, ips: list[str], cfg: dict) -> None:
    """Rewrite whitelist.txt with config header + IP list."""
    path = workspace_dir / "whitelist.txt"
    lines = [
        "# LIPSIDE whitelist",
        "# Bare lines are allowed IPs. 0.0.0.0 allows everyone.",
        f"allow_passkey={'true' if cfg.get('allow_passkey') else 'false'}",
        f"passkey={cfg.get('passkey', '')}",
        f"timeout={int(cfg.get('timeout', 600))}",
        f"passkey_digit={int(cfg.get('passkey_digit', 6))}",
        "",
    ]
    lines.extend(ips)
    path.write_text("\n".join(lines) + "\n")


def generate_passkey(n: int) -> str:
    n = max(1, int(n))
    return "".join(secrets.choice("0123456789") for _ in range(n))


def rotate_passkey() -> str:
    """Generate a fresh passkey, update config, and persist to disk."""
    with _WHITELIST_LOCK:
        new_key = generate_passkey(PASSKEY_CONFIG.get("passkey_digit", 6))
        PASSKEY_CONFIG["passkey"] = new_key
        if WORKSPACE_DIR is not None:
            ips, _existing_cfg = load_whitelist(WORKSPACE_DIR)
            write_whitelist(WORKSPACE_DIR, ips, PASSKEY_CONFIG)
        return new_key


PASSKEY_FORM_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>LIPSIDE - Enter passkey</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0e1117;color:#e6edf3;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:#161b22;padding:32px 36px;border-radius:12px;border:1px solid #30363d;
        box-shadow:0 8px 24px rgba(0,0,0,.4);min-width:300px}
  h1{margin:0 0 16px;font-size:18px;font-weight:600}
  p{margin:0 0 18px;color:#8b949e;font-size:13px;line-height:1.4}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:6px;
        border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:16px;
        letter-spacing:.15em;text-align:center;font-family:ui-monospace,monospace}
  button{margin-top:12px;width:100%;padding:10px;border-radius:6px;border:0;
         background:#238636;color:#fff;font-size:14px;cursor:pointer}
  button:hover{background:#2ea043}
  .err{color:#f85149;margin:0 0 12px;font-size:13px;display:__ERRDISPLAY__}
</style></head>
<body><div class="card">
  <h1>Enter passkey</h1>
  <p class="err">Incorrect passkey.</p>
  <p>This IP isn't whitelisted. Enter the current passkey to unlock for __TIMEOUT__ seconds.</p>
  <form method="POST" action="/unlock">
    <input name="passkey" type="text" inputmode="numeric" autocomplete="off"
           pattern="[0-9]*" maxlength="__DIGITS__" autofocus required />
    <button type="submit">Unlock</button>
  </form>
</div></body></html>"""


def _passkey_form(error: bool = False) -> HTMLResponse:
    html = (
        PASSKEY_FORM_HTML
        .replace("__ERRDISPLAY__", "block" if error else "none")
        .replace("__TIMEOUT__", str(PASSKEY_CONFIG.get("timeout", 600)))
        .replace("__DIGITS__", str(PASSKEY_CONFIG.get("passkey_digit", 6)))
    )
    return HTMLResponse(html, status_code=401)


_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

def _serve_no_cache(filepath: Path, media_type: str) -> Response:
    return Response(filepath.read_bytes(), media_type=media_type, headers=_NO_CACHE)

app = FastAPI(title="LIPSIDE")


def _ip_currently_unlocked(ip: str) -> bool:
    expiry = UNLOCKED_IPS.get(ip)
    if not expiry:
        return False
    if expiry > time.time():
        return True
    UNLOCKED_IPS.pop(ip, None)
    return False


@app.middleware("http")
async def ip_whitelist_middleware(request: Request, call_next):
    # "0.0.0.0" in the whitelist means allow everyone.
    if "0.0.0.0" in ALLOWED_IPS:
        return await call_next(request)

    client_ip = request.client.host if request.client else None

    # Static allow-list hit.
    if client_ip in ALLOWED_IPS:
        return await call_next(request)

    # Temporarily unlocked via passkey.
    if client_ip and _ip_currently_unlocked(client_ip):
        return await call_next(request)

    # Let the unlock endpoint through so the form can submit.
    if request.url.path == "/unlock":
        return await call_next(request)

    # Offer passkey entry if enabled; otherwise hard 403.
    if PASSKEY_CONFIG.get("allow_passkey"):
        return _passkey_form(error=False)
    return JSONResponse(
        {"detail": f"Forbidden: {client_ip} not in whitelist"},
        status_code=403,
    )


def _extract_passkey(content_type: str, body: bytes) -> str:
    """Pull the 'passkey' field out of a request body without needing python-multipart."""
    from urllib.parse import parse_qs
    import json as _json
    text = body.decode("utf-8", errors="replace")
    ctype = (content_type or "").lower()
    if "application/x-www-form-urlencoded" in ctype:
        parsed = parse_qs(text, keep_blank_values=True)
        return (parsed.get("passkey", [""])[0] or "").strip()
    if "application/json" in ctype:
        try:
            data = _json.loads(text or "{}")
            return str(data.get("passkey", "")).strip()
        except Exception:
            return ""
    # multipart/form-data: scrape the field naively rather than pulling in a parser dep.
    if "multipart/form-data" in ctype:
        import re
        m = re.search(r'name="passkey"\r?\n\r?\n([^\r\n]*)', text)
        if m:
            return m.group(1).strip()
    # Last resort: treat as urlencoded.
    parsed = parse_qs(text, keep_blank_values=True)
    return (parsed.get("passkey", [""])[0] or "").strip()


@app.post("/unlock")
async def unlock(request: Request):
    client_ip = request.client.host if request.client else None
    if not PASSKEY_CONFIG.get("allow_passkey"):
        return JSONResponse({"detail": "Passkey disabled"}, status_code=403)
    body = await request.body()
    submitted = _extract_passkey(request.headers.get("content-type", ""), body)
    current = PASSKEY_CONFIG.get("passkey", "")
    if not current or submitted != current:
        print(
            f"[LIPSIDE] Rejected unlock from {client_ip}: "
            f"got={submitted!r} (len={len(submitted)}), expected len={len(current)}"
        )
        return _passkey_form(error=True)

    # Success: unlock this IP for the timeout window, then rotate the passkey.
    timeout = int(PASSKEY_CONFIG.get("timeout", 600))
    UNLOCKED_IPS[client_ip] = time.time() + timeout
    new_key = rotate_passkey()
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
    return Response(content, media_type="text/html", headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })


def main():
    global WORKSPACE_DIR
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
    WORKSPACE_DIR = workspace_dir
    workspace.set_workspace(str(workspace_dir))
    active = workspace.get_active_pipeline()
    if active:
        print(f"[LIPSIDE] PIPELINE={active}")

    # Load whitelist + passkey config from the workspace.
    whitelist, cfg = load_whitelist(workspace_dir)
    PASSKEY_CONFIG.update(cfg)
    ALLOWED_IPS.clear()
    ALLOWED_IPS.update(LOCALHOST_IPS)
    ALLOWED_IPS.update(whitelist)

    # If passkey is enabled but the file has no key (or wrong length), mint one and persist.
    if PASSKEY_CONFIG["allow_passkey"]:
        needs_new = (
            not PASSKEY_CONFIG["passkey"]
            or len(PASSKEY_CONFIG["passkey"]) != PASSKEY_CONFIG["passkey_digit"]
            or not PASSKEY_CONFIG["passkey"].isdigit()
        )
        if needs_new:
            rotate_passkey()
        print(f"[LIPSIDE] Passkey enabled. Current passkey: {PASSKEY_CONFIG['passkey']}"
              f" (timeout={PASSKEY_CONFIG['timeout']}s, digits={PASSKEY_CONFIG['passkey_digit']})")

    if whitelist:
        host = "0.0.0.0"
        if "0.0.0.0" in whitelist:
            print("[LIPSIDE] Whitelist contains 0.0.0.0 -> ALL IPs allowed")
        else:
            print(f"[LIPSIDE] Whitelist active: {sorted(whitelist)} (+ localhost)")
    elif PASSKEY_CONFIG["allow_passkey"]:
        # No static IPs but passkey is on -> still need to listen on all interfaces.
        host = "0.0.0.0"
        print("[LIPSIDE] No static IPs; passkey gating active for unknown IPs")
    else:
        host = "127.0.0.1"
        print("[LIPSIDE] Whitelist empty -> localhost only")

    # CLI flags can still force a different bind; middleware enforces access either way.
    if args.all_interfaces:
        host = "0.0.0.0"
    elif args.host != "127.0.0.1":
        host = args.host

    # ── TLS setup ──────────────────────────────────────────────────────
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
        ssl_kwargs = {
            "ssl_keyfile":  str(key_path),
            "ssl_certfile": str(cert_path),
        }
        scheme = "https"
        _print_cert_info(cert_path)

    url = f"{scheme}://127.0.0.1:{args.port}"
    threading.Timer(1.2, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=host, port=args.port, log_level="info", **ssl_kwargs)


if __name__ == "__main__":
    main()
