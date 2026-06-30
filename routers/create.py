"""Create router - pipeline scaffolding and stage management."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

router = APIRouter()

PROVIDERS = [
    # ── Tier-1 hosted ────────────────────────────────────────────────────────
    {"id": "anthropic", "name": "Anthropic", "prefix": "anthropic",
     "models": [
         "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
         "claude-opus-4", "claude-sonnet-4",
         "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
         "claude-3-opus-20240229",
     ]},
    {
        "id": "openai",
        "name": "OpenAI",
        "prefix": "openai",
        "models": [
            # GPT-5 family
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5",
            "gpt-5-mini",
            "gpt-5-nano",
            "gpt-5-pro",

            # o-series reasoning models
            "o4",
            "o4-mini",
            "o4-mini-high",
            "o3",
            "o3-pro",
            "o3-mini",
            "o1",
            "o1-pro",
            "o1-mini",

            # GPT-4.x family
            "gpt-4.5",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4-turbo",
            "gpt-4",

            # GPT-3.5 family
            "gpt-3.5-turbo",

            # Specialized / multimodal
            "gpt-image-1",
            "gpt-realtime",
            "gpt-realtime-mini",
            "gpt-audio",
            "gpt-audio-mini",

            # Open-weight models
            "gpt-oss-120b",
            "gpt-oss-20b"
        ]
    },
    {"id": "google", "name": "Google AI Studio (Gemini)", "prefix": "gemini",
     "models": [
         "gemini-2.5-pro", "gemini-2.5-flash",
         "gemini-2.0-flash", "gemini-2.0-flash-lite",
         "gemini-1.5-pro", "gemini-1.5-flash",
     ]},
    {"id": "vertex_ai", "name": "Google Vertex AI", "prefix": "vertex_ai",
     "models": [
         "gemini-2.5-pro", "gemini-2.5-flash",
         "gemini-1.5-pro", "gemini-1.5-flash",
         "claude-sonnet-4@20250514", "claude-opus-4@20250514",
         "meta/llama-3.1-405b-instruct-maas",
     ]},
    {"id": "xai", "name": "xAI (Grok)", "prefix": "xai",
     "models": ["grok-3", "grok-3-mini", "grok-3-fast", "grok-2", "grok-beta"]},
    {"id": "mistral", "name": "Mistral AI", "prefix": "mistral",
     "models": [
         "mistral-large-latest", "mistral-medium-latest", "mistral-small-latest",
         "codestral-latest", "mistral-nemo", "open-mixtral-8x22b",
     ]},
    {"id": "cohere", "name": "Cohere", "prefix": "cohere",
     "models": [
         "command-a-03-2025", "command-r-plus-08-2024", "command-r-08-2024",
         "command-r-plus", "command-r",
     ]},
    {"id": "deepseek", "name": "DeepSeek", "prefix": "deepseek",
     "models": [
        "deepseek-chat", 
        "deepseek-reasoner", 
        "deepseek-coder",
        "deepseek-v4-pro",
        "deepseek-v4-flash"
        ]},
    {"id": "perplexity", "name": "Perplexity AI", "prefix": "perplexity",
     "models": [
         "sonar-pro", "sonar", "sonar-reasoning-pro", "sonar-reasoning",
         "sonar-deep-research",
     ]},

    # ── Cloud infrastructure ──────────────────────────────────────────────────
    {"id": "azure", "name": "Azure OpenAI", "prefix": "azure",
     "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "o1", "o3-mini"]},
    {"id": "azure_ai", "name": "Azure AI (Serverless)", "prefix": "azure_ai",
     "models": [
         "Meta-Llama-3.3-70B-Instruct", "Phi-4", "Phi-3.5-MoE-instruct",
         "mistral-large-2407", "Cohere-command-r-plus-08-2024",
         "DeepSeek-R1", "jais-30b-chat",
     ]},
    {"id": "bedrock", "name": "AWS Bedrock", "prefix": "bedrock",
     "models": [
         "anthropic.claude-3-5-sonnet-20241022-v2:0",
         "anthropic.claude-3-opus-20240229-v1:0",
         "amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0",
         "meta.llama3-70b-instruct-v1:0",
         "mistral.mistral-large-2402-v1:0",
         "amazon.titan-text-premier-v1:0",
     ]},
    {"id": "sagemaker", "name": "AWS SageMaker", "prefix": "sagemaker",
     "models": [
         "huggingface-llm-mistral-7b-instruct",
         "meta-textgeneration-llama-3-70b-instruct",
         "jumpstart-dft-hf-llm-falcon-7b-instruct",
     ]},
    {"id": "oci", "name": "Oracle Cloud (OCI)", "prefix": "oci",
     "models": [
         "cohere.command-r-plus", "cohere.command-r-16k",
         "meta.llama-3.1-70b-instruct", "meta.llama-3.3-70b-instruct",
     ]},
    {"id": "watsonx", "name": "IBM WatsonX", "prefix": "watsonx",
     "models": [
         "ibm/granite-3-8b-instruct", "ibm/granite-3-2b-instruct",
         "meta-llama/llama-3-3-70b-instruct",
         "mistralai/mistral-large",
     ]},

    # ── Fast inference / GPU clouds ───────────────────────────────────────────
    {"id": "groq", "name": "Groq", "prefix": "groq",
     "models": [
         "llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "llama-3.1-8b-instant",
         "deepseek-r1-distill-llama-70b", "gemma2-9b-it", "mixtral-8x7b-32768",
         "qwen-qwq-32b",
     ]},
    {"id": "cerebras", "name": "Cerebras", "prefix": "cerebras",
     "models": [
         "llama3.1-8b", "llama3.1-70b", "llama-4-scout-17b-16e-instruct",
         "qwen-3-32b",
     ]},
    {"id": "sambanova", "name": "SambaNova", "prefix": "sambanova",
     "models": [
         "Meta-Llama-3.3-70B-Instruct", "Meta-Llama-3.1-405B-Instruct",
         "DeepSeek-R1-Distill-Llama-70B", "Qwen2.5-72B-Instruct",
         "QwQ-32B",
     ]},
    {"id": "fireworks_ai", "name": "Fireworks AI", "prefix": "fireworks_ai",
     "models": [
         "accounts/fireworks/models/llama-v3p3-70b-instruct",
         "accounts/fireworks/models/deepseek-r1",
         "accounts/fireworks/models/qwen3-30b-a3b",
         "accounts/fireworks/models/mixtral-8x22b-instruct",
         "accounts/fireworks/models/firefunction-v2",
     ]},
    {"id": "together_ai", "name": "Together AI", "prefix": "together_ai",
     "models": [
         "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
         "meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo",
         "deepseek-ai/DeepSeek-R1",
         "Qwen/Qwen2.5-72B-Instruct-Turbo",
         "mistralai/Mixtral-8x7B-Instruct-v0.1",
     ]},
    {"id": "deepinfra", "name": "DeepInfra", "prefix": "deepinfra",
     "models": [
         "meta-llama/Meta-Llama-3.1-70B-Instruct",
         "meta-llama/Llama-3.3-70B-Instruct-Turbo",
         "deepseek-ai/DeepSeek-R1",
         "Qwen/Qwen2.5-72B-Instruct",
         "mistralai/Mixtral-8x22B-Instruct-v0.1",
         "google/gemma-2-27b-it",
     ]},
    {"id": "hyperbolic", "name": "Hyperbolic", "prefix": "hyperbolic",
     "models": [
         "meta-llama/Meta-Llama-3.1-405B-Instruct",
         "meta-llama/Llama-3.3-70B-Instruct",
         "deepseek-ai/DeepSeek-R1",
         "Qwen/Qwen2.5-72B-Instruct",
         "NovaSky-AI/Sky-T1-32B-Preview",
     ]},
    {"id": "lambda_ai", "name": "Lambda AI", "prefix": "lambda",
     "models": [
         "llama3.1-405b-instruct-fp8", "llama3.1-70b-instruct-fp8",
         "llama3.3-70b-instruct-fp8", "deepseek-r1-671b",
         "hermes3-405b",
     ]},
    {"id": "novita", "name": "Novita AI", "prefix": "novita",
     "models": [
         "meta-llama/llama-3.1-70b-instruct",
         "deepseek/deepseek-r1",
         "qwen/qwen2.5-72b-instruct",
         "mistralai/mistral-7b-instruct",
     ]},
    {"id": "nebius", "name": "Nebius AI Studio", "prefix": "nebius",
     "models": [
         "meta-llama/Meta-Llama-3.1-70B-Instruct",
         "Qwen/Qwen2.5-72B-Instruct",
         "deepseek-ai/DeepSeek-R1",
         "mistralai/Mistral-Nemo-Instruct-2407",
     ]},
    {"id": "featherless_ai", "name": "Featherless AI", "prefix": "featherless_ai",
     "models": [
         "meta-llama/Meta-Llama-3.1-70B-Instruct",
         "Qwen/Qwen2.5-72B-Instruct",
         "mistralai/Mistral-7B-Instruct-v0.3",
         "NousResearch/Hermes-3-Llama-3.1-70B",
     ]},
    {"id": "nscale", "name": "Nscale (EU Sovereign)", "prefix": "nscale",
     "models": [
         "meta-llama/Llama-3.3-70B-Instruct",
         "deepseek-ai/DeepSeek-R1",
         "Qwen/Qwen2.5-72B-Instruct",
         "mistralai/Mistral-7B-Instruct-v0.3",
     ]},
    {"id": "friendliai", "name": "FriendliAI", "prefix": "friendliai",
     "models": [
         "meta-llama-3.1-70b-instruct",
         "deepseek-r1",
         "mixtral-8x7b-instruct-v0-1",
     ]},

    # ── Routing / aggregation ─────────────────────────────────────────────────
    {"id": "openrouter", "name": "OpenRouter", "prefix": "openrouter",
     "models": [
         "anthropic/claude-sonnet-4-6",
         "openai/gpt-4o",
         "google/gemini-2.5-pro",
         "deepseek/deepseek-r1",
         "meta-llama/llama-3.3-70b-instruct",
         "mistralai/mixtral-8x22b-instruct",
         "qwen/qwen-2.5-72b-instruct",
     ]},

    # ── Specialised / regional ────────────────────────────────────────────────
    {"id": "ai21", "name": "AI21 Labs", "prefix": "ai21",
     "models": [
         "jamba-1.6-large", "jamba-1.6-mini",
         "jamba-instruct", "j2-ultra", "j2-mid",
     ]},
    {"id": "nvidia_nim", "name": "Nvidia NIM", "prefix": "nvidia_nim",
     "models": [
         "meta/llama-3.1-70b-instruct", "meta/llama-3.3-70b-instruct",
         "nvidia/llama-3.1-nemotron-ultra-253b-v1",
         "deepseek-ai/deepseek-r1",
         "qwen/qwen2.5-72b-instruct",
         "mistralai/mistral-large-2-instruct",
     ]},
    {"id": "huggingface", "name": "HuggingFace (Inference API)", "prefix": "huggingface",
     "models": [
         "meta-llama/Meta-Llama-3.1-8B-Instruct",
         "meta-llama/Llama-3.3-70B-Instruct",
         "mistralai/Mistral-7B-Instruct-v0.3",
         "Qwen/Qwen2.5-72B-Instruct",
         "google/gemma-2-9b-it",
     ]},
    {"id": "replicate", "name": "Replicate", "prefix": "replicate",
     "models": [
         "meta/meta-llama-3.1-405b-instruct",
         "meta/meta-llama-3-70b-instruct",
         "mistralai/mixtral-8x7b-instruct-v0.1",
     ]},
    {"id": "databricks", "name": "Databricks", "prefix": "databricks",
     "models": [
         "databricks-dbrx-instruct", "databricks-meta-llama-3-3-70b-instruct",
         "databricks-claude-3-7-sonnet", "databricks-mixtral-8x7b-instruct",
     ]},
    {"id": "cloudflare", "name": "Cloudflare Workers AI", "prefix": "cloudflare",
     "models": [
         "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
         "@cf/meta/llama-3.1-70b-instruct",
         "@cf/mistral/mistral-7b-instruct-v0.2-lora",
         "@cf/google/gemma-7b-it",
         "@cf/qwen/qwen1.5-72b-chat",
     ]},
    {"id": "anyscale", "name": "Anyscale", "prefix": "anyscale",
     "models": [
         "meta-llama/Meta-Llama-3.1-70B-Instruct",
         "mistralai/Mistral-7B-Instruct-v0.1",
         "codellama/CodeLlama-70b-Instruct-hf",
     ]},
    {"id": "moonshot", "name": "Moonshot AI", "prefix": "moonshot",
     "models": ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"]},
    {"id": "minimax", "name": "MiniMax", "prefix": "minimax",
     "models": ["abab7-chat-preview", "abab6.5s-chat", "abab6.5g-chat"]},
    {"id": "dashscope", "name": "Dashscope (Qwen / Alibaba)", "prefix": "dashscope",
     "models": [
         "qwen-max", "qwen-plus", "qwen-turbo",
         "qwen-long", "qwen2.5-72b-instruct",
     ]},
    {"id": "volcano", "name": "Volcano Engine (ByteDance)", "prefix": "volcengine",
     "models": [
         "doubao-pro-32k", "doubao-pro-4k", "doubao-lite-32k",
         "deepseek-r1-250120",
     ]},
    {"id": "scaleway", "name": "Scaleway", "prefix": "scaleway",
     "models": [
         "llama-3.3-70b-instruct", "mistral-nemo-instruct-2407",
         "deepseek-r1", "qwen2.5-coder-32b-instruct",
     ]},
    {"id": "nlp_cloud", "name": "NLP Cloud", "prefix": "nlp_cloud",
     "models": [
         "finetuned-llama-3-70b", "llama-3-70b",
         "dolphin", "chatdolphin",
     ]},
    {"id": "aleph_alpha", "name": "Aleph Alpha", "prefix": "aleph_alpha",
     "models": ["luminous-supreme-control", "luminous-supreme", "luminous-extended"]},
    {"id": "predibase", "name": "Predibase", "prefix": "predibase",
     "models": [
         "llama-3-1-8b-instruct", "llama-3-1-70b-instruct",
         "mistral-7b-instruct-v0-3",
     ]},

    # ── Local / self-hosted ───────────────────────────────────────────────────
    {"id": "ollama", "name": "Ollama (local)", "prefix": "ollama",
     "models": [
         "llama3.3", "llama3.2", "llama3.1", "mistral", "codellama",
         "qwen2.5-coder", "deepseek-r1", "phi4", "gemma3", "command-r",
     ]},
    {"id": "vllm", "name": "vLLM (local)", "prefix": "hosted_vllm",
     "models": [
         "meta-llama/Meta-Llama-3.1-8B-Instruct",
         "Qwen/Qwen2.5-7B-Instruct",
         "mistralai/Mistral-7B-Instruct-v0.3",
     ]},
    {"id": "lm_studio", "name": "LM Studio (local)", "prefix": "lm_studio",
     "models": [
         "llama-3.2-3b-instruct", "qwen2.5-7b-instruct-1m",
         "mistral-7b-instruct-v0.3",
     ]},
]

ENV_KEYS = {
    # Tier-1 hosted
    "anthropic":    "ANTHROPIC_API_KEY",
    "openai":       "OPENAI_API_KEY",
    "google":       "GOOGLE_API_KEY",
    "vertex_ai":    "GOOGLE_APPLICATION_CREDENTIALS",
    "xai":          "XAI_API_KEY",
    "mistral":      "MISTRAL_API_KEY",
    "cohere":       "COHERE_API_KEY",
    "deepseek":     "DEEPSEEK_API_KEY",
    "perplexity":   "PERPLEXITY_API_KEY",
    # Cloud infrastructure
    "azure":        "AZURE_API_KEY",
    "azure_ai":     "AZURE_AI_API_KEY",
    "bedrock":      "AWS_ACCESS_KEY_ID",
    "sagemaker":    "AWS_ACCESS_KEY_ID",
    "oci":          "OCI_API_KEY",
    "watsonx":      "WATSONX_API_KEY",
    # Fast inference / GPU clouds
    "groq":         "GROQ_API_KEY",
    "cerebras":     "CEREBRAS_API_KEY",
    "sambanova":    "SAMBANOVA_API_KEY",
    "fireworks_ai": "FIREWORKS_AI_API_KEY",
    "together_ai":  "TOGETHERAI_API_KEY",
    "deepinfra":    "DEEPINFRA_API_KEY",
    "hyperbolic":   "HYPERBOLIC_API_KEY",
    "lambda_ai":    "LAMBDA_API_KEY",
    "novita":       "NOVITA_API_KEY",
    "nebius":       "NEBIUS_API_KEY",
    "featherless_ai":"FEATHERLESS_API_KEY",
    "nscale":       "NSCALE_API_KEY",
    "friendliai":   "FRIENDLI_TOKEN",
    # Routing / aggregation
    "openrouter":   "OPENROUTER_API_KEY",
    # Specialised / regional
    "ai21":         "AI21_API_KEY",
    "nvidia_nim":   "NVIDIA_NIM_API_KEY",
    "huggingface":  "HUGGINGFACE_API_KEY",
    "replicate":    "REPLICATE_API_TOKEN",
    "databricks":   "DATABRICKS_API_TOKEN",
    "cloudflare":   "CLOUDFLARE_API_KEY",
    "anyscale":     "ANYSCALE_API_KEY",
    "moonshot":     "MOONSHOT_API_KEY",
    "minimax":      "MINIMAX_API_KEY",
    "dashscope":    "DASHSCOPE_API_KEY",
    "volcano":      "VOLCENGINE_API_KEY",
    "scaleway":     "SCALEWAY_API_KEY",
    "nlp_cloud":    "NLP_CLOUD_API_KEY",
    "aleph_alpha":  "ALEPH_ALPHA_API_KEY",
    "predibase":    "PREDIBASE_API_KEY",
    # Local / self-hosted
    "ollama":       "",
    "vllm":         "",
    "lm_studio":    "",
}

MESSAGES_BLOCK = [
    {"role": "system", "content": (
        "You are a File Repository Assistant specializing in updating, transforming, "
        "and managing files. Your role is to help users organize, convert, restructure, "
        "and maintain their file repositories efficiently and accurately.")},
    {"role": "user",      "content": "print <env:SOURCE_MASK>"},
    {"role": "assistant", "content": "<env:PRINT_SOURCE>"},
    {"role": "user",      "content": "print <env:TARGET_MASK>"},
    {"role": "assistant", "content": "<env:PRINT_TARGET>"},
    {"role": "user",      "content": "echo format_prompt"},
    {"role": "assistant", "content": "[write:./format.md](<env:LIPS_PATH>/format.md)"},
    {"role": "user",      "content": "echo build_prompt"},
    {"role": "assistant", "content": "<env:BUILD_PROMPT>"},
    {"role": "user",      "content": "start"},
]

FORMAT_MD_CONTENT = """\
## Output Format

