from typing import Optional
import datetime
import typer
import questionary
from pathlib import Path
from functools import wraps
import re
from rich.console import Console, Group
from rich.panel import Panel
from rich.spinner import Spinner
from rich.live import Live
from rich.columns import Columns
from rich.markdown import Markdown
from rich.layout import Layout
from rich.text import Text
from rich.table import Table
from collections import deque
import time
import threading
from rich.tree import Tree
from rich import box
from rich.align import Align
from rich.rule import Rule

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG
from cli.models import AnalystType
from cli.utils import *
from cli.announcements import fetch_announcements, display_announcements

console = Console()

app = typer.Typer(
    name="TradeBuddy",
    help="Trade Buddy CLI: Multi-Agent LLM Financial Analysis",
    add_completion=True,  # Enable shell completion
)


# Create a deque to store recent messages with a maximum length
class MessageBuffer:
    # Fixed teams that always run (not user-selectable). New AutoGen topology:
    # bull/bear Tree-of-Thoughts debate, then the Judge (sole verdict).
    FIXED_AGENTS = {
        "Research Debate": ["Bull Researcher", "Bear Researcher"],
        "Judgment": ["Judge"],
    }

    # Analyst name mapping
    ANALYST_MAPPING = {
        "market": "Market Analyst",
        "social": "Sentiment Analyst",
        "news": "News Analyst",
        "fundamentals": "Fundamentals Analyst",
    }

    # Report section mapping: section -> (analyst_key for filtering, finalizing_agent)
    # analyst_key: which analyst selection controls this section (None = always included)
    # finalizing_agent: which agent must be "completed" for this report to count as done
    REPORT_SECTIONS = {
        "market_report": ("market", "Market Analyst"),
        "sentiment_report": ("social", "Sentiment Analyst"),
        "news_report": ("news", "News Analyst"),
        "fundamentals_report": ("fundamentals", "Fundamentals Analyst"),
        "bull_case_md": (None, "Bull Researcher"),
        "bear_case_md": (None, "Bear Researcher"),
        # debate_md is finalised by the Judge; it is listed before
        # judge_verdict_md so the per-agent live-update map resolves "Judge" to
        # the verdict section (last write wins), while debate_md is filled at the
        # end from the final state.
        "debate_md": (None, "Judge"),
        "judge_verdict_md": (None, "Judge"),
    }

    def __init__(self, max_length=100):
        self.messages = deque(maxlen=max_length)
        self.tool_calls = deque(maxlen=max_length)
        self.current_report = None
        self.final_report = None  # Store the complete final report
        self.agent_status = {}
        self.current_agent = None
        self.report_sections = {}
        self.selected_analysts = []
        self._processed_message_ids = set()
        # Live token tracker (updated from orchestrator "usage" events).
        self.tokens_in = 0
        self.tokens_out = 0
        # Accumulating debate transcript shown live as it streams.
        self.debate_md = ""

    def init_for_analysis(self, selected_analysts):
        """Initialize agent status and report sections based on selected analysts.

        Args:
            selected_analysts: List of analyst type strings (e.g., ["market", "news"])
        """
        self.selected_analysts = [a.lower() for a in selected_analysts]

        # Build agent_status dynamically
        self.agent_status = {}

        # Add selected analysts
        for analyst_key in self.selected_analysts:
            if analyst_key in self.ANALYST_MAPPING:
                self.agent_status[self.ANALYST_MAPPING[analyst_key]] = "pending"

        # Add fixed teams
        for team_agents in self.FIXED_AGENTS.values():
            for agent in team_agents:
                self.agent_status[agent] = "pending"

        # Build report_sections dynamically
        self.report_sections = {}
        for section, (analyst_key, _) in self.REPORT_SECTIONS.items():
            if analyst_key is None or analyst_key in self.selected_analysts:
                self.report_sections[section] = None

        # Reset other state
        self.current_report = None
        self.final_report = None
        self.current_agent = None
        self.tokens_in = 0
        self.tokens_out = 0
        self.debate_md = ""
        self.messages.clear()
        self.tool_calls.clear()
        self._processed_message_ids.clear()

    def get_completed_reports_count(self):
        """Count reports that are finalized (their finalizing agent is completed).

        A report is considered complete when:
        1. The report section has content (not None), AND
        2. The agent responsible for finalizing that report has status "completed"

        This prevents interim updates (like debate rounds) from counting as completed.
        """
        count = 0
        for section in self.report_sections:
            if section not in self.REPORT_SECTIONS:
                continue
            _, finalizing_agent = self.REPORT_SECTIONS[section]
            # Report is complete if it has content AND its finalizing agent is done
            has_content = self.report_sections.get(section) is not None
            agent_done = self.agent_status.get(finalizing_agent) == "completed"
            if has_content and agent_done:
                count += 1
        return count

    def add_message(self, message_type, content):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.messages.append((timestamp, message_type, content))

    def add_tool_call(self, tool_name, args):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        self.tool_calls.append((timestamp, tool_name, args))

    def update_agent_status(self, agent, status):
        if agent in self.agent_status:
            self.agent_status[agent] = status
            self.current_agent = agent

    def update_report_section(self, section_name, content):
        if section_name in self.report_sections:
            self.report_sections[section_name] = content
            self._update_current_report()

    def _update_current_report(self):
        # For the panel display, only show the most recently updated section
        latest_section = None
        latest_content = None

        # Find the most recently updated section
        for section, content in self.report_sections.items():
            if content is not None:
                latest_section = section
                latest_content = content
               
        if latest_section and latest_content:
            # Format the current section for display
            section_titles = {
                "market_report": "Market Analysis",
                "sentiment_report": "Social Sentiment",
                "news_report": "News Analysis",
                "fundamentals_report": "Fundamentals Analysis",
                "bull_case_md": "Bull Researcher (Tree-of-Thoughts)",
                "bear_case_md": "Bear Researcher (Tree-of-Thoughts)",
                "debate_md": "Bull vs. Bear Debate",
                "judge_verdict_md": "Judge Verdict & Scoreboard",
            }
            self.current_report = (
                f"### {section_titles[latest_section]}\n{latest_content}"
            )

        # Update the final complete report
        self._update_final_report()

    def _update_final_report(self):
        report_parts = []

        # Analyst Team Reports - use .get() to handle missing sections
        analyst_sections = ["market_report", "sentiment_report", "news_report", "fundamentals_report"]
        if any(self.report_sections.get(section) for section in analyst_sections):
            report_parts.append("## Analyst Team Reports")
            if self.report_sections.get("market_report"):
                report_parts.append(
                    f"### Market Analysis\n{self.report_sections['market_report']}"
                )
            if self.report_sections.get("sentiment_report"):
                report_parts.append(
                    f"### Social Sentiment\n{self.report_sections['sentiment_report']}"
                )
            if self.report_sections.get("news_report"):
                report_parts.append(
                    f"### News Analysis\n{self.report_sections['news_report']}"
                )
            if self.report_sections.get("fundamentals_report"):
                report_parts.append(
                    f"### Fundamentals Analysis\n{self.report_sections['fundamentals_report']}"
                )

        # Research Debate (Tree-of-Thoughts bull/bear)
        if self.report_sections.get("bull_case_md") or self.report_sections.get("bear_case_md"):
            report_parts.append("## Research Debate")
            if self.report_sections.get("bull_case_md"):
                report_parts.append(f"### Bull Researcher\n{self.report_sections['bull_case_md']}")
            if self.report_sections.get("bear_case_md"):
                report_parts.append(f"### Bear Researcher\n{self.report_sections['bear_case_md']}")

        # Live bull/bear debate transcript + consensus outcome
        if self.report_sections.get("debate_md"):
            report_parts.append("## Bull vs. Bear Debate")
            report_parts.append(f"{self.report_sections['debate_md']}")

        # Judge Verdict (final decision + scoreboard)
        if self.report_sections.get("judge_verdict_md"):
            report_parts.append("## Judge Verdict & Scoreboard")
            report_parts.append(f"{self.report_sections['judge_verdict_md']}")

        self.final_report = "\n\n".join(report_parts) if report_parts else None


