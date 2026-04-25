from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import SelectorGroupChat
from autogen_core.models import ModelFamily
from autogen_ext.models.openai import OpenAIChatCompletionClient

from prompts import (
    CREATIVE_SYSTEM_PROMPT,
    MEETING_PLANNER_SYSTEM_PROMPT,
    MODERATOR_SYSTEM_PROMPT,
    OPERATIONS_SYSTEM_PROMPT,
    PUBLICITY_SYSTEM_PROMPT,
    RISK_SYSTEM_PROMPT,
    SELECTOR_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
)


DEFAULT_PROVIDER = "deepseek"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_INPUT_FILE = "sample_input.json"
DEFAULT_OUTPUT_DIR = "outputs"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_DISCUSSION_TURNS = 10
DEEPSEEK_MODEL_INFO = {
    "vision": False,
    "function_calling": False,
    "json_output": False,
    "family": ModelFamily.UNKNOWN,
    "structured_output": False,
}
StageCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass
class PlanningInput:
    task_type: str = "activity"
    topic: str = ""
    theme: str = ""
    goal: str = ""
    target_audience: list[str] = field(default_factory=list)
    scale: int | str | None = None
    duration_minutes: int | None = None
    venue: str = ""
    budget: str = ""
    background: str = ""
    constraints: list[str] = field(default_factory=list)
    expected_outputs: list[str] = field(default_factory=list)
    participants: list[str] = field(default_factory=list)
    notes: str = ""


