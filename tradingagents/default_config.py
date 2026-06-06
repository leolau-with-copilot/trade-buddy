import os

_TRADINGAGENTS_HOME = os.path.join(os.path.expanduser("~"), ".tradingagents")

# Single source of truth for env-var → config-key overrides. To expose
# a new config key for environment-based override, add a row here — no
# entry-point script changes required. Coercion is driven by the type
# of the existing default, so users can keep writing plain strings in
# their .env file.
_ENV_OVERRIDES = {
    "TRADINGAGENTS_LLM_PROVIDER":         "llm_provider",
    "TRADINGAGENTS_DEEP_THINK_LLM":       "deep_think_llm",
    "TRADINGAGENTS_QUICK_THINK_LLM":      "quick_think_llm",
    "TRADINGAGENTS_LLM_BACKEND_URL":      "backend_url",
    "TRADINGAGENTS_OUTPUT_LANGUAGE":      "output_language",
    "TRADINGAGENTS_MAX_DEBATE_ROUNDS":    "max_debate_rounds",
    "TRADINGAGENTS_MAX_RISK_ROUNDS":      "max_risk_discuss_rounds",
    "TRADINGAGENTS_CHECKPOINT_ENABLED":   "checkpoint_enabled",
    "TRADINGAGENTS_BENCHMARK_TICKER":     "benchmark_ticker",
    "TRADINGAGENTS_TOT_BREADTH":          "tot_breadth",
    "TRADINGAGENTS_TOT_DEPTH":            "tot_depth",
    "TRADINGAGENTS_TOT_KEEP":             "tot_keep",
    "TRADINGAGENTS_WINRATE_HORIZON_DAYS": "winrate_horizon_days",
    "TRADINGAGENTS_WINRATE_LOOKBACK_YEARS": "winrate_lookback_years",
}


def _coerce(value: str, reference):
    """Coerce env-var string to the type of the existing default value."""
    if isinstance(reference, bool):
        return value.strip().lower() in ("true", "1", "yes", "on")
    if isinstance(reference, int) and not isinstance(reference, bool):
        return int(value)
    if isinstance(reference, float):
        return float(value)
    return value


def _apply_env_overrides(config: dict) -> dict:
    """Apply TRADINGAGENTS_* env vars to the config dict in-place."""
    for env_var, key in _ENV_OVERRIDES.items():
        raw = os.environ.get(env_var)
        if raw is None or raw == "":
            continue
        config[key] = _coerce(raw, config.get(key))
    return config


