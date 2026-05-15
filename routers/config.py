"""Config router - read/write editable fields of a pipeline's config.json and .env."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Any

router = APIRouter()


def _pipeline_dir(pipeline: str) -> Path:
    from .workspace import get_workspace
    return get_workspace() / pipeline


def _config_path(pipeline: str) -> Path:
    return _pipeline_dir(pipeline) / "config.json"


def _read_config(pipeline: str) -> dict:
    p = _config_path(pipeline)
    if not p.exists():
        raise HTTPException(404, "config.json not found for this pipeline")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"config.json is not valid JSON: {e}")


def _write_config(pipeline: str, config: dict):
    _config_path(pipeline).write_text(json.dumps(config, indent=2), encoding="utf-8")


# -- generate fields ----------------------------------------------------------

@router.get("/api/config/{pipeline}")
async def get_config(pipeline: str):
    """Return the editable generate-fields from config.json."""
    config    = _read_config(pipeline)
    generate  = config.get("generate", {})
    raw_model = generate.get("model", "")
    # Parse "prefix/model_name" litellm format into separate provider + model
    provider_id, bare_model = "", raw_model
    if "/" in raw_model:
        from .create import PROVIDERS
        prefix, bare_model = raw_model.split("/", 1)
        prov = next((p for p in PROVIDERS if p["prefix"] == prefix), None)
        provider_id = prov["id"] if prov else prefix
    return {
        "provider":    provider_id,
        "model":       bare_model,
        "max_tokens":  generate.get("max_tokens",  20000),
        "temperature": generate.get("temperature", 0.0),
        "timeout":     generate.get("timeout",     1200),
        "api_var":     config.get("api_var",       ""),
    }


class ConfigBody(BaseModel):
    provider:    Optional[str]   = None
    model:       Optional[str]   = None
    max_tokens:  Optional[int]   = None
    temperature: Optional[float] = None
    timeout:     Optional[int]   = None
    api_var:     Optional[str]   = None


@router.put("/api/config/{pipeline}")
async def put_config(pipeline: str, body: ConfigBody):
    """Merge editable fields into config.json, preserving the messages array."""
    config = _read_config(pipeline)
    if "generate" not in config or not isinstance(config["generate"], dict):
        config["generate"] = {}
    if body.model is not None:
        if body.provider:
            from .create import _litellm_model
            config["generate"]["model"] = _litellm_model(body.provider, body.model)
        else:
            config["generate"]["model"] = body.model
    if body.max_tokens  is not None: config["generate"]["max_tokens"]  = body.max_tokens
    if body.temperature is not None: config["generate"]["temperature"] = body.temperature
    if body.timeout     is not None: config["generate"]["timeout"]     = body.timeout
    if body.api_var     is not None: config["api_var"]                 = body.api_var
    _write_config(pipeline, config)
    return {"ok": True}


# -- messages array -----------------------------------------------------------

@router.get("/api/config/{pipeline}/messages")
async def get_messages(pipeline: str):
    """Return the messages conversation template as a JSON array."""
    config = _read_config(pipeline)
    return {"messages": config.get("messages", [])}


class MessagesBody(BaseModel):
    messages: List[Any]


@router.put("/api/config/{pipeline}/messages")
async def put_messages(pipeline: str, body: MessagesBody):
    """Replace the messages array in config.json."""
    config = _read_config(pipeline)
    config["messages"] = body.messages
    _write_config(pipeline, config)
    return {"ok": True}


# -- .env file ----------------------------------------------------------------

@router.get("/api/env/{pipeline}")
async def get_env(pipeline: str):
    """Return the raw text contents of the pipeline's .env file."""
    env_path = _pipeline_dir(pipeline) / ".env"
    if not env_path.exists():
        return {"content": "", "exists": False}
    return {"content": env_path.read_text(encoding="utf-8"), "exists": True}


class EnvBody(BaseModel):
    content: str = ""


@router.put("/api/env/{pipeline}")
async def put_env(pipeline: str, body: EnvBody):
    """Write (or create) the pipeline's .env file."""
    env_path = _pipeline_dir(pipeline) / ".env"
    env_path.write_text(body.content, encoding="utf-8")
    return {"ok": True}
