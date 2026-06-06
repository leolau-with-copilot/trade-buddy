"""Proxy helpers — no-op stubs for the vendored FinNLP data sources.

The upstream FinNLP library fetches rotating free proxies here. We don't use
proxies (and the original free-proxy scrapers are unreliable), so these stubs
return empty proxy lists, which makes ``FinNLP_Downloader`` issue direct
requests. Kept as stubs so the vendored ``finnlp.data_sources.*`` modules import
unchanged.
"""

from __future__ import annotations

from typing import List


def get_china_free_proxy(proxy_pages: int = 5) -> List[dict]:
    """Return an empty proxy list (direct connection)."""
    return []


def get_us_free_proxy(proxy_pages: int = 5) -> List[dict]:
    """Return an empty proxy list (direct connection)."""
    return []


class Kuaidaili:
    """Stub for the Kuaidaili tunnel-proxy client (paid). Yields no proxy."""

    def __init__(self, tunnel=None, username=None, password=None):
        self.tunnel = tunnel
        self.username = username
        self.password = password

    def get_kuaidaili_tunnel_proxy(self):
        return None