message_buffer = MessageBuffer()

# A single, persistent spinner reused across every repaint. Constructing a new
# Spinner each render reset its internal start-time to "now", so it was always
# frozen on frame 0; one shared instance animates correctly because its frame is
# derived from the elapsed wall-clock time at each refresh.
_STATUS_SPINNER = Spinner("dots", text="[blue]in_progress[/blue]", style="bold cyan")

# ---------------------------------------------------------------------------
# "TRADE BUDDY" logo — colours applied to the font in cli/static/welcome.txt.
# Rainbow gradient: green→yellow→red for TRADE, blue→cyan→violet→pink for BUDDY.
# ---------------------------------------------------------------------------
_LOGO_TRADE_COLORS = ["bright_green", "green3",    "yellow1", "dark_orange", "red1"]
_LOGO_BUDDY_COLORS = ["royal_blue1",  "sky_blue1", "blue1",   "medium_orchid1", "hot_pink"]

_WELCOME_TXT = Path(__file__).parent / "static" / "welcome.txt"


def _make_logo():
    """Read welcome.txt and apply per-letter rainbow colours.

    Uses background-column detection to map each character to its letter, then:
      █  (full block) → bold foreground in that letter's colour
      box-drawing     → dim foreground in same colour (outline)
      space           → plain space

    justify="left" is required — "center" strips leading spaces and breaks letter shapes.
    Returns Align.center(text) so the caller gets a centred renderable.
    """
    from rich.align import Align

    raw = _WELCOME_TXT.read_text("utf-8").splitlines()
    trade_lines = raw[0:6]
    buddy_lines = raw[7:13] if len(raw) > 12 else raw[7:]

    def _letter_ranges(lines: list[str]) -> list[tuple[int, int]]:
        """Column ranges for each letter — gaps are columns all-space in every row."""
        max_col = max(len(l) for l in lines) if lines else 0
        groups: list[tuple[int, int]] = []
        in_g = False
        start = 0
        for col in range(max_col + 1):  # +1 sentinel
            is_gap = all(col >= len(line) or line[col] == " " for line in lines)
            if not is_gap and not in_g:
                start = col
                in_g = True
            elif is_gap and in_g:
                groups.append((start, col))
                in_g = False
        return groups

    def _build(lines: list[str], colors: list[str]) -> Text:
        ranges = _letter_ranges(lines)

        def _color(col: int) -> str | None:
            for i, (s, e) in enumerate(ranges):
                if s <= col < e:
                    return colors[i] if i < len(colors) else None
            return None

        out = Text(justify="left", no_wrap=True)
        for line in lines:
            for col, ch in enumerate(line):
                c = _color(col)
                if ch == "█":
                    out.append(ch, style=f"bold {c}" if c else "bold")
                elif ch != " ":
                    out.append(ch, style=f"dim {c}" if c else "dim")
                else:
                    out.append(" ")
            out.append("\n")
        return out

    full = Text(justify="left", no_wrap=True)
    full.append_text(_build(trade_lines, _LOGO_TRADE_COLORS))
    full.append("\n")
    full.append_text(_build(buddy_lines, _LOGO_BUDDY_COLORS))
    return Align.center(full)


