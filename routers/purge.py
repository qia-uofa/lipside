"""Purge router - delete generated files from stage or pipeline repo/out dirs."""
import shutil
from pathlib import Path
from fastapi import APIRouter, HTTPException

router = APIRouter()


def _pipeline_dir(pipeline: str) -> Path:
    from .workspace import get_workspace
    return get_workspace() / pipeline


def _purge_stage(stage_dir: Path):
    """Delete all files in stage/repo/ (keep .gitignore). Leaves out/ intact."""
    repo = stage_dir / "repo"
    if repo.is_dir():
        for item in repo.iterdir():
            if item.name == ".gitignore":
                continue
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()


@router.post("/api/purge-out/{pipeline}/{stage}")
async def purge_stage_out(pipeline: str, stage: str):
    """Purge only the out/ directory of a stage."""
    stage_dir = _pipeline_dir(pipeline) / stage
    if not stage_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    out = stage_dir / "out"
    if out.is_dir():
        shutil.rmtree(out)
    return {"ok": True, "purged": f"{pipeline}/{stage}/out"}


@router.post("/api/purge/{pipeline}/{stage}")
async def purge_stage(pipeline: str, stage: str):
    """Purge a single stage: wipe repo/ contents and remove out/."""
    stage_dir = _pipeline_dir(pipeline) / stage
    if not stage_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    _purge_stage(stage_dir)
    return {"ok": True, "purged": f"{pipeline}/{stage}"}


@router.post("/api/purge/{pipeline}")
async def purge_pipeline(pipeline: str):
    """Purge every stage in a pipeline."""
    pipe_dir = _pipeline_dir(pipeline)
    if not pipe_dir.is_dir():
        raise HTTPException(404, f"Pipeline not found: {pipeline}")

    purged = []
    for entry in sorted(pipe_dir.iterdir()):
        if entry.is_dir() and not entry.name.startswith("."):
            if (entry / "repo").is_dir() or (entry / "build").is_dir():
                _purge_stage(entry)
                purged.append(entry.name)

    return {"ok": True, "purged": purged}
