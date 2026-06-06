"""Manual JSON structured-output for DeepSeek.

DeepSeek does not support OpenAI's ``json_schema`` ``response_format`` (the mode
AutoGen uses for ``json_output=Schema`` / ``output_content_type``): the API
returns 400 "This response_format type is unavailable now", and
``deepseek-reasoner`` supports no JSON/schema mode at all. So we get structured
output the portable way — embed the schema in the prompt, ask for a bare JSON
object, and parse the returned text into the Pydantic model — with a retry and a
tolerant extractor for fenced / prose-wrapped JSON.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional, Type, TypeVar

from autogen_core.models import AssistantMessage, SystemMessage, UserMessage
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def _schema_instructions(schema: Type[BaseModel]) -> str:
    """Prompt fragment describing the exact JSON to return."""
    return (
        "Respond with ONLY a single JSON object (no prose, no markdown fences) "
        "that conforms to this JSON Schema:\n"
        f"{json.dumps(schema.model_json_schema())}\n"
        "Every required field must be present. Use plain JSON types."
    )


def _extract_json(text: str) -> Optional[Any]:
    """Best-effort extraction of a JSON object/array from model output."""
    if not text:
        return None
    text = text.strip()
    # Direct parse.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fenced block.
    m = _FENCE_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    # First balanced-looking {...} or [...] span.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if 0 <= start < end:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None


def _content_str(result: Any) -> str:
    content = getattr(result, "content", result)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c for c in content if isinstance(c, str))
    return str(content) if content is not None else ""


async def complete_json(
    client: Any,
    *,
    system: str,
    user: str,
    schema: Type[T],
    max_attempts: int = 2,
) -> T:
    """Ask ``client`` for JSON matching ``schema`` and parse it.

    Works on both DeepSeek models (no ``response_format`` is sent, since the
    reasoner rejects it). Retries once with a corrective nudge if the first
    reply is not valid JSON for the schema.

    Raises:
        ValueError: if no attempt yields schema-valid JSON.
    """
    sys_msg = SystemMessage(content=f"{system}\n\n{_schema_instructions(schema)}")
    messages: list = [sys_msg, UserMessage(content=user, source="user")]
    last_err: Optional[Exception] = None

    for attempt in range(max_attempts):
        result = await client.create(messages)
        text = _content_str(result)
        obj = _extract_json(text)
        if obj is not None:
            try:
                return schema.model_validate(obj)
            except ValidationError as exc:
                last_err = exc
        else:
            last_err = ValueError("no JSON object found in response")

        if attempt < max_attempts - 1:
            # Carry the assistant turn (with its thought, so DeepSeek's
            # reasoning round-trip stays valid) and nudge for valid JSON.
            messages.append(AssistantMessage(
                content=text or " ", source="assistant",
                thought=getattr(result, "thought", None),
            ))
            messages.append(UserMessage(
                content="That was not valid JSON for the schema. Reply with ONLY "
                        "the JSON object, nothing else.",
                source="user",
            ))

    raise ValueError(f"{schema.__name__}: could not parse JSON output ({last_err})")