def create_layout():
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="main"),
        Layout(name="footer", size=3),
    )
    layout["main"].split_column(
        Layout(name="upper", ratio=3), Layout(name="analysis", ratio=5)
    )
    layout["upper"].split_row(
        Layout(name="progress", ratio=2), Layout(name="messages", ratio=3)
    )
    return layout


def format_tokens(n):
    """Format token count for display."""
    if n >= 1000:
        return f"{n/1000:.1f}k"
    return str(n)


# Tree-of-Thoughts chain rows in the researchers' reports are vertical
# fact→reasoning→conclusion chains, e.g.
#   [Fact: ...]
#   —>
#   [Reasoning: ...]
#   probability 72%
#   —>
#   [Conclusion: ...]
# We paint the thought brackets red, arrows yellow, and the probability cyan;
# everything else renders as normal Markdown.
_TOT_BRACKETS = ("[fact:", "[reasoning:", "[conclusion:")


def _is_tot_row(line: str) -> bool:
    s = line.strip().lower()
    return (
        s in ("—>", "->")
        or s.startswith(_TOT_BRACKETS)
        or s.startswith("probability")
    )


def _tot_row(line: str) -> Text:
    """Render one ToT chain row: thoughts red, arrows yellow, probability cyan."""
    s = line.strip()
    low = s.lower()
    if low in ("—>", "->"):
        return Text("        —>", style="bold yellow")
    if low.startswith("probability"):
        return Text(f"    {s}", style="cyan")
    return Text(f"  {s}", style="bold red")  # [Fact:/[Reasoning:/[Conclusion:


def _report_renderable(md: str):
    """Render report markdown, recolouring Tree-of-Thoughts chain rows.

    Contiguous non-ToT lines render through Rich's Markdown; ToT rows render as
    coloured Text so each fact/reasoning/conclusion step stands out and starts on
    its own line, per the CLI display spec.
    """
    if not md:
        return Markdown("")
    if "—>" not in md:
        return Markdown(md)
    blocks, buf = [], []

    def flush():
        if buf:
            blocks.append(Markdown("\n".join(buf)))
            buf.clear()

    for line in md.splitlines():
        if _is_tot_row(line):
            flush()
            blocks.append(_tot_row(line))
        else:
            buf.append(line)
    flush()
    return Group(*blocks)


