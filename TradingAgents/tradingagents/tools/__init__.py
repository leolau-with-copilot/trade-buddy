"""Standalone tools used by agents in the AutoGen pipeline.

Currently just web search (DuckDuckGo, no API key), used by the Judge to sanity-
check the feasibility of the researchers' technical intuition against the open
internet.
"""

from .web_search import web_search, web_search_tool

__all__ = ["web_search", "web_search_tool"]
