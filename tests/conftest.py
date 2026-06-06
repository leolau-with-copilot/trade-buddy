"""Shared pytest fixtures that prevent CI hangs when API keys are absent."""

import os

import pytest


def pytest_configure(config):
    for marker in ("unit", "integration", "smoke"):
        config.addinivalue_line("markers", f"{marker}: {marker}-level tests")


# Only the supported providers need keys (Ollama needs none).
_API_KEY_ENV_VARS = (
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
)


@pytest.fixture(autouse=True)
def _dummy_api_keys(monkeypatch):
    for env_var in _API_KEY_ENV_VARS:
        monkeypatch.setenv(env_var, os.environ.get(env_var, "placeholder"))
