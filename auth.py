"""IP whitelist, passkey, and request authentication."""
import secrets, threading, time
from pathlib import Path
from fastapi.responses import HTMLResponse

LOCALHOST_IPS = {"127.0.0.1", "::1", "localhost"}
ALLOWED_IPS: set[str] = set(LOCALHOST_IPS)

PASSKEY_CONFIG = {
    "allow_passkey": False,
    "passkey": "",
    "timeout": 3600,
    "passkey_digit": 6,
}

_WHITELIST_DEFAULTS = {
    "allow_passkey": True,
    "timeout": 3600,
    "passkey_digit": 6,
}
_DEFAULT_PASSKEY = "893264"

UNLOCKED_IPS: dict[str, float] = {}
WORKSPACE_DIR: Path | None = None
_WHITELIST_LOCK = threading.Lock()


def _parse_bool(v: str) -> bool:
    return v.strip().lower() in ("true", "1", "yes", "on")


def _workspace_env_path(workspace_dir: Path) -> Path:
    return workspace_dir / ".env"


def load_env_passkey(workspace_dir: Path) -> str:
    """Return the PASSKEY value from workspace/.env, or '' if absent."""
    path = _workspace_env_path(workspace_dir)
    if not path.exists():
        return ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("PASSKEY="):
            return line[len("PASSKEY="):].strip()
    return ""


def save_env_passkey(workspace_dir: Path, passkey: str) -> None:
    """Write/update PASSKEY=<passkey> in workspace/.env (preserves other lines)."""
    path = _workspace_env_path(workspace_dir)
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    other = [l for l in existing if not l.strip().startswith("PASSKEY=")]
    other.append(f"PASSKEY={passkey}")
    path.write_text("\n".join(other) + "\n", encoding="utf-8")


def load_whitelist(workspace_dir: Path) -> tuple[list[str], dict]:
    """Read <workspace>/whitelist.txt, creating or patching it as needed.

    Returns (ips, config). IP lines are bare addresses. Config lines look like
    key=value and recognize: allow_passkey, timeout, passkey_digit.
    The passkey itself is stored in workspace/.env as PASSKEY= (never here).

    Behaviour:
    - Missing file   → create it with _WHITELIST_DEFAULTS; seed .env PASSKEY.
    - Existing file  → parse it; add any missing default keys; migrate legacy
                       passkey= lines to .env and strip them from the file.
    """
    path = workspace_dir / "whitelist.txt"
    cfg: dict = {**PASSKEY_CONFIG}
    ips: list[str] = []

    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        cfg.update(_WHITELIST_DEFAULTS)
        write_whitelist(workspace_dir, ips, cfg)
        if not load_env_passkey(workspace_dir):
            save_env_passkey(workspace_dir, _DEFAULT_PASSKEY)
            print(f"[LIPSIDE] Created workspace .env with default PASSKEY")
        print(f"[LIPSIDE] Created {path} with defaults")
        return ips, cfg

    seen_keys: set[str] = set()
    migrated_passkey: str | None = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            seen_keys.add(key)
            if key == "allow_passkey":
                cfg["allow_passkey"] = _parse_bool(val)
            elif key == "passkey":
                migrated_passkey = val
            elif key == "timeout":
                try: cfg["timeout"] = int(val)
                except ValueError: pass
            elif key == "passkey_digit":
                try: cfg["passkey_digit"] = max(1, int(val))
                except ValueError: pass
        else:
            ips.append(line)

    if migrated_passkey is not None:
        if not load_env_passkey(workspace_dir):
            save_env_passkey(workspace_dir, migrated_passkey)
            print(f"[LIPSIDE] Migrated passkey from whitelist.txt → .env")

    needs_rewrite = migrated_passkey is not None
    for key, default in _WHITELIST_DEFAULTS.items():
        if key not in seen_keys:
            cfg[key] = default
            needs_rewrite = True
            print(f"[LIPSIDE] Added missing whitelist.txt key: {key}={default}")

    if not load_env_passkey(workspace_dir):
        save_env_passkey(workspace_dir, _DEFAULT_PASSKEY)
        print(f"[LIPSIDE] Created workspace .env with default PASSKEY")

    if needs_rewrite:
        write_whitelist(workspace_dir, ips, cfg)

    return ips, cfg


def write_whitelist(workspace_dir: Path, ips: list[str], cfg: dict) -> None:
    """Rewrite whitelist.txt with config header + IP list.

    The passkey itself is never written here; it lives in workspace/.env.
    """
    path = workspace_dir / "whitelist.txt"
    lines = [
        "# LIPSIDE whitelist",
        "# Bare lines are allowed IPs. 0.0.0.0 allows everyone.",
        "# Passkey value is stored in workspace .env as PASSKEY=",
        f"allow_passkey={'true' if cfg.get('allow_passkey') else 'false'}",
        f"timeout={int(cfg.get('timeout', 3600))}",
        f"passkey_digit={int(cfg.get('passkey_digit', 6))}",
        "",
    ]
    lines.extend(ips)
    path.write_text("\n".join(lines) + "\n")


def generate_passkey(n: int) -> str:
    n = max(1, int(n))
    return "".join(secrets.choice("0123456789") for _ in range(n))


def rotate_passkey() -> str:
    """Generate a fresh passkey, update config, and persist to workspace .env."""
    with _WHITELIST_LOCK:
        new_key = generate_passkey(PASSKEY_CONFIG.get("passkey_digit", 6))
        PASSKEY_CONFIG["passkey"] = new_key
        if WORKSPACE_DIR is not None:
            save_env_passkey(WORKSPACE_DIR, new_key)
        return new_key


def ip_currently_unlocked(ip: str) -> bool:
    expiry = UNLOCKED_IPS.get(ip)
    if not expiry:
        return False
    if expiry > time.time():
        return True
    UNLOCKED_IPS.pop(ip, None)
    return False


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


def passkey_form(error: bool = False) -> HTMLResponse:
    html = (
        PASSKEY_FORM_HTML
        .replace("__ERRDISPLAY__", "block" if error else "none")
        .replace("__TIMEOUT__", str(PASSKEY_CONFIG.get("timeout", 600)))
        .replace("__DIGITS__", str(PASSKEY_CONFIG.get("passkey_digit", 6)))
    )
    return HTMLResponse(html, status_code=401)


def extract_passkey(content_type: str, body: bytes) -> str:
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
    if "multipart/form-data" in ctype:
        import re
        m = re.search(r'name="passkey"\r?\n\r?\n([^\r\n]*)', text)
        if m:
            return m.group(1).strip()
    parsed = parse_qs(text, keep_blank_values=True)
    return (parsed.get("passkey", [""])[0] or "").strip()
