"""Purge router - move generated files to Recycle-Bin instead of deleting."""
import shutil
from pathlib import Path
from fastapi import APIRouter, HTTPException

router = APIRouter()


def _pipeline_dir(pipeline: str) -> Path:
    from .workspace import get_workspace
    return get_workspace() / pipeline


def _purge_stage(stage_dir: Path):
    """Move all files in stage/repo/ (except .gitignore) to pipeline/Recycle-Bin/repo/."""
    from .workspace import _recycle_bin_repo, _move_to_recycle
    repo = stage_dir / "repo"
    if not repo.is_dir():
        return
    pipe_dir = stage_dir.parent
    rb = _recycle_bin_repo(pipe_dir)
    for item in repo.iterdir():
        if item.name == ".gitignore":
            continue
        _move_to_recycle(item, rb)


@router.post("/api/purge-out/{pipeline}/{stage}")
async def purge_stage_out(pipeline: str, stage: str):
    """Move stage/out/ into pipeline/Recycle-Bin/repo/ (renamed to <stage>__out)."""
    from .workspace import _recycle_bin_repo, _move_to_recycle
    stage_dir = _pipeline_dir(pipeline) / stage
    if not stage_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    out = stage_dir / "out"
    if out.is_dir():
        rb = _recycle_bin_repo(_pipeline_dir(pipeline))
        # Rename to <stage>__out so multiple stages don't collide in the bin.
        dest = rb / f"{stage}__out"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(out), str(dest))
    return {"ok": True, "purged": f"{pipeline}/{stage}/out"}


@router.post("/api/purge/{pipeline}/{stage}")
async def purge_stage(pipeline: str, stage: str):
    """Move a stage's repo/ contents (except .gitignore) to pipeline/Recycle-Bin/repo/."""
    stage_dir = _pipeline_dir(pipeline) / stage
    if not stage_dir.is_dir():
        raise HTTPException(404, f"Stage not found: {pipeline}/{stage}")
    _purge_stage(stage_dir)
    return {"ok": True, "purged": f"{pipeline}/{stage}"}


@router.post("/api/purge/{pipeline}")
async def purge_pipeline(pipeline: str):
    """Move every stage's repo/ contents in a pipeline to pipeline/Recycle-Bin/repo/."""
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
