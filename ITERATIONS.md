# Iteration Log

记录这个多 Agent 策划器的每次开发迭代，方便回顾改动、问题和下一步计划。

## v0.1 - 2026-04-25

### Goal
- 搭建第一版 AutoGen 多 Agent MVP，支持会议方案与活动策划方案生成。

### Changes
- 新增 `meeting_agents.py`：主流程编排，串联 4 个 Agent。
- 新增 `prompts.py`：拆分需求分析、方案策划、风险检查、汇总输出 4 类系统提示词。
- 新增 `sample_input.json`：提供一个会议场景示例输入。
- 新增 `requirements.txt`：列出 AutoGen 所需依赖。
- 更新 `main.py`：作为 CLI 入口运行主程序。
- 约定输出到 `outputs/`，同时保存 Markdown 和 JSON 两种结果。

### Current Workflow
1. 用户提交 JSON 输入
2. Planner Agent 提炼目标与约束
3. Designer Agent 生成策划方案
4. Risk Agent 审查风险
5. Synthesizer Agent 汇总最终结果

### Known Limitations
- 目前只支持顺序编排，不支持 Agent 自由讨论或自动反复修订。
- 依赖 `OPENAI_API_KEY`，尚未加入本地 mock 模式。
- 尚未接入资料库、会议纪要、日历或数据库存储。

### Next Iteration Ideas
- 增加 `activity` 专用模板。
- 增加输出结构校验和失败重试。
- 增加 Web/API 接口。
- 增加历史任务归档和版本追踪。

## v0.2 - 2026-04-25

### Goal
- 将默认模型接入从 OpenAI 切换为 DeepSeek，便于当前环境直接测试。

### Changes
- `meeting_agents.py` 新增 `--provider` 与 `--base-url` 参数。
- 默认 provider 改为 `deepseek`。
- 默认模型改为 `deepseek-v4-flash`。
- 新增 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 环境变量支持，并兼容回退到 `OPENAI_*`。
- 增加更明确的中文错误提示，便于排查连接问题。

### How To Run
```bash
export DEEPSEEK_API_KEY=你的key
python main.py --input sample_input.json
```

如需显式指定接口地址：

```bash
python main.py --input sample_input.json --base-url https://api.deepseek.com
```

## v0.3 - 2026-04-25

### Goal
- 修复 DeepSeek 通过 AutoGen 调用时的 `model_info` 校验错误。

### Changes
- 在 `meeting_agents.py` 中为 DeepSeek 增加默认 `model_info`。
- 使用 `ModelFamily.UNKNOWN` 作为 DeepSeek 的兼容模型族，避免被误判为无效 OpenAI 模型名。
- 保持 OpenAI provider 逻辑不变。

### Fixes
- 修复报错：`model_info is required when model name is not a valid OpenAI model`

## v0.4 - 2026-04-25

### Goal
- 将系统重构为三阶段活动策划流程：先策划筹备会议，再由多 Agent 开会，最后输出活动策划书。

### Changes
- 重写 `prompts.py`，从“会议/活动通用”改为“三阶段活动策划”导向。
- 重构 `meeting_agents.py`：
  1. 阶段 1：生成内部活动筹备会议方案
  2. 阶段 2：使用 `RoundRobinGroupChat` 让多个角色 Agent 讨论
  3. 阶段 3：汇总输出最终活动策划书
- 新增多角色讨论角色：总策划、执行统筹、宣传传播、预算与风险、主持收敛。
- 新增 `--discussion-turns` 参数，支持控制多 Agent 讨论轮次。
- 将 `sample_input.json` 改为活动策划示例。

### Current Product Direction
- 最终交付物：活动策划书
- 中间推理层：筹备会议方案 + 多 Agent 讨论
- 不再把“会议纪要”作为最终目标

### Next Iteration Ideas
- 为不同活动类型增加模板（分享会、宣讲会、培训、比赛）。
- 增加结构化 JSON 输出校验。
- 增加 Web 表单或 API 接口。

## v0.5 - 2026-04-25

### Goal
- 为三阶段多 Agent 活动策划器补充一个可视化前端系统。