def update_display(layout, spinner_text=None, stats_handler=None, start_time=None):
    # Header with welcome message
    layout["header"].update(
        Panel(
            "[bold green]Welcome to Trade Buddy CLI[/bold green]\n"
            "[dim]© [Tauric Research](https://github.com/TauricResearch)[/dim]",
            title="Welcome to Trade Buddy",
            border_style="green",
            padding=(1, 2),
            expand=True,
        )
    )

    # Progress panel showing agent status
    progress_table = Table(
        show_header=True,
        header_style="bold magenta",
        show_footer=False,
        box=box.SIMPLE_HEAD,  # Use simple header with horizontal lines
        title=None,  # Remove the redundant Progress title
        padding=(0, 2),  # Add horizontal padding
        expand=True,  # Make table expand to fill available space
    )
    progress_table.add_column("Team", style="cyan", justify="center", width=20)
    progress_table.add_column("Agent", style="green", justify="center", width=20)
    progress_table.add_column("Status", style="yellow", justify="center", width=20)

    # Group agents by team - filter to only include agents in agent_status
    all_teams = {
        "Analyst Team": [
            "Market Analyst",
            "Sentiment Analyst",
            "News Analyst",
            "Fundamentals Analyst",
        ],
        "Research Debate": ["Bull Researcher", "Bear Researcher"],
        "Judgment": ["Judge"],
    }

    # Filter teams to only include agents that are in agent_status
    teams = {}
    for team, agents in all_teams.items():
        active_agents = [a for a in agents if a in message_buffer.agent_status]
        if active_agents:
            teams[team] = active_agents

    for team, agents in teams.items():
        # Add first agent with team name
        first_agent = agents[0]
        status = message_buffer.agent_status.get(first_agent, "pending")
        if status == "in_progress":
            status_cell = _STATUS_SPINNER
        else:
            status_color = {
                "pending": "yellow",
                "completed": "green",
                "error": "red",
            }.get(status, "white")
            status_cell = f"[{status_color}]{status}[/{status_color}]"
        progress_table.add_row(team, first_agent, status_cell)

        # Add remaining agents in team
        for agent in agents[1:]:
            status = message_buffer.agent_status.get(agent, "pending")
            if status == "in_progress":
                status_cell = _STATUS_SPINNER
            else:
                status_color = {
                    "pending": "yellow",
                    "completed": "green",
                    "error": "red",
                }.get(status, "white")
                status_cell = f"[{status_color}]{status}[/{status_color}]"
            progress_table.add_row("", agent, status_cell)

        # Add horizontal line after each team
        progress_table.add_row("─" * 20, "─" * 20, "─" * 20, style="dim")

    layout["progress"].update(
        Panel(progress_table, title="Progress", border_style="cyan", padding=(1, 2))
    )

    # Messages panel showing recent messages and tool calls
    messages_table = Table(
        show_header=True,
        header_style="bold magenta",
        show_footer=False,
        expand=True,  # Make table expand to fill available space
        box=box.MINIMAL,  # Use minimal box style for a lighter look
        show_lines=True,  # Keep horizontal lines
        padding=(0, 1),  # Add some padding between columns
    )
    messages_table.add_column("Time", style="cyan", width=8, justify="center")
    messages_table.add_column("Type", style="green", width=10, justify="center")
    messages_table.add_column(
        "Content", style="white", no_wrap=False, ratio=1
    )  # Make content column expand

    # Combine tool calls and messages
    all_messages = []

    # Add tool calls
    for timestamp, tool_name, args in message_buffer.tool_calls:
        formatted_args = format_tool_args(args)
        all_messages.append((timestamp, "Tool", f"{tool_name}: {formatted_args}"))

    # Add regular messages
    for timestamp, msg_type, content in message_buffer.messages:
        content_str = str(content) if content else ""
        if len(content_str) > 200:
            content_str = content_str[:197] + "..."
        all_messages.append((timestamp, msg_type, content_str))

    # Sort by timestamp descending (newest first)
    all_messages.sort(key=lambda x: x[0], reverse=True)

    # Calculate how many messages we can show based on available space
    max_messages = 12

    # Get the first N messages (newest ones)
    recent_messages = all_messages[:max_messages]

    # Add messages to table (already in newest-first order)
    for timestamp, msg_type, content in recent_messages:
        # Format content with word wrapping
        wrapped_content = Text(content, overflow="fold")
        messages_table.add_row(timestamp, msg_type, wrapped_content)

    layout["messages"].update(
        Panel(
            messages_table,
            title="Messages & Tools",
            border_style="blue",
            padding=(1, 2),
        )
    )

    # Analysis panel showing current report
    if message_buffer.current_report:
        layout["analysis"].update(
            Panel(
                _report_renderable(message_buffer.current_report),
                title="Current Report",
                border_style="green",
                padding=(1, 2),
            )
        )
    else:
        layout["analysis"].update(
            Panel(
                "[italic]Waiting for analysis report...[/italic]",
                title="Current Report",
                border_style="green",
                padding=(1, 2),
            )
        )

    # Footer with statistics
    # Agent progress - derived from agent_status dict
    agents_completed = sum(
        1 for status in message_buffer.agent_status.values() if status == "completed"
    )
    agents_total = len(message_buffer.agent_status)

    # Report progress - based on agent completion (not just content existence)
    reports_completed = message_buffer.get_completed_reports_count()
    reports_total = len(message_buffer.report_sections)

    # Build stats parts
    stats_parts = [f"Agents: {agents_completed}/{agents_total}"]

    # LLM and tool stats from callback handler (optional)
    if stats_handler:
        stats = stats_handler.get_stats()
        stats_parts.append(f"LLM: {stats['llm_calls']}")
        stats_parts.append(f"Tools: {stats['tool_calls']}")

    # Live token tracker (cumulative across both model clients).
    if message_buffer.tokens_in or message_buffer.tokens_out:
        stats_parts.append(
            f"Tokens: {format_tokens(message_buffer.tokens_in)}\u2191 "
            f"{format_tokens(message_buffer.tokens_out)}\u2193"
        )
    else:
        stats_parts.append("Tokens: --")

    stats_parts.append(f"Reports: {reports_completed}/{reports_total}")

    # Elapsed time
    if start_time:
        elapsed = time.time() - start_time
        elapsed_str = f"\u23f1 {int(elapsed // 60):02d}:{int(elapsed % 60):02d}"
        stats_parts.append(elapsed_str)

    stats_table = Table(show_header=False, box=None, padding=(0, 2), expand=True)
    stats_table.add_column("Stats", justify="center")
    stats_table.add_row(" | ".join(stats_parts))

    layout["footer"].update(Panel(stats_table, border_style="grey50"))


