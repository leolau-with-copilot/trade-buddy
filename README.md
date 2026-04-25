# AutoGen Activity Planner

一个基于 **AutoGen + DeepSeek + FastAPI** 的多 Agent 活动策划系统，支持：

- 三阶段策划流程
- SelectorGroupChat 动态讨论
- 实时流式展示
- 虚拟 Agent 发言面板
- moderator 决议卡
- Markdown / PDF 导出

## Quick Start

### 1. 创建虚拟环境
```bash
python -m venv .venv
source .venv/bin/activate
```

### 2. 安装依赖
```bash
pip install -r requirements.txt
```

### 3. 设置 DeepSeek Key
```bash
export DEEPSEEK_API_KEY=你的key
```

### 4. 启动 Web 系统
```bash
uvicorn webapp:app --reload
```

浏览器打开：

```text
http://127.0.0.1:8000
```

## CLI 运行方式

```bash
python main.py --input sample_input.json
```

结果会输出到：

- `outputs/*.json`
- `outputs/*.md`

## 主要文件

- `meeting_agents.py`：多 Agent 编排核心
- `prompts.py`：角色与 selector 提示词
- `webapp.py`：FastAPI 服务
- `frontend/`：前端页面
- `sample_input.json`：示例输入

## 相关文档

- `PROJECT_OVERVIEW.md`：项目介绍
- `ARCHITECTURE.md`：架构说明
- `DEMO_SCRIPT.md`：演示讲稿
- `SESSION_REPORT_2026-04-25.md`：今日总结
- `ITERATIONS.md`：迭代记录
