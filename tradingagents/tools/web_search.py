"""DuckDuckGo web search tool (no API key required).

The Judge calls this to check whether a researcher's cited technical pattern or
thesis is corroborated by recent public information, as one input to the
intuition-feasibility assessment. Failures degrade gracefully to a short notice
string so a flaky search never blocks a verdict.
"""

from __future__ import annotations

import logging

from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)


def web_search(query: str, max_results: int = 5) -> str:
    """Search the web (DuckDuckGo) for ``query`` and return the top results.

    Returns a formatted list of ``title — snippet (url)`` lines, or a short
    notice if the search returns nothing or errors.
    """
    try:
        from ddgs import DDGS

        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
    except Exception as exc:  # noqa: BLE001 - never let search break the pipeline
        logger.warning("web_search failed for %r: %s", query, exc)
        return f"[web search unavailable: {exc}]"

    if not results:
        return f"[no web results for '{query}']"

    lines = [f"Web results for '{query}':"]
    for r in results:
        title = r.get("title", "").strip()
        body = (r.get("body") or "").strip()
        href = r.get("href") or r.get("url") or ""
        lines.append(f"- {title} — {body} ({href})")
    return "\n".join(lines)


web_search_tool = FunctionTool(
    web_search,
    description="Search the web (DuckDuckGo) for recent information about a query.",
    name="web_search",
)
