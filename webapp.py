from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from meeting_agents import (
    DEFAULT_DEEPSEEK_BASE_URL,
    DEFAULT_DISCUSSION_TURNS,
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    generate_plan,
    generate_plan_with_events,
    planning_input_from_dict,
)


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
SAMPLE_INPUT_PATH = BASE_DIR / "sample_input.json"

app = FastAPI(title="AutoGen Activity Planner UI", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    provider: str = Field(default=DEFAULT_PROVIDER)
    model: str = Field(default=DEFAULT_MODEL)
    base_url: str | None = Field(default=DEFAULT_DEEPSEEK_BASE_URL)
    discussion_turns: int = Field(default=DEFAULT_DISCUSSION_TURNS, ge=3, le=30)
    input: dict[str, Any]


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sample")
async def sample() -> dict[str, Any]:
    with open(SAMPLE_INPUT_PATH, "r", encoding="utf-8") as file:
        return json.load(file)


@app.post("/api/generate")
async def generate(payload: GenerateRequest) -> dict[str, Any]:
    try:
        planning_input = planning_input_from_dict(payload.input)
        return await generate_plan(
            planning_input=planning_input,
            model_name=payload.model,
            provider=payload.provider,
            base_url=payload.base_url,
            discussion_turns=payload.discussion_turns,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/generate-stream")
async def generate_stream(payload: GenerateRequest) -> StreamingResponse:
    planning_input = planning_input_from_dict(payload.input)

    async def event_stream():
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        async def on_event(event: dict[str, Any]) -> None:
            await queue.put(event)

        async def runner() -> None:
            try:
                await generate_plan_with_events(
                    planning_input=planning_input,
                    model_name=payload.model,
                    provider=payload.provider,
                    base_url=payload.base_url,
                    discussion_turns=payload.discussion_turns,
                    on_event=on_event,
                )
            except Exception as exc:
                await queue.put({"type": "error", "detail": str(exc)})
            finally:
                await queue.put(None)

        task = asyncio.create_task(runner())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")