### Changes
- 新增 `webapp.py`：使用 FastAPI 暴露 Web API，并托管静态前端页面。
- 新增 `frontend/index.html`：搭建深色科技感的控制台页面。
- 新增 `frontend/styles.css`：实现玻璃拟态、霓虹高光、阶段流转等视觉效果。
- 新增 `frontend/app.js`：连接表单输入、调用 `/api/generate`、展示三阶段结果和 Agent 发言卡片。
- `meeting_agents.py` 新增 `planning_input_from_dict()`，便于 API 直接接收 JSON 输入。
- `requirements.txt` 增加 `fastapi` 与 `uvicorn`。

### How To Run
```bash
pip install -r requirements.txt
export DEEPSEEK_API_KEY=你的key
uvicorn webapp:app --reload
```

浏览器打开：

```text
http://127.0.0.1:8000
```

## v0.6 - 2026-04-25

### Goal
- 将前端升级为更接近“3D 科技驾驶舱”的风格，并补充流式输出、Markdown 渲染、导出和历史任务能力。

### Changes
- `meeting_agents.py`
  - 抽出阶段函数：筹备会议生成、讨论执行、最终汇总。
  - 新增 `generate_plan_with_events()`，可逐阶段发出事件。
  - `run_discussion()` 改为基于 `run_stream()` 收集并实时回调 Agent 发言。
- `webapp.py`
  - 新增 `/api/generate-stream`，使用 NDJSON 流式返回阶段结果和讨论消息。
- `frontend/index.html`
  - 重构为“驾驶舱”布局，增加虚拟 Agent 舱室、导出按钮、历史任务面板。
- `frontend/styles.css`
  - 增加 3D 卡片感、全局星空背景、霓虹光效、Agent 发光状态。
- `frontend/app.js`
  - 接入流式生成接口。
  - 增加 Markdown 渲染、逐字显示效果、复制/导出、localStorage 历史任务。
  - 增加 Agent 高亮与阶段状态联动。

### Current UX Highlights
- 实时显示阶段进度与 Agent 发言
- 3D 风格虚拟 Agent 卡片
- 最终策划书 Markdown 富展示
- 一键导出 Markdown / PDF
- 历史任务回放

## v0.7 - 2026-04-25

### Goal
- 让多 Agent 讨论更像真实开会：不再机械轮流，而是根据冲突动态选择发言者。

### Changes
- `meeting_agents.py`
  - 将讨论团队从 `RoundRobinGroupChat` 升级为 `SelectorGroupChat`
  - 为各 Agent 增加更鲜明的 `description`，帮助 selector 理解各自立场
  - 在讨论任务中加入明确冲突维度：创意 vs 落地、传播 vs 转化、效果 vs 预算、理想方案 vs 筹备周期
- `prompts.py`
  - 强化各角色 prompt，让不同 Agent 必须表达分歧、指出代价、必要时直接反驳
  - 新增 `SELECTOR_PROMPT`，引导 selector 选择“当前最应该发言的人”，而不是平均轮流

### Expected Effect
- 讨论顺序更自然
- 冲突更明显
- 主持 Agent 更容易在合适节点做收束

## v0.8 - 2026-04-25

### Goal
- 让 Agent 发言更像“虚拟角色实时说话”，并让 moderator 的阶段性结论可视化展示。

### Changes
- `prompts.py`
  - 强化 `MODERATOR_SYSTEM_PROMPT`，要求 moderator 在形成阶段性结论时输出固定格式的 `[决议卡]...[/决议卡]`
- `meeting_agents.py`
  - 新增 `extract_resolution_cards()`，从 moderator 发言中提取标准化决议卡
  - 在流式讨论中检测 moderator 决议卡并通过 `moderator_resolution` 事件实时推送前端
  - 将 `resolution_cards` 写入最终运行结果，供历史任务回放
- `frontend/index.html`
  - 新增“当前发言虚拟角色面板”
  - 新增“moderator 决议卡面板”
- `frontend/styles.css`
  - 新增 holo speaker 区域、实时气泡和决议卡视觉样式
- `frontend/app.js`
  - 当前发言角色会实时显示名字、角色、态度标签和发言气泡
  - 实时接收并渲染 moderator 决议卡
  - 历史任务回放时同步恢复决议卡和当前结果

### Current UX Highlights
- Agent 发言时前端会出现对应虚拟角色实时说话面板
- moderator 的阶段性结论会单独显示成“本轮决议”卡片
