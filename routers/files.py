"""Files router – CRUD for pipeline stage files."""
import sys, shutil, subprocess, base64
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from .workspace import get_workspace, _recycle_bin_repo, _move_to_recycle

_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif'}
_IMAGE_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
}

def _extract_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        pages = []
        for i, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ''
            pages.append(f"── Page {i} ──\n{text}")
        return "\n\n".join(pages) if pages else "(no text extracted)"
    except Exception as e:
        return f"(PDF text extraction failed: {e})"

router = APIRouter()


def _stage_root(pipeline: str, stage: str, view: str) -> Path:
    ws = get_workspace()
    return ws / pipeline / stage / view


def _resolve(pipeline: str, stage: str, view: str, rel: str) -> Path:
    root = _stage_root(pipeline, stage, view)
    target = (root / rel).resolve()
    if not str(target).startswith(str(root.resolve())):
        raise HTTPException(400, "Path escapes stage directory")
    return target


# ── list files ───────────────────────────────────────────────────
@router.get("/api/files/{pipeline}/{stage}/{view}")
async def list_files(pipeline: str, stage: str, view: str, subpath: str = ""):
    root = _stage_root(pipeline, stage, view)
    if subpath:
        sub = (root / subpath).resolve()
        if not str(sub).startswith(str(root.resolve())):
            raise HTTPException(400, "Path escapes stage directory")
        root = sub
    if not root.exists():
        return {"files": []}
    items = []
    for entry in sorted(root.iterdir(), key=lambda e: (e.is_file(), e.name)):
        rel = (subpath + "/" + entry.name).lstrip("/") if subpath else entry.name
        items.append({
            "name": entry.name,
            "path": rel,
            "is_dir": entry.is_dir(),
            "size": entry.stat().st_size if entry.is_file() else 0,
        })
    return {"files": items}


# ── read file ────────────────────────────────────────────────────
@router.get("/api/file/{pipeline}/{stage}/{view}")
async def read_file(pipeline: str, stage: str, view: str, path: str):
    target = _resolve(pipeline, stage, view, path)
    if not target.exists():
        raise HTTPException(404, "File not found")
    if target.is_dir():
        raise HTTPException(400, "Target is a directory")
    ext = target.suffix.lower()
    # ── PDF ──────────────────────────────────────────────────────
    if ext == '.pdf':
        content = _extract_pdf_text(target)
        return {"path": path, "content": content, "file_type": "pdf", "readonly": True}
    # ── Image ────────────────────────────────────────────────────
    if ext in _IMAGE_EXTS:
        raw = target.read_bytes()
        b64 = base64.b64encode(raw).decode()
        mime = _IMAGE_MIME.get(ext, 'application/octet-stream')
        return {"path": path, "content": "", "file_type": "image",
                "data_url": f"data:{mime};base64,{b64}", "readonly": True}
    # ── Text ─────────────────────────────────────────────────────
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"path": path, "content": content, "file_type": "text", "readonly": False}


# ── write file ───────────────────────────────────────────────────
class FileBody(BaseModel):
    content: str = ""
    path: Optional[str] = None
    is_dir: Optional[bool] = False


@router.put("/api/file/{pipeline}/{stage}/{view}")
async def write_file(pipeline: str, stage: str, view: str, path: str, body: FileBody):
    target = _resolve(pipeline, stage, view, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"ok": True}


@router.post("/api/file/{pipeline}/{stage}/{view}")
async def create_file(pipeline: str, stage: str, view: str, body: FileBody):
    if not body.path:
        raise HTTPException(400, "path required")
    target = _resolve(pipeline, stage, view, body.path)
    if body.is_dir or body.path.endswith("/"):
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_text(body.content, encoding="utf-8")
    return {"ok": True}


