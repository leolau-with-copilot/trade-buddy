"""Small prompt helpers shared by the AutoGen agents.

Trimmed in the AutoGen migration: the old LangChain message/tool helpers
(``create_msg_delete`` and the ``@tool`` re-exports) are gone — tools now live in
:mod:`tradingagents.autogen_clients.tools`. Only the two prompt helpers the new
pipeline uses remain here.
"""

from __future__ import annotations


# Native-script names anchor the model far more strongly than the English label
# alone — naming the target language in its own writing system sharply cuts the
# English leakage we saw bleed into the final report.
_LANGUAGE_NATIVE = {
    "simplified chinese": "简体中文（Simplified Chinese）",
    "traditional chinese": "繁體中文（Traditional Chinese）",
    "chinese": "中文（Chinese）",
    "french": "français（French）",
    "spanish": "español（Spanish）",
    "german": "Deutsch（German）",
    "japanese": "日本語（Japanese）",
    "korean": "한국어（Korean）",
}


def get_language_instruction() -> str:
    """Return a prompt instruction for the configured output language.

    Returns empty string when English (default), so no extra tokens are used.
    Applied to every agent whose output reaches the saved report so a non-English
    run produces a fully localized report rather than a mix of languages.

    The instruction is deliberately forceful: a soft "write in X" lets the model
    drift back to English mid-report (especially when echoing English tool data),
    so we spell out that *every* token — headings, table cells, labels, summary —
    must be in the target language, and that English source data must be translated.
    """
    from tradingagents.dataflows.config import get_config

    lang = get_config().get("output_language", "English")
    if lang.strip().lower() == "english":
        return ""
    native = _LANGUAGE_NATIVE.get(lang.strip().lower(), lang)
    return (
        f" CRITICAL OUTPUT-LANGUAGE REQUIREMENT: Write 100% of your response in "
        f"{native}. EVERY sentence, heading, bullet, table header, table cell, "
        f"label, and the final summary/recommendation must be in {native}. Do NOT "
        f"emit English prose anywhere in your answer — the only English allowed is "
        f"ticker symbols (e.g. AAPL), numbers, and proper nouns with no accepted "
        f"translation. If the data, tool results, or prior messages you are given "
        f"are in English, translate their meaning into {native} rather than copying "
        f"the English. This rule overrides any English wording in these instructions."
    )


def build_instrument_context(ticker: str, asset_type: str = "stock") -> str:
    """Describe the exact instrument so agents preserve exchange-qualified tickers."""
    instrument_label = "asset" if asset_type == "crypto" else "instrument"
    extra_hint = (
        " Treat it as a crypto asset rather than a company, and do not assume "
        "company fundamentals are available."
        if asset_type == "crypto"
        else ""
    )
    return (
        f"The {instrument_label} to analyze is `{ticker}`. "
        "Use this exact ticker in every tool call, report, and recommendation, "
        "preserving any exchange suffix (e.g. `.TO`, `.L`, `.HK`, `.T`, `-USD`)."
        + extra_hint
    )
