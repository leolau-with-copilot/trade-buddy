"""Run the web UI: ``python -m webapp`` (or ``tradingagents-web``)."""

import os


def main() -> None:
    import uvicorn

    host = os.environ.get("TRADINGAGENTS_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("TRADINGAGENTS_WEB_PORT", "8000"))
    uvicorn.run("webapp.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