DEFAULT_CONFIG = _apply_env_overrides({
    "project_dir": os.path.abspath(os.path.join(os.path.dirname(__file__), ".")),
    "results_dir": os.getenv("TRADINGAGENTS_RESULTS_DIR", os.path.join(_TRADINGAGENTS_HOME, "logs")),
    "data_cache_dir": os.getenv("TRADINGAGENTS_CACHE_DIR", os.path.join(_TRADINGAGENTS_HOME, "cache")),
    "memory_log_path": os.getenv("TRADINGAGENTS_MEMORY_LOG_PATH", os.path.join(_TRADINGAGENTS_HOME, "memory", "trading_memory.md")),
    # Optional cap on the number of resolved memory log entries. When set,
    # the oldest resolved entries are pruned once this limit is exceeded.
    # Pending entries are never pruned. None disables rotation entirely.
    "memory_log_max_entries": None,
    # LLM settings. This build targets DeepSeek only (AutoGen 0.4 over DeepSeek's
    # OpenAI-compatible endpoint). deep_think -> the stronger reasoning model
    # (Tree-of-Thoughts researchers + Judge reasoning); quick_think -> the fast
    # tool-using model (analysts + Judge tool turns). The v4 family is both
    # tool-capable and thinking, so both roles use v4 now (v3 ids still work if
    # set via env: deepseek-reasoner / deepseek-chat).
    "llm_provider": "deepseek",
    "deep_think_llm": "deepseek-v4-pro",
    "quick_think_llm": "deepseek-v4-flash",
    # When None, each provider's client falls back to its own default endpoint
    # (api.openai.com for OpenAI, generativelanguage.googleapis.com for Gemini, ...).
    # The CLI overrides this per provider when the user picks one. Keeping a
    # provider-specific URL here would leak (e.g. OpenAI's /v1 was previously
    # being forwarded to Gemini, producing malformed request URLs).
    "backend_url": None,
    # Provider-specific thinking configuration
    "google_thinking_level": None,      # "high", "minimal", etc.
    "openai_reasoning_effort": None,    # "medium", "high", "low"
    "anthropic_effort": None,           # "high", "medium", "low"
    # Checkpoint/resume: when True, LangGraph saves state after each node
    # so a crashed run can resume from the last successful step.
    "checkpoint_enabled": False,
    # Output language for analyst reports and final decision
    # Internal agent debate stays in English for reasoning quality
    "output_language": "English",
    # Debate and discussion settings
    "max_debate_rounds": 1,            # bull/bear Tree-of-Thoughts rounds
    "max_risk_discuss_rounds": 1,      # retained for back-compat; risk team removed
    "max_recur_limit": 100,
    "analyst_concurrency_limit": 1,
    # Tree-of-Thoughts search shape for the bull/bear researchers. Each thought
    # is self-examined (likelihood + critique) and the synthesis is weighted by
    # those likelihoods.
    "tot_breadth": 4,                  # candidate thoughts generated per expansion
    "tot_depth": 1,                    # extra expansion rounds after generation
    "tot_keep": 3,                     # top thoughts kept each round / fed to synthesis
    # Technical win-rate backtest (the researchers' "technical intuition").
    "winrate_horizon_days": 5,         # forward window for measuring a signal's hit
    "winrate_lookback_years": 3,       # how far back to count signal occurrences
    # SQLite dataset of analyses/scoreboards/outcomes. None => under data_cache_dir.
    "analysis_store_path": None,
    # Optional local copy of the Kadoa congressional dataset (the downloaded
    # ``congress-trading-monitor-main/public/data`` folder) used as an offline
    # fallback when congress.kadoa.com is unreachable. None => auto-detect the
    # bundled folder near the project root, else live-only.
    "congress_data_dir": None,
    # News / data fetching parameters
    # Increase for longer lookback strategies or to broaden macro coverage;
    # decrease to reduce token usage in agent prompts.
    "news_article_limit": 20,             # max articles per ticker (ticker-news)
    "global_news_article_limit": 10,      # max articles for global/macro news
    "global_news_lookback_days": 7,       # macro news lookback window
    # Search queries used by get_global_news for macro headlines. Extend or
    # replace to broaden geographic / sector coverage.
    "global_news_queries": [
        "Federal Reserve interest rates inflation",
        "S&P 500 earnings GDP economic outlook",
        "geopolitical risk trade war sanctions",
        "ECB Bank of England BOJ central bank policy",
        "oil commodities supply chain energy",
    ],
    # Data vendor configuration
    # Category-level configuration (default for all tools in category)
    # China A-share symbols are auto-routed to AKShare regardless of these
    # settings (see interface._auto_vendor_override). Set a comma-separated list
    # like "finnhub,yfinance" to prefer one vendor with another as fallback.
    # macro_data uses FRED (keyless, or FRED_API_KEY for the API).
    "data_vendors": {
        "core_stock_apis": "yfinance",
        "technical_indicators": "yfinance",
        "fundamental_data": "yfinance",
        # Finnhub first (rich company news when FINNHUB_API_KEY is set), with
        # yfinance as automatic fallback when Finnhub has no key/coverage.
        "news_data": "finnhub,yfinance",
        "macro_data": "fred",
        "filings": "sec",
        # "Smart money" flow — see the per-tool overrides below for the source
        # chains (insider vs. congressional use different vendors).
        "smart_money": "openinsider",
    },
    # Tool-level configuration (takes precedence over category-level)
    "tool_vendors": {
        # Corporate insiders: OpenInsider (Form 4 scrape) first, then Finnhub
        # JSON (needs FINNHUB_API_KEY), then yfinance.
        "get_insider_transactions": "openinsider,finnhub,yfinance",
        # Congress: Kadoa open STOCK Act dataset (keyless, live JSON from
        # congress.kadoa.com, with a local-file fallback).
        "get_congress_trading": "kadoa",
    },
    # Benchmark for alpha calculation in the reflection layer.
    # ``benchmark_ticker`` (when set) overrides the suffix map for all
    # tickers; leave it None to use ``benchmark_map`` for auto-detection
    # based on the ticker's exchange suffix. SPY remains the US default
    # so the reflection label keeps reading "Alpha vs SPY" for US tickers
    # while non-US tickers get their regional index automatically.
    "benchmark_ticker": None,
    "benchmark_map": {
        ".NS":  "^NSEI",    # NSE India (Nifty 50)
        ".BO":  "^BSESN",   # BSE India (Sensex)
        ".T":   "^N225",    # Tokyo (Nikkei 225)
        ".HK":  "^HSI",     # Hong Kong (Hang Seng)
        ".L":   "^FTSE",    # London (FTSE 100)
        ".TO":  "^GSPTSE",  # Toronto (TSX Composite)
        ".AX":  "^AXJO",    # Australia (ASX 200)
        "":     "SPY",      # default for US-listed tickers (no suffix)
    },
})
