"""Web UI for the TradingAgents coordination pipeline.

A FastAPI backend (``webapp.server``) exposes ticker search, price history, and a
Server-Sent-Events stream that runs the AutoGen pipeline and pushes live agent
status / message / report events to a single-page frontend (``webapp/static``).

Run it with:  ``python -m webapp``  (or ``uvicorn webapp.server:app``).
"""
