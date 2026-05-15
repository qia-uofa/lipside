"""Workspace router - pipelines, workspace-level .env, graph config."""
import re, shutil
import send2trash
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
_workspace: Path = Path(".").resolve()


def set_workspace(path: str):
    global _workspace
    _workspace = Path(path).resolve()


def get_workspace() -> Path:
    return _workspace


def _scan_pipelines(ws: Path) -> list:
    pipelines = []
    if not ws.is_dir():
        return pipelines
    for entry in sorted(ws.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        stages = sorted(
            s.name for s in entry.iterdir()
            if s.is_dir() and not s.name.startswith(".")
        )
        pipelines.append({"name": entry.name, "stages": stages})
    return pipelines


# -- Workspace-level .env helpers ---------------------------------------------

def _env_path() -> Path:
    return get_workspace() / ".env"


def _get_env_value(content: str, key: str) -> str:
    """Return the value of a specific key from dotenv content, or empty string."""
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
        if m and m.group(1) == key:
            return m.group(2).strip().strip('"').strip("'")
    return ""


def _upsert_env_key(content: str, key: str, value: str) -> str:
    """Set key=value in dotenv content, adding or replacing the line."""
    new_line = key + "=" + value
    pattern = re.compile(r'^' + re.escape(key) + r'\s*=.*$', re.MULTILINE)
    if pattern.search(content):
        return pattern.sub(new_line, content)
    if content and not content.endswith("\n"):
        content += "\n"
    return content + new_line + "\n"


def _parse_env_keys(content: str) -> list:
    """Return list of KEY names from dotenv content."""
    keys = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
        if m:
            keys.append(m.group(1))
    return keys


# -- Active pipeline ----------------------------------------------------------

def get_active_pipeline() -> str:
    """Read PIPELINE from the workspace .env and return it (or empty string)."""
    p = _env_path()
    if not p.exists():
        return ""
    return _get_env_value(p.read_text(encoding="utf-8"), "PIPELINE")


# -- Workspace info -----------------------------------------------------------

@router.get("/api/workspace")
async def get_workspace_info():
    ws = get_workspace()
    return {
        "workspace": str(ws),
        "pipelines": _scan_pipelines(ws),
        "active_pipeline": get_active_pipeline(),
    }


class WorkspacePath(BaseModel):
    path: str


@router.post("/api/workspace/path")
async def change_workspace(body: WorkspacePath):
    p = Path(body.path).expanduser().resolve()
    if not p.is_dir():
        raise HTTPException(400, f"Not a directory: {p}")
    set_workspace(str(p))
    return {"workspace": str(p), "pipelines": _scan_pipelines(p)}


@router.get("/api/workspace/pick")
async def pick_workspace():
    """Open a native OS folder-picker dialog and return the chosen path."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(title="Select Workspace Folder")
        root.destroy()
        if not chosen:
            return {"cancelled": True, "path": ""}
        p = Path(chosen).resolve()
        set_workspace(str(p))
        ws = get_workspace()
        return {"cancelled": False, "workspace": str(p), "pipelines": _scan_pipelines(ws)}
    except Exception as e:
        raise HTTPException(500, f"Could not open folder picker: {e}")


# -- Workspace-level .env endpoints -------------------------------------------

@router.get("/api/env/workspace")
async def get_workspace_env():
    p = _env_path()
    if not p.exists():
        return {"content": "", "exists": False, "keys": []}
    content = p.read_text(encoding="utf-8")
    return {"content": content, "exists": True, "keys": _parse_env_keys(content)}


class EnvBody(BaseModel):
    content: str = ""


@router.put("/api/env/workspace")
async def put_workspace_env(body: EnvBody):
    _env_path().write_text(body.content, encoding="utf-8")
    return {"ok": True, "keys": _parse_env_keys(body.content)}


@router.get("/api/env/workspace/keys")
async def get_workspace_env_keys():
    p = _env_path()
    if not p.exists():
        return {"keys": []}
    content = p.read_text(encoding="utf-8")
    return {"keys": _parse_env_keys(content)}


# -- Set active pipeline ------------------------------------------------------

class SetPipelineBody(BaseModel):
    pipeline: str


@router.post("/api/workspace/set-pipeline")
async def set_active_pipeline(body: SetPipelineBody):
    """Write PIPELINE=name into the workspace .env."""
    p = _env_path()
    content = p.read_text(encoding="utf-8") if p.exists() else ""
    content = _upsert_env_key(content, "PIPELINE", body.pipeline)
    p.write_text(content, encoding="utf-8")
    return {"ok": True, "pipeline": body.pipeline}


# -- Rename stage -------------------------------------------------------------

class RenameStageBody(BaseModel):
    new_name: str


@router.post("/api/rename-stage/{pipeline}/{stage}")
async def rename_stage(pipeline: str, stage: str, body: RenameStageBody):
    """Rename a stage directory and update TARGET= references in sibling stages."""
    ws = get_workspace()
    old_dir = ws / pipeline / stage
    new_name = body.new_name.strip()
    new_dir  = ws / pipeline / new_name

    if not old_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    if not new_name or new_name == stage:
        raise HTTPException(400, "new_name must differ from current name")
    if new_dir.exists():
        raise HTTPException(400, f"A stage named '{new_name}' already exists")

    # Pattern matches a bare `TARGET=oldname` line (inside or outside code fences)
    pattern = re.compile(r'(?m)^(TARGET\s*=\s*)' + re.escape(stage) + r'[ \t]*$')

    updated = []
    pipe_dir = ws / pipeline
    for entry in sorted(pipe_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith('.') or entry.name == stage:
            continue
        # Check per-stage .env (if any)
        for candidate in [entry / '.env', entry / 'repo' / '.env']:
            if candidate.exists():
                try:
                    content = candidate.read_text(encoding='utf-8')
                    new_content = pattern.sub(lambda m: m.group(1) + new_name, content)
                    if new_content != content:
                        candidate.write_text(new_content, encoding='utf-8')
                        updated.append(str(candidate.relative_to(ws)))
                except Exception:
                    pass
        # Check build files
        build_dir = entry / 'build'
        if build_dir.is_dir():
            for f in sorted(build_dir.rglob('*')):
                if not f.is_file():
                    continue
                if f.suffix.lower() not in {'.md', '.py', '.sh', '.txt', ''}:
                    continue
                try:
                    content = f.read_text(encoding='utf-8')
                    new_content = pattern.sub(lambda m: m.group(1) + new_name, content)
                    if new_content != content:
                        f.write_text(new_content, encoding='utf-8')
                        updated.append(str(f.relative_to(ws)))
                except Exception:
                    pass

    # Rename the directory last
    old_dir.rename(new_dir)
    return {"ok": True, "old_name": stage, "new_name": new_name, "updated_files": updated}


# -- Delete endpoints ---------------------------------------------------------

@router.delete("/api/stage/{pipeline}/{stage}")
async def delete_stage(pipeline: str, stage: str):
    """Move a stage directory to the recycle bin."""
    ws = get_workspace()
    stage_dir = ws / pipeline / stage
    if not stage_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    send2trash.send2trash(str(stage_dir))
    return {"ok": True, "deleted": f"{pipeline}/{stage}"}


@router.delete("/api/pipeline/{pipeline}")
async def delete_pipeline(pipeline: str):
    """Move an entire pipeline directory to the recycle bin."""
    ws = get_workspace()
    pipe_dir = ws / pipeline
    if not pipe_dir.is_dir():
        raise HTTPException(404, f"Pipeline not found: {pipeline}")
    send2trash.send2trash(str(pipe_dir))
    return {"ok": True, "deleted": pipeline}