@router.delete("/api/file/{pipeline}/{stage}/{view}")
async def delete_file(pipeline: str, stage: str, view: str, path: str):
    target = _resolve(pipeline, stage, view, path)
    if not target.exists():
        raise HTTPException(404, "Not found")
    pipe_dir = get_workspace() / pipeline
    rb = _recycle_bin_repo(pipe_dir)
    _move_to_recycle(target, rb)
    return {"ok": True}


# ── resolve absolute path (used by open-terminal) ───────────────
@router.get("/api/resolve-path")
async def resolve_path(pipeline: str, stage: str, view: str, path: str = ""):
    """Return the absolute filesystem path for a pipeline/stage/view[/file]."""
    root = _stage_root(pipeline, stage, view)
    target = (root / path).resolve() if path else root.resolve()
    return {"abs_path": str(target)}


# ── open terminal ───────────────────────────────────────────────
@router.post("/api/open-terminal")
async def open_terminal(body: dict):
    """Open the system default terminal at the given absolute directory."""
    target = Path(body.get("path", ""))
    if not target.exists():
        raise HTTPException(404, "Path not found")
    folder = target if target.is_dir() else target.parent
    folder = str(folder.resolve())

    try:
        if sys.platform == "win32":
            # Prefer Windows Terminal; fall back to plain cmd
            wt = shutil.which("wt")
            if wt:
                subprocess.Popen([wt, "-d", folder])
            else:
                subprocess.Popen(["cmd.exe", "/K", f"cd /d {folder}"],
                                 creationflags=subprocess.CREATE_NEW_CONSOLE)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-a", "Terminal", folder])
        else:
            # Try common Linux terminals
            for term in ("gnome-terminal", "xterm", "konsole", "xfce4-terminal"):
                if shutil.which(term):
                    subprocess.Popen([term, f"--working-directory={folder}"])
                    break
    except Exception as e:
        raise HTTPException(500, str(e))

    return {"ok": True}


@router.post("/api/open-explorer")
async def open_in_explorer(body: dict):
    """Reveal a file or directory in the system file explorer."""
    target = Path(body.get("path", ""))
    if not target.exists():
        raise HTTPException(404, "Path not found")
    target = target.resolve()

    try:
        if sys.platform == "win32":
            if target.is_dir():
                subprocess.Popen(["explorer", str(target)])
            else:
                subprocess.Popen(["explorer", "/select,", str(target)])
        elif sys.platform == "darwin":
            if target.is_dir():
                subprocess.Popen(["open", str(target)])
            else:
                subprocess.Popen(["open", "-R", str(target)])  # reveal in Finder
        else:
            # Linux: xdg-open doesn't support file selection; open parent dir
            open_path = target if target.is_dir() else target.parent
            subprocess.Popen(["xdg-open", str(open_path)])
    except Exception as e:
        raise HTTPException(500, str(e))

    return {"ok": True}


# ── rename / move ────────────────────────────────────────────────
class RenameBody(BaseModel):
    old_path: str
    new_path: str


# ── upload files ────────────────────────────────────────────────────
from fastapi import UploadFile, File
from typing import List

@router.post("/api/upload/{pipeline}/{stage}/{view}")
async def upload_files(pipeline: str, stage: str, view: str,
                       files: List[UploadFile] = File(...),
                       subpath: str = ""):
    root = _stage_root(pipeline, stage, view)
    saved = []
    for f in files:
        rel = (subpath + "/" + f.filename).lstrip("/") if subpath else f.filename
        target = (root / rel).resolve()
        if not str(target).startswith(str(root.resolve())):
            raise HTTPException(400, f"Path escapes stage directory: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(await f.read())
        saved.append(rel)
    return {"ok": True, "saved": saved}


@router.post("/api/rename/{pipeline}/{stage}/{view}")
async def rename_file(pipeline: str, stage: str, view: str, body: RenameBody):
    src = _resolve(pipeline, stage, view, body.old_path)
    dst = _resolve(pipeline, stage, view, body.new_path)
    if not src.exists():
        raise HTTPException(404, "Source not found")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return {"ok": True}