def get_user_selections():
    """Get all user selections before starting the analysis display."""
    logo = _make_logo()
    tagline = (
        "\n[bold green]Trade Buddy: Multi-Agent LLM Financial Analysis — CLI[/bold green]\n\n"
        "[bold]Workflow:[/bold] "
        "Analysts → Bull/Bear Tree-of-Thoughts → Debate → Judge Verdict\n\n"
        "[dim]Built by [link=https://github.com/TauricResearch]Tauric Research[/link][/dim]"
    )
    welcome_box = Panel(
        Group(logo, tagline),
        border_style="green",
        padding=(1, 2),
        title="[bold green]✦ Welcome to Trade Buddy ✦[/bold green]",
        subtitle="Multi-Agent LLM Financial Analysis",
    )
    console.print(Align.center(welcome_box))
    console.print()
    console.print()  # Add vertical space before announcements

    # Fetch and display announcements (silent on failure)
    announcements = fetch_announcements()
    display_announcements(console, announcements)

    # Create a boxed questionnaire for each step
    def create_question_box(title, prompt, default=None):
        box_content = f"[bold]{title}[/bold]\n"
        box_content += f"[dim]{prompt}[/dim]"
        if default:
            box_content += f"\n[dim]Default: {default}[/dim]"
        return Panel(box_content, border_style="blue", padding=(1, 2))

    # Step 1: Ticker symbol
    console.print(
        create_question_box(
            "Step 1: Ticker Symbol",
            "Enter the exact ticker symbol to analyze, including exchange suffix when needed (examples: SPY, CNC.TO, 7203.T, 0700.HK)",
            "SPY",
        )
    )
    selected_ticker = get_ticker()
    asset_type = detect_asset_type(selected_ticker)
    console.print(
        f"[green]Detected asset type:[/green] {asset_type.value}"
    )

    # Step 2: Analysis date
    default_date = datetime.datetime.now().strftime("%Y-%m-%d")
    console.print(
        create_question_box(
            "Step 2: Analysis Date",
            "Enter the analysis date (YYYY-MM-DD)",
            default_date,
        )
    )
    analysis_date = get_analysis_date()

    # Step 3: Output language
    console.print(
        create_question_box(
            "Step 3: Output Language",
            "Select the language for analyst reports and final decision"
        )
    )
    output_language = ask_output_language()

    # Step 4: Select analysts
    console.print(
        create_question_box(
            "Step 4: Analysts Team", "Select your LLM analyst agents for the analysis"
        )
    )
    selected_analysts = select_analysts(asset_type)
    console.print(
        f"[green]Selected analysts:[/green] {', '.join(analyst.value for analyst in selected_analysts)}"
    )

    # Step 5: Research depth
    console.print(
        create_question_box(
            "Step 5: Research Depth", "Select your research depth level"
        )
    )
    selected_research_depth = select_research_depth()

    # Step 6: LLM Provider
    console.print(
        create_question_box(
            "Step 6: LLM Provider", "Select your LLM provider"
        )
    )
    selected_llm_provider, backend_url = select_llm_provider()

    # For Ollama, surface the resolved endpoint (OLLAMA_BASE_URL vs default)
    # before model selection so it's obvious where we're connecting.
    if selected_llm_provider == "ollama":
        confirm_ollama_endpoint(backend_url)

    # Confirm the provider's API key is present; prompt the user to paste
    # one and persist it to .env if it's missing, so the analysis run
    # doesn't fail later at the first API call.
    ensure_api_key(selected_llm_provider)

    # Step 7: Thinking agents
    console.print(
        create_question_box(
            "Step 7: Thinking Agents", "Select your thinking agents for analysis"
        )
    )
    selected_shallow_thinker = select_shallow_thinking_agent(selected_llm_provider)
    # OpenRouter has a single model pool — no distinction between quick and deep.
    # Reuse the selection instead of prompting the user twice.
    if selected_llm_provider.lower() == "openrouter":
        selected_deep_thinker = selected_shallow_thinker
    else:
        selected_deep_thinker = select_deep_thinking_agent(selected_llm_provider)

    return {
        "ticker": selected_ticker,
        "asset_type": asset_type.value,
        "analysis_date": analysis_date,
        "analysts": selected_analysts,
        "research_depth": selected_research_depth,
        "llm_provider": selected_llm_provider.lower(),
        "backend_url": backend_url,
        "shallow_thinker": selected_shallow_thinker,
        "deep_thinker": selected_deep_thinker,
        "output_language": output_language,
    }