def normalize_input_data(data: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(data)
    if not normalized.get("topic") and normalized.get("theme"):
        normalized["topic"] = normalized["theme"]
    if not normalized.get("theme") and normalized.get("topic"):
        normalized["theme"] = normalized["topic"]
    if "deliverables" in normalized and "expected_outputs" not in normalized:
        normalized["expected_outputs"] = normalized["deliverables"]
    return normalized


def planning_input_from_dict(data: dict[str, Any]) -> PlanningInput:
    return PlanningInput(**normalize_input_data(data))


def load_input(path: str) -> PlanningInput:
    with open(path, "r", encoding="utf-8") as file:
        data = json.load(file)
    return planning_input_from_dict(data)


def build_base_prompt(planning_input: PlanningInput) -> str:
    payload = json.dumps(asdict(planning_input), ensure_ascii=False, indent=2)
    return (
        "以下是用户提交的活动需求，请基于该输入开展工作：\n\n"
        f"{payload}\n\n"
        "请使用中文输出。最终目标是形成一份可执行的活动策划书。"
    )


def stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            elif hasattr(item, "text"):
                parts.append(str(getattr(item, "text")))
        return "\n".join(part for part in parts if part).strip()
    return str(content).strip()


def extract_text(result: Any) -> str:
    messages = getattr(result, "messages", None)
    if not messages:
        return str(result)

    for message in reversed(messages):
        text = stringify_content(getattr(message, "content", None))
        if text:
            return text
    return str(result)


def serialize_messages(messages: list[Any] | tuple[Any, ...] | Any) -> list[dict[str, str]]:
    serialized: list[dict[str, str]] = []
    for message in messages:
        text = stringify_content(getattr(message, "content", None))
        if not text:
            continue
        serialized.append(
            {
                "source": str(getattr(message, "source", getattr(message, "name", "unknown"))),
                "type": message.__class__.__name__,
                "content": text,
            }
        )
    return serialized


def format_transcript(messages: list[dict[str, str]]) -> str:
    blocks = []
    for item in messages:
        blocks.append(f"### {item['source']}\n{item['content']}")
    return "\n\n".join(blocks)


def extract_resolution_cards(content: str) -> list[dict[str, str]]:
    cards: list[dict[str, str]] = []
    start_tag = "[决议卡]"
    end_tag = "[/决议卡]"
    remaining = content
    while start_tag in remaining and end_tag in remaining:
        start = remaining.index(start_tag) + len(start_tag)
        end = remaining.index(end_tag, start)
        block = remaining[start:end].strip()
        remaining = remaining[end + len(end_tag):]
        data = {
            "topic": "",
            "decision": "",
            "reason": "",
            "owner": "",
            "pending": "",
        }
        for line in block.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            if key == "议题":
                data["topic"] = value
            elif key == "结论":
                data["decision"] = value
            elif key == "原因":
                data["reason"] = value
            elif key == "执行人":
                data["owner"] = value
            elif key == "待确认":
                data["pending"] = value
        if any(data.values()):
            cards.append(data)
    return cards


async def run_agent(agent: AssistantAgent, task: str) -> str:
    result = await agent.run(task=task)
    return extract_text(result)


async def emit_event(callback: StageCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    result = callback(event)
    if inspect.isawaitable(result):
        await result


async def close_model_client(model_client: Any) -> None:
    close_method = getattr(model_client, "close", None)
    if not callable(close_method):
        return
    maybe_awaitable = close_method()
    if inspect.isawaitable(maybe_awaitable):
        await maybe_awaitable


def ensure_output_dir(path: str) -> Path:
    output_dir = Path(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def build_markdown_summary(
    planning_input: PlanningInput,
    meeting_plan: str,
    discussion_transcript: str,
    final_output: str,
) -> str:
    return f"""# Three-Stage Activity Planning Run

## Input
```json
{json.dumps(asdict(planning_input), ensure_ascii=False, indent=2)}
```

## Stage 1 - Meeting Plan
{meeting_plan}

## Stage 2 - Multi-Agent Discussion
{discussion_transcript}

## Stage 3 - Final Activity Plan
{final_output}
"""


def resolve_provider_config(
    provider: str,
    explicit_base_url: str | None,
) -> tuple[str | None, str | None]:
    provider_name = provider.lower().strip()

    if provider_name == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
        base_url = (
            explicit_base_url
            or os.getenv("DEEPSEEK_BASE_URL")
            or os.getenv("OPENAI_BASE_URL")
            or DEFAULT_DEEPSEEK_BASE_URL
        )
        return api_key, base_url

    if provider_name == "openai":
        api_key = os.getenv("OPENAI_API_KEY")
        base_url = explicit_base_url or os.getenv("OPENAI_BASE_URL")
        return api_key, base_url

    raise ValueError(f"不支持的 provider: {provider}")


def get_model_info(provider: str) -> dict[str, Any] | None:
    provider_name = provider.lower().strip()
    if provider_name == "deepseek":
        return DEEPSEEK_MODEL_INFO
    return None


def create_model_client(
    provider: str,
    model_name: str,
    base_url: str | None,
) -> OpenAIChatCompletionClient:
    api_key, resolved_base_url = resolve_provider_config(
        provider=provider,
        explicit_base_url=base_url,
    )
    if not api_key:
        raise RuntimeError("缺少 API Key。若使用 DeepSeek，请先设置 DEEPSEEK_API_KEY。")

    return OpenAIChatCompletionClient(
        model=model_name,
        api_key=api_key,
        base_url=resolved_base_url,
        model_info=get_model_info(provider),
    )


def create_discussion_team(
    model_client: OpenAIChatCompletionClient,
    max_turns: int,
) -> SelectorGroupChat:
    creative_agent = AssistantAgent(
        name="creative_agent",
        description="代表创意立场，强调活动必须有记忆点和亮点，会反对平庸保守方案。",
        model_client=model_client,
        system_message=CREATIVE_SYSTEM_PROMPT,
    )
    operations_agent = AssistantAgent(
        name="operations_agent",
        description="代表执行落地立场，强调排期、分工和执行复杂度，会压缩不现实方案。",
        model_client=model_client,
        system_message=OPERATIONS_SYSTEM_PROMPT,
    )
    publicity_agent = AssistantAgent(
        name="publicity_agent",
        description="代表传播转化立场，强调活动是否有人愿意来、愿意传播。",
        model_client=model_client,
        system_message=PUBLICITY_SYSTEM_PROMPT,
    )
    risk_agent = AssistantAgent(
        name="risk_agent",
        description="代表预算风险立场，专门挑战超预算、过度乐观和缺兜底的方案。",
        model_client=model_client,
        system_message=RISK_SYSTEM_PROMPT,
    )
    moderator_agent = AssistantAgent(
        name="moderator_agent",
        description="代表主持收敛立场，负责识别分歧、逼出取舍，并形成结论。",
        model_client=model_client,
        system_message=MODERATOR_SYSTEM_PROMPT,
    )

    return SelectorGroupChat(
        participants=[
            creative_agent,
            operations_agent,
            publicity_agent,
            risk_agent,
            moderator_agent,
        ],
        model_client=model_client,
        max_turns=max_turns,
        allow_repeated_speaker=False,
        selector_prompt=SELECTOR_PROMPT,
    )


async def generate_meeting_plan(
    model_client: OpenAIChatCompletionClient,
    planning_input: PlanningInput,
) -> str:
    meeting_planner = AssistantAgent(
        name="meeting_planner_agent",
        model_client=model_client,
        system_message=MEETING_PLANNER_SYSTEM_PROMPT,
    )
    base_prompt = build_base_prompt(planning_input)
    return await run_agent(
        meeting_planner,
        f"{base_prompt}\n\n请先生成一份“内部活动筹备会”会议方案。",
    )


async def run_discussion(
    model_client: OpenAIChatCompletionClient,
    planning_input: PlanningInput,
    meeting_plan: str,
    max_turns: int,
    on_event: StageCallback | None = None,
) -> dict[str, Any]:
    team = create_discussion_team(model_client=model_client, max_turns=max_turns)
    task = (
        f"{build_base_prompt(planning_input)}\n\n"
        "下面是一份为了产生活动策划书而设计的内部筹备会议方案，请围绕它展开多角色讨论。\n\n"
        f"{meeting_plan}\n\n"
        "讨论目标：形成一套兼顾创意、执行、宣传、预算与风险的活动策划结论。\n\n"
        "本轮讨论必须显式围绕以下冲突展开，不要一味附和：\n"
        "1. 创意亮点 vs 执行复杂度\n"
        "2. 宣传声量 vs 实际转化\n"
        "3. 活动效果 vs 预算与资源约束\n"
        "4. 理想方案 vs 7天筹备周期\n\n"
        "要求：\n"
        "- 发言时要明确回应上一位角色，必要时直接反驳\n"
        "- 不要只说支持，要指出取舍和代价\n"
        "- moderator_agent 需要在合适时机总结分歧与临时结论"
    )
    discussion_messages: list[dict[str, str]] = []
    resolution_cards: list[dict[str, str]] = []
    stop_reason: str | None = None
    async for item in team.run_stream(task=task):
        if hasattr(item, "messages") and hasattr(item, "stop_reason"):
            stop_reason = getattr(item, "stop_reason", None)
            continue
        source = str(getattr(item, "source", getattr(item, "name", "unknown")))
        if source == "user":
            continue
        content = stringify_content(getattr(item, "content", None))
        if not content:
            continue
        event = {
            "source": source,
            "type": item.__class__.__name__,
            "content": content,
        }
        discussion_messages.append(event)
        await emit_event(
            on_event,
            {
                "type": "discussion_message",
                "stage": 2,
                "message": event,
            },
        )
        if source == "moderator_agent":
            cards = extract_resolution_cards(content)
            if cards:
                resolution_cards.extend(cards)
                await emit_event(
                    on_event,
                    {
                        "type": "moderator_resolution",
                        "stage": 2,
                        "cards": cards,
                    },
                )
    return {
        "messages": discussion_messages,
        "transcript": format_transcript(discussion_messages),
        "stop_reason": stop_reason,
        "resolution_cards": resolution_cards,
    }


async def synthesize_activity_plan(
    model_client: OpenAIChatCompletionClient,
    planning_input: PlanningInput,
    meeting_plan: str,
    discussion_transcript: str,
) -> str:
    synthesizer = AssistantAgent(
        name="activity_synthesizer_agent",
        model_client=model_client,
        system_message=SYNTHESIZER_SYSTEM_PROMPT,
    )
    base_prompt = build_base_prompt(planning_input)
    final_task = (
        f"{base_prompt}\n\n"
        "请整合以下内容，直接输出最终活动策划书：\n\n"
        f"【阶段1：筹备会议方案】\n{meeting_plan}\n\n"
        f"【阶段2：多 Agent 讨论记录】\n{discussion_transcript}"
    )
    return await run_agent(synthesizer, final_task)


async def generate_plan(
    planning_input: PlanningInput,
    model_name: str,
    provider: str,
    base_url: str | None,
    discussion_turns: int,
) -> dict[str, Any]:
    model_client = create_model_client(
        provider=provider,
        model_name=model_name,
        base_url=base_url,
    )
    try:
        meeting_plan = await generate_meeting_plan(
            model_client=model_client,
            planning_input=planning_input,
        )

        discussion_data = await run_discussion(
            model_client=model_client,
            planning_input=planning_input,
            meeting_plan=meeting_plan,
            max_turns=discussion_turns,
        )

        final_output = await synthesize_activity_plan(
            model_client=model_client,
            planning_input=planning_input,
            meeting_plan=meeting_plan,
            discussion_transcript=discussion_data["transcript"],
        )

        return {
            "provider": provider,
            "model": model_name,
            "base_url": resolve_provider_config(provider, base_url)[1],
            "input": asdict(planning_input),
            "meeting_plan": meeting_plan,
            "discussion_turns": discussion_turns,
            "discussion_stop_reason": discussion_data["stop_reason"],
            "discussion_messages": discussion_data["messages"],
            "resolution_cards": discussion_data["resolution_cards"],
            "discussion_transcript": discussion_data["transcript"],
            "final_output": final_output,
        }
    finally:
        await close_model_client(model_client)


async def generate_plan_with_events(
    planning_input: PlanningInput,
    model_name: str,
    provider: str,
    base_url: str | None,
    discussion_turns: int,
    on_event: StageCallback | None = None,
) -> dict[str, Any]:
    model_client = create_model_client(
        provider=provider,
        model_name=model_name,
        base_url=base_url,
    )
    try:
        await emit_event(
            on_event,
            {"type": "status", "status": "running", "stage": 1, "message": "开始生成筹备会议方案"},
        )
        meeting_plan = await generate_meeting_plan(
            model_client=model_client,
            planning_input=planning_input,
        )
        await emit_event(
            on_event,
            {"type": "stage_result", "stage": 1, "content": meeting_plan},
        )

        await emit_event(
            on_event,
            {"type": "status", "status": "running", "stage": 2, "message": "多 Agent 讨论中"},
        )
        discussion_data = await run_discussion(
            model_client=model_client,
            planning_input=planning_input,
            meeting_plan=meeting_plan,
            max_turns=discussion_turns,
            on_event=on_event,
        )
        await emit_event(
            on_event,
            {
                "type": "stage_result",
                "stage": 2,
                "content": discussion_data["transcript"],
                "stop_reason": discussion_data["stop_reason"],
                "resolution_cards": discussion_data["resolution_cards"],
            },
        )

        await emit_event(
            on_event,
            {"type": "status", "status": "running", "stage": 3, "message": "汇总最终活动策划书"},
        )
        final_output = await synthesize_activity_plan(
            model_client=model_client,
            planning_input=planning_input,
            meeting_plan=meeting_plan,
            discussion_transcript=discussion_data["transcript"],
        )
        await emit_event(
            on_event,
            {"type": "stage_result", "stage": 3, "content": final_output},
        )

        run_data = {
            "provider": provider,
            "model": model_name,
            "base_url": resolve_provider_config(provider, base_url)[1],
            "input": asdict(planning_input),
            "meeting_plan": meeting_plan,
            "discussion_turns": discussion_turns,
            "discussion_stop_reason": discussion_data["stop_reason"],
            "discussion_messages": discussion_data["messages"],
            "resolution_cards": discussion_data["resolution_cards"],
            "discussion_transcript": discussion_data["transcript"],
            "final_output": final_output,
        }
        await emit_event(on_event, {"type": "completed", "result": run_data})
        return run_data
    finally:
        await close_model_client(model_client)


def write_outputs(
    output_dir: Path,
    planning_input: PlanningInput,
    run_data: dict[str, Any],
) -> tuple[Path, Path]:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = output_dir / f"plan_{timestamp}.json"
    md_path = output_dir / f"plan_{timestamp}.md"

    with open(json_path, "w", encoding="utf-8") as file:
        json.dump(run_data, file, ensure_ascii=False, indent=2)

    markdown = build_markdown_summary(
        planning_input=planning_input,
        meeting_plan=run_data["meeting_plan"],
        discussion_transcript=run_data["discussion_transcript"],
        final_output=run_data["final_output"],
    )
    with open(md_path, "w", encoding="utf-8") as file:
        file.write(markdown)

    return json_path, md_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="三阶段活动策划 Multi-Agent MVP")
    parser.add_argument(
        "--input",
        default=DEFAULT_INPUT_FILE,
        help="输入 JSON 文件路径，默认 sample_input.json",
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help="输出目录，默认 outputs/",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"使用的模型名称，默认 {DEFAULT_MODEL}",
    )
    parser.add_argument(
        "--provider",
        default=DEFAULT_PROVIDER,
        choices=["deepseek", "openai"],
        help=f"模型提供方，默认 {DEFAULT_PROVIDER}",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="兼容 OpenAI 的接口地址；DeepSeek 默认使用 https://api.deepseek.com",
    )
    parser.add_argument(
        "--discussion-turns",
        type=int,
        default=DEFAULT_DISCUSSION_TURNS,
        help=f"多 Agent 讨论轮次数，默认 {DEFAULT_DISCUSSION_TURNS}",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    planning_input = load_input(args.input)
    output_dir = ensure_output_dir(args.output_dir)
    try:
        run_data = await generate_plan(
            planning_input=planning_input,
            model_name=args.model,
            provider=args.provider,
            base_url=args.base_url,
            discussion_turns=args.discussion_turns,
        )
    except Exception as exc:
        print("生成失败：")
        print(f"- provider: {args.provider}")
        print(f"- model: {args.model}")
        print(f"- error: {exc}")
        print(
            "- 提示：若使用 DeepSeek，请确认已设置 DEEPSEEK_API_KEY，"
            "必要时显式传入 --base-url https://api.deepseek.com"
        )
        raise

    json_path, md_path = write_outputs(output_dir, planning_input, run_data)
    print("生成完成：")
    print(f"- Provider: {run_data['provider']}")
    print(f"- Model: {run_data['model']}")
    print(f"- Discussion turns: {run_data['discussion_turns']}")
    print(f"- JSON: {json_path}")
    print(f"- Markdown: {md_path}")


if __name__ == "__main__":
    asyncio.run(main())
