#!/usr/bin/env python3
"""Filter Azure AI Search by TOC title and document number.

Example:
    python scripts/azure_search_toc_filter.py \
        --toc "Failure Code [CA441]" \
        --document SEN06496-04
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Optional


def parse_env_file(path: Path) -> dict:
    """Parse a simple KEY=VALUE .env file (comments and quotes supported)."""
    env: dict = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        # strip surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        env[key] = value
    return env


def find_env(start: Path) -> dict:
    """Look for .env in start dir, its parents, and sibling backend/.env dirs."""
    for directory in [start, *start.parents]:
        env_path = directory / ".env"
        if env_path.exists():
            return parse_env_file(env_path)
        # Also check backend/.env one level inside each parent (e.g. repo/backend/.env)
        backend_env = directory / "backend" / ".env"
        if backend_env.exists():
            return parse_env_file(backend_env)
    return {}


def escape_search_string(s: str) -> str:
    """Escape characters reserved in Azure AI Search simple query syntax."""
    return re.sub(r"([+\-&|!(){}[\]^\"~*?:\\/])", r"\\\1", s)


def escape_odata_string(s: str) -> str:
    """Escape single quotes inside an OData string literal."""
    return s.replace("'", "''")


def build_filter(toc_titles: List[str], document_numbers: List[str]) -> str:
    parts: List[str] = []
    if toc_titles:
        escaped_titles = [
            escape_odata_string(escape_search_string(t.strip()))
            for t in toc_titles
            if t.strip()
        ]
        toc_filter = " or ".join(
            f"search.ismatch('{t}', 'TOC', 'simple', 'all')" for t in escaped_titles
        )
        parts.append(f"({toc_filter})")
    if document_numbers:
        escaped_docs = [d.strip().replace("'", "''") for d in document_numbers if d.strip()]
        doc_filter = " or ".join(f"documentNumber eq '{d}'" for d in escaped_docs)
        parts.append(f"({doc_filter})")
    return " and ".join(parts)


def search(
    endpoint: str,
    index_name: str,
    api_key: str,
    toc_titles: List[str],
    document_numbers: List[str],
    search_text: str = "*",
    select: Optional[List[str]] = None,
    top: int = 50,
) -> dict:
    filter_expression = build_filter(toc_titles, document_numbers)
    if filter_expression:
        print(f"Filter expression: {filter_expression}", file=sys.stderr)

    url = f"{endpoint.rstrip('/')}/indexes/{index_name}/docs/search?api-version=2023-11-01"
    payload: dict = {
        "search": search_text or "*",
        "top": top,
    }
    if filter_expression:
        payload["filter"] = filter_expression
    if select:
        payload["select"] = ",".join(select)

    headers = {
        "Content-Type": "application/json",
        "api-key": api_key,
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Azure AI Search request failed ({exc.code}): {body}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Filter Azure AI Search by TOC title and document number."
    )
    parser.add_argument(
        "--toc",
        action="append",
        metavar="TITLE",
        help="TOC title to search for (can be repeated).",
    )
    parser.add_argument(
        "--document",
        action="append",
        metavar="DOC_NUMBER",
        help="Document number to filter by (can be repeated).",
    )
    parser.add_argument(
        "--env",
        type=Path,
        help="Path to .env file. If omitted, the script searches upward for .env.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=50,
        help="Maximum number of results to return (default: 50).",
    )
    parser.add_argument(
        "--select",
        default="id,document_id,documentNumber,documentTitle,path,parent_path,TOC,start_page,end_page,fileName,language,content,same_page_paths,image_content",
        help="Comma-separated list of fields to return.",
    )
    parser.add_argument(
        "--index-name",
        help="Azure AI Search index name. Defaults to AZURE_SEARCH_INDEX_NAME in the .env file.",
    )
    parser.add_argument(
        "--query",
        help="Free-text similarity search query. When provided, Azure AI Search ranks results by text relevance instead of matching TOC exactly.",
    )
    args = parser.parse_args()

    if not args.toc and not args.document and not args.query:
        parser.error("Provide at least one --toc, --document, or --query.")

    env_path = args.env if args.env else None
    env = parse_env_file(env_path) if env_path else find_env(Path.cwd())

    endpoint = env.get("AZURE_SEARCH_ENDPOINT") or os.environ.get("AZURE_SEARCH_ENDPOINT")
    api_key = env.get("AZURE_SEARCH_API_KEY") or os.environ.get("AZURE_SEARCH_API_KEY")

    if not endpoint or not api_key:
        print(
            "Error: AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_API_KEY must be set.",
            file=sys.stderr,
        )
        return 1

    if args.index_name:
        index_names = [args.index_name]
    else:
        shop_index = env.get("AZURE_SEARCH_INDEX_NAME") or os.environ.get("AZURE_SEARCH_INDEX_NAME")
        omm_index = env.get("AZURE_SEARCH_INDEX_NAME_OMM") or os.environ.get("AZURE_SEARCH_INDEX_NAME_OMM")
        index_names = []
        if shop_index:
            index_names.append(shop_index)
        if omm_index and omm_index not in index_names:
            index_names.append(omm_index)
        if not index_names:
            print(
                "Error: AZURE_SEARCH_INDEX_NAME or AZURE_SEARCH_INDEX_NAME_OMM must be set, or provide --index-name.",
                file=sys.stderr,
            )
            return 1

    merged: dict = {"@odata.context": "", "value": [], "_searched_indexes": index_names}
    seen_ids: set[str] = set()
    try:
        for index_name in index_names:
            result = search(
                endpoint=endpoint,
                index_name=index_name,
                api_key=api_key,
                toc_titles=args.toc or [],
                document_numbers=args.document or [],
                search_text=args.query or "*",
                select=[f.strip() for f in args.select.split(",") if f.strip()],
                top=args.top,
            )
            merged["@odata.context"] = merged["@odata.context"] or result.get("@odata.context", "")
            for doc in result.get("value", []):
                doc_id = doc.get("id")
                if doc_id and doc_id in seen_ids:
                    continue
                if doc_id:
                    seen_ids.add(doc_id)
                doc["_index"] = index_name
                merged["value"].append(doc)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(merged, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