def get_ticker():
    """Get ticker symbol from user input, preserving exchange suffixes."""
    # typer.prompt strips trailing dot-suffixes on some shells (e.g. 000404.SH
    # collapses to 000404). questionary.text reads the raw line.
    ticker = questionary.text(
        "",
        validate=lambda value: (
            not value.strip()
            or (
                all(ch.isalnum() or ch in "._-^" for ch in value.strip())
                and len(value.strip()) <= 32
            )
        )
        or "Please enter a valid ticker symbol, e.g. AAPL, 000404.SZ, 0700.HK.",
    ).ask()

    if ticker is None:
        console.print("\n[red]No ticker symbol provided. Exiting...[/red]")
        raise typer.Exit(1)

    return (ticker.strip() or "SPY").upper()


def get_analysis_date():
    """Get the analysis date from user input."""
    while True:
        date_str = typer.prompt(
            "", default=datetime.datetime.now().strftime("%Y-%m-%d")
        )
        try:
            # Validate date format and ensure it's not in the future
            analysis_date = datetime.datetime.strptime(date_str, "%Y-%m-%d")
            if analysis_date.date() > datetime.datetime.now().date():
                console.print("[red]Error: Analysis date cannot be in the future[/red]")
                continue
            return date_str
        except ValueError:
            console.print(
                "[red]Error: Invalid date format. Please use YYYY-MM-DD[/red]"
            )


