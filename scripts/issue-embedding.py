#!/usr/bin/env python3
"""Generate BAAI/bge-m3 embeddings from line-oriented JSON requests on stdin.

The Node issue-store adapter owns process lifecycle and persistence. Keeping the
process line-oriented lets migration encode many issues while loading the model
only once, and lets it be replaced by a deterministic fake command in seam tests.
"""

import json
import os
import sys
from pathlib import Path


_OFFLINE_VALUES = {"1", "true", "yes", "on"}
_OFFLINE_BY_DEFAULT = os.environ.get("ISSUE_EMBEDDING_OFFLINE", "1").lower() in _OFFLINE_VALUES
if _OFFLINE_BY_DEFAULT:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

from sentence_transformers import SentenceTransformer


VECTOR_DIMENSION = 1024
DEFAULT_MODEL_NAME = "BAAI/bge-m3"


def resolve_model() -> tuple[str, bool, str]:
    configured = os.environ.get("ISSUE_EMBEDDING_MODEL", DEFAULT_MODEL_NAME)
    expanded = os.path.abspath(os.path.expanduser(os.path.expandvars(configured)))
    local_path = Path(expanded)
    if local_path.is_dir():
        return str(local_path), True, "local path"

    offline = os.environ.get("ISSUE_EMBEDDING_OFFLINE", "1").lower() in _OFFLINE_VALUES
    source = "Hugging Face cache (offline)" if offline else "Hugging Face/cache"
    return configured, offline, source


def main() -> None:
    model_name, local_files_only, source = resolve_model()
    print(
        f"loading embedding model {model_name} from {source} "
        f"(local_files_only={local_files_only})",
        file=sys.stderr,
        flush=True,
    )
    model = SentenceTransformer(model_name, local_files_only=local_files_only)
    print(f"embedding model {model_name} is ready", file=sys.stderr, flush=True)

    for raw_request in sys.stdin:
        if not raw_request.strip():
            continue
        request = json.loads(raw_request)
        text = request.get("text", "")
        position = request.get("_embedding_index")
        total = request.get("_embedding_total")
        label = request.get("_embedding_label", "")
        progress = f" ({position}/{total})" if position and total else ""
        if label:
            progress += f" {label}"
        print(f"encoding input text{progress}", file=sys.stderr, flush=True)
        embedding = model.encode(text, normalize_embeddings=True)
        print(f"encoding complete{progress}", file=sys.stderr, flush=True)
        values = embedding.tolist()
        if len(values) != VECTOR_DIMENSION:
            raise ValueError(
                f"expected {VECTOR_DIMENSION} dimensions, received {len(values)}"
            )
        print(
            json.dumps({"embedding": [float(value) for value in values]}),
            flush=True,
        )


if __name__ == "__main__":
    main()
