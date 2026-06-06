"""Offline tests for the web backend (no network / no LLM calls)."""

from fastapi.testclient import TestClient

from webapp.server import _FLOW_EDGES, _summarize, app

client = TestClient(app)


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_static_served():
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/styles.css").status_code == 200


def test_summarize_prefers_rating():
    assert _summarize("**Rating**: Buy\n\nStrong momentum and trend.").startswith("Rating: Buy")


def test_summarize_truncates():
    s = _summarize("x" * 200)
    assert len(s) <= 91  # limit + ellipsis


def test_flow_topology():
    # analysts feed both researchers; researchers feed the judge; judge is terminal.
    assert _FLOW_EDGES["Market Analyst"] == ["Bull Researcher", "Bear Researcher"]
    assert _FLOW_EDGES["Bull Researcher"] == ["Judge"]
    assert _FLOW_EDGES["Judge"] == []