def save_report_to_disk(final_state, ticker: str, save_path: Path):
    """Save complete analysis report to disk with organized subfolders."""
    save_path.mkdir(parents=True, exist_ok=True)
    sections = []

    # 1. Analysts
    analysts_dir = save_path / "1_analysts"
    analyst_parts = []
    if final_state.get("market_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "market.md").write_text(final_state["market_report"], encoding="utf-8")
        analyst_parts.append(("Market Analyst", final_state["market_report"]))
    if final_state.get("sentiment_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "sentiment.md").write_text(final_state["sentiment_report"], encoding="utf-8")
        analyst_parts.append(("Sentiment Analyst", final_state["sentiment_report"]))
    if final_state.get("news_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "news.md").write_text(final_state["news_report"], encoding="utf-8")
        analyst_parts.append(("News Analyst", final_state["news_report"]))
    if final_state.get("fundamentals_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "fundamentals.md").write_text(final_state["fundamentals_report"], encoding="utf-8")
        analyst_parts.append(("Fundamentals Analyst", final_state["fundamentals_report"]))
    if analyst_parts:
        content = "\n\n".join(f"### {name}\n{text}" for name, text in analyst_parts)
        sections.append(f"## I. Analyst Team Reports\n\n{content}")

    # 2. Research Debate (Tree-of-Thoughts bull/bear)
    research_parts = []
    if final_state.get("bull_case_md") or final_state.get("bear_case_md"):
        research_dir = save_path / "2_research"
        research_dir.mkdir(exist_ok=True)
        if final_state.get("bull_case_md"):
            (research_dir / "bull.md").write_text(final_state["bull_case_md"], encoding="utf-8")
            research_parts.append(("Bull Researcher", final_state["bull_case_md"]))
        if final_state.get("bear_case_md"):
            (research_dir / "bear.md").write_text(final_state["bear_case_md"], encoding="utf-8")
            research_parts.append(("Bear Researcher", final_state["bear_case_md"]))
        if research_parts:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in research_parts)
            sections.append(f"## II. Research Debate\n\n{content}")

    # 2b. Live bull/bear debate transcript + consensus outcome
    if final_state.get("debate_md"):
        research_dir = save_path / "2_research"
        research_dir.mkdir(exist_ok=True)
        (research_dir / "debate.md").write_text(final_state["debate_md"], encoding="utf-8")
        sections.append(f"## II-b. Bull vs. Bear Debate\n\n{final_state['debate_md']}")

    # 3. Judge Verdict & Scoreboard (the sole final decision)
    if final_state.get("judge_verdict_md"):
        judge_dir = save_path / "3_judge"
        judge_dir.mkdir(exist_ok=True)
        (judge_dir / "verdict.md").write_text(final_state["judge_verdict_md"], encoding="utf-8")
        sections.append(f"## III. Judge Verdict & Scoreboard\n\n{final_state['judge_verdict_md']}")

    # Write consolidated report
    header = f"# Trading Analysis Report: {ticker}\n\nGenerated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    (save_path / "complete_report.md").write_text(header + "\n\n".join(sections), encoding="utf-8")
    return save_path / "complete_report.md"


def display_complete_report(final_state):
    """Display the complete analysis report sequentially (avoids truncation)."""
    console.print()
    console.print(Rule("Complete Analysis Report", style="bold green"))

    # I. Analyst Team Reports
    analysts = []
    if final_state.get("market_report"):
        analysts.append(("Market Analyst", final_state["market_report"]))
    if final_state.get("sentiment_report"):
        analysts.append(("Sentiment Analyst", final_state["sentiment_report"]))
    if final_state.get("news_report"):
        analysts.append(("News Analyst", final_state["news_report"]))
    if final_state.get("fundamentals_report"):
        analysts.append(("Fundamentals Analyst", final_state["fundamentals_report"]))
    if analysts:
        console.print(Panel("[bold]I. Analyst Team Reports[/bold]", border_style="cyan"))
        for title, content in analysts:
            console.print(Panel(Markdown(content), title=title, border_style="blue", padding=(1, 2)))

    # II. Research Debate (Tree-of-Thoughts bull/bear)
    research = []
    if final_state.get("bull_case_md"):
        research.append(("Bull Researcher", final_state["bull_case_md"]))
    if final_state.get("bear_case_md"):
        research.append(("Bear Researcher", final_state["bear_case_md"]))
    if research:
        console.print(Panel("[bold]II. Research Debate[/bold]", border_style="magenta"))
        for title, content in research:
            console.print(Panel(_report_renderable(content), title=title, border_style="blue", padding=(1, 2)))

    # II-b. Bull vs. Bear debate transcript + consensus
    if final_state.get("debate_md"):
        console.print(Panel("[bold]II-b. Bull vs. Bear Debate[/bold]", border_style="magenta"))
        console.print(Panel(_report_renderable(final_state["debate_md"]), title="Debate", border_style="blue", padding=(1, 2)))

    # III. Judge Verdict & Scoreboard (final decision)
    if final_state.get("judge_verdict_md"):
        console.print(Panel("[bold]III. Judge Verdict & Scoreboard[/bold]", border_style="green"))
        console.print(Panel(Markdown(final_state["judge_verdict_md"]), title="Judge", border_style="blue", padding=(1, 2)))


def update_research_team_status(status):
    """Update status for the bull/bear researchers."""
    for agent in ("Bull Researcher", "Bear Researcher"):
        message_buffer.update_agent_status(agent, status)


# Ordered list of analysts for status transitions
ANALYST_ORDER = ["market", "social", "news", "fundamentals"]


def format_tool_args(args, max_length=80) -> str:
    """Format tool arguments for terminal display."""
    result = str(args)
    if len(result) > max_length:
        return result[:max_length - 3] + "..."
    return result

def run_analysis():
    # First get all user selections
    selections = get_user_selections()

    # Create config with selected research depth
    config = DEFAULT_CONFIG.copy()
    config["max_debate_rounds"] = selections["research_depth"]
    config["max_risk_discuss_rounds"] = selections["research_depth"]
    config["quick_think_llm"] = selections["shallow_thinker"]
    config["deep_think_llm"] = selections["deep_thinker"]
    config["backend_url"] = selections["backend_url"]
    config["llm_provider"] = selections["llm_provider"].lower()
    config["output_language"] = selections.get("output_language", "English")

    # Normalize analyst selection to predefined order (selection is a 'set', order is fixed)
    selected_set = {analyst.value for analyst in selections["analysts"]}
    selected_analyst_keys = [a for a in ANALYST_ORDER if a in selected_set]

    # Initialize the AutoGen pipeline.
    graph = TradingAgentsGraph(selected_analyst_keys, config=config, debug=False)

    # Initialize message buffer with selected analysts
    message_buffer.init_for_analysis(selected_analyst_keys)

    # Track start time for elapsed display
    start_time = time.time()

    # Create result directory
    results_dir = Path(config["results_dir"]) / selections["ticker"] / selections["analysis_date"]
    results_dir.mkdir(parents=True, exist_ok=True)

    # Now start the display layout
    layout = create_layout()

    final_state = {}
    decision = None
    # screen=True runs the dashboard in the terminal's *alternate screen buffer*
    # (like vim/less). This is the fix for the stacked "Welcome to ..." frames:
    # the full-height layout can't always be overwritten in place, so Rich was
    # spilling whole frames into the scrollback. The alternate buffer is redrawn
    # in place and discarded on exit, so nothing piles up in history. Rich's
    # background auto-refresh repaints it (the persistent spinner keeps animating
    # and the clock keeps ticking); the worker loop below only mutates state.
    with Live(layout, console=console, refresh_per_second=10, screen=True) as live:
        update_display(layout, start_time=start_time)

        message_buffer.add_message("System", f"Selected ticker: {selections['ticker']}")
        message_buffer.add_message("System", f"Detected asset type: {selections['asset_type']}")
        message_buffer.add_message("System", f"Analysis date: {selections['analysis_date']}")
        message_buffer.add_message(
            "System",
            f"Selected analysts: {', '.join(analyst.value for analyst in selections['analysts'])}",
        )
        message_buffer.add_message(
            "System", f"Analyzing {selections['ticker']} on {selections['analysis_date']}..."
        )
        update_display(layout, start_time=start_time)

        # Map each finishing agent to the report section it produces, so the
        # live "Current Report" panel fills in as the run progresses.
        section_by_agent = {
            agent: section
            for section, (_key, agent) in MessageBuffer.REPORT_SECTIONS.items()
        }

        # The orchestrator drives this callback as each stage starts/finishes.
        # It only mutates state — the main render loop below repaints the screen
        # so the elapsed clock keeps ticking even while one agent runs for minutes.
        def on_event(stage, status, content=None, meta=None):
            meta = meta or {}
            if status == "usage":
                message_buffer.tokens_in = meta.get("tokens_in", message_buffer.tokens_in)
                message_buffer.tokens_out = meta.get("tokens_out", message_buffer.tokens_out)
                return
            if status == "debate":
                # One alternating debate turn; show it live and accumulate it.
                side = meta.get("side", "?").title()
                rnd, rounds = meta.get("round", "?"), meta.get("rounds", "?")
                message_buffer.add_message(
                    "Debate", f"{side} R{rnd}/{rounds}: {meta.get('summary', '')}"
                )
                if content:
                    message_buffer.debate_md += (("\n\n" if message_buffer.debate_md else "") + content)
                    message_buffer.update_report_section("debate_md", message_buffer.debate_md)
                return
            if status == "consensus":
                reached = meta.get("consensus_reached")
                message_buffer.add_message(
                    "Debate", "Consensus reached ✓" if reached else "No consensus — Judge decides ⚖️"
                )
                if content:
                    message_buffer.debate_md += (("\n\n" if message_buffer.debate_md else "") + content)
                    message_buffer.update_report_section("debate_md", message_buffer.debate_md)
                return

            message_buffer.update_agent_status(stage, status)
            if status == "in_progress":
                message_buffer.add_message("Agent", f"{stage} working...")
            elif status == "completed":
                message_buffer.add_message("Agent", f"{stage} done")
                section = section_by_agent.get(stage)
                if section and content:
                    message_buffer.update_report_section(section, content)

        # Run the (blocking) pipeline on a worker thread; repaint at ~5 fps from
        # here so the timer advances and live status/content stream in smoothly.
        holder, failure = {}, {}

        def _worker():
            try:
                holder["result"] = graph.propagate(
                    selections["ticker"],
                    selections["analysis_date"],
                    asset_type=selections["asset_type"],
                    on_event=on_event,
                )
            except Exception as exc:  # surface in the main thread after the loop
                failure["exc"] = exc

        worker = threading.Thread(target=_worker, daemon=True)
        worker.start()
        # Refresh the layout contents a few times a second; Rich's auto-refresh
        # thread paints them in place so the timer advances and status streams in.
        while worker.is_alive():
            update_display(layout, start_time=start_time)
            time.sleep(0.2)
        worker.join()
        update_display(layout, start_time=start_time)

        if "exc" in failure:
            raise failure["exc"]
        final_state, decision = holder["result"]

        # Populate report sections from the final state for display + saving.
        for section in message_buffer.report_sections.keys():
            if final_state.get(section):
                message_buffer.update_report_section(section, final_state[section])

        # Mark everything completed.
        for agent in message_buffer.agent_status:
            message_buffer.update_agent_status(agent, "completed")

        message_buffer.add_message(
            "System", f"Completed analysis for {selections['analysis_date']} — decision: {decision}"
        )
        update_display(layout, start_time=start_time)

    # Post-analysis prompts (outside Live context for clean interaction)
    console.print("\n[bold cyan]Analysis Complete![/bold cyan]\n")
    console.print(f"[bold]Decision:[/bold] {decision}")

    # Prompt to save report
    save_choice = typer.prompt("Save report?", default="Y").strip().upper()
    if save_choice in ("Y", "YES", ""):
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        default_path = Path.cwd() / "reports" / f"{selections['ticker']}_{timestamp}"
        save_path_str = typer.prompt(
            "Save path (press Enter for default)",
            default=str(default_path)
        ).strip()
        save_path = Path(save_path_str)
        try:
            report_file = save_report_to_disk(final_state, selections["ticker"], save_path)
            console.print(f"\n[green]✓ Report saved to:[/green] {save_path.resolve()}")
            console.print(f"  [dim]Complete report:[/dim] {report_file.name}")
        except Exception as e:
            console.print(f"[red]Error saving report: {e}[/red]")

    # Prompt to display full report
    display_choice = typer.prompt("\nDisplay full report on screen?", default="Y").strip().upper()
    if display_choice in ("Y", "YES", ""):
        display_complete_report(final_state)


@app.command()
def analyze():
    run_analysis()


if __name__ == "__main__":
    app()