Return every file you create or modify using this XML envelope:

```xml
<file path="./relative/path/to/file.ext">
complete file contents here
</file>
```

Rules:
- Paths **must** be relative and begin with `./` -- they map to the target stage `repo/`. The current path `./` is equal to the masked path to output repo, which you can't see. 
- Every `<file>` tag must contain the **complete** file contents. No partial files, no `...` placeholders.
- Include **only** new or modified files. Leave unchanged files out entirely.
- For image files that need to be generated, produce a `<name>.prompt.md` file instead.
- To **delete** a file, write a strictly empty tag: `<file path="./obsolete.py"></file>`
- If the existing output already meets the specification in full, produce **no** `<file>` tags.
"""


def _litellm_model(provider_id: str, model_name: str) -> str:
    if "/" in model_name:
        return model_name
    prov = next((p for p in PROVIDERS if p["id"] == provider_id), None)
    prefix = prov["prefix"] if prov else provider_id
    return f"{prefix}/{model_name}"


def _pipeline_dir(pipeline: str) -> Path:
    from .workspace import get_workspace
    return get_workspace() / pipeline


@router.get("/api/create/providers")
async def get_providers():
    return {"providers": PROVIDERS}


# -- Create pipeline ----------------------------------------------------------

class CreatePipelineBody(BaseModel):
    name:        str
    provider:    str   = "anthropic"
    model:       str   = "claude-sonnet-4-6"
    max_tokens:  int   = 20000
    temperature: float = 0.0
    timeout:     int   = 1200
    api_var:     str   = "ANTHROPIC_API_KEY"
    # stages still accepted for add-thread (append_only mode)
    stages:      Optional[List[dict]] = None
    append_only: bool  = False
    overwrite:   bool  = True


@router.post("/api/create/pipeline")
async def create_pipeline(body: CreatePipelineBody):
    from .workspace import get_workspace
    ws  = get_workspace()
    pipe_dir = ws / body.name

    model_str = _litellm_model(body.provider, body.model)

    if not body.append_only:
        # Full pipeline creation
        pipe_dir.mkdir(parents=True, exist_ok=True)

        config = {
            "generate": {
                "model":       model_str,
                "max_tokens":  body.max_tokens,
                "temperature": body.temperature,
                "timeout":     body.timeout,
            },
            "api_var":  body.api_var,
            "messages": MESSAGES_BLOCK,
        }
        (pipe_dir / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        (pipe_dir / "format.md").write_text(FORMAT_MD_CONTENT, encoding="utf-8")

        # Also create workspace-level format.md if it doesn't exist yet
        ws_format = ws / "format.md"
        if not ws_format.exists():
            ws_format.write_text(FORMAT_MD_CONTENT, encoding="utf-8")

    # Add stages if provided
    skipped: list[str] = []
    if body.stages:
        stages = body.stages
        # Determine final stage: last one or one marked "/"
        for i, spec in enumerate(stages):
            name       = spec.get("name", "").strip()
            build_file = spec.get("build_file", "").strip()
            if not name:
                continue

            is_final = (i + 1 == len(stages))
            if build_file == "":
                if not is_final:
                    build_file = f"{stages[i+1].get('name', '').strip()}.py"
                else:
                    build_file = f"{stages[i].get('name', '').strip()}.py"

                    

            stage_dir = pipe_dir / name
            (stage_dir / "build").mkdir(parents=True, exist_ok=True)
            (stage_dir / "repo").mkdir(parents=True, exist_ok=True)

            bf_path = stage_dir / "build" / build_file

            if bf_path.exists() and not body.overwrite:
                skipped.append(f"{name}/build/{build_file}")
                continue

            if not is_final:
                next_stage = stages[i + 1].get("name", "").strip() if i + 1 < len(stages) else ""
                if bf_path.suffix == ".py":
                    iname = bf_path.stem
                    content = (
                        'env_block = """\n'
                        "```env\n"
                        f"TARGET={next_stage}\n"
                        f"ALIAS={iname}\n"
                        "```\n"
                        "```sourceignore\n"
                        ".thought\n"
                        "```\n"
                        "```targetignore\n"
                        "*\n"
                        "```\n"
                        '"""\n'
                        "import os\n"
                        "import time\n"
                        "import sys\n"
                        "from lips.utils.parse_build_files import env_from_build_file\n"
                        "_, env = env_from_build_file(env_block)\n"
                    )
                else:
                    iname = bf_path.stem
                    content = (
                        "```env\n"
                        f"TARGET={next_stage}\n"
                        f"ALIAS={iname}\n"
                        "```\n"
                        "```sourceignore\n"
                        ".thought\n"
                        "```\n"
                        "```targetignore\n"
                        "*\n"
                        "```\n"
                    )
                bf_path.write_text(content, encoding="utf-8")

    return {"ok": True, "pipeline": body.name, "skipped": skipped}
