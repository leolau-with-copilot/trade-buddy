# 今日开发总结报告（2026-04-25）

## 1. 今日目标
- 基于 **AutoGen + DeepSeek API** 搭建一个多 Agent 活动策划系统。
- 系统流程从“直接产生活动方案”调整为：
  1. 先生成筹备会议方案
  2. 再由多 Agent 模拟讨论
  3. 最后汇总为活动策划书
- 增加一个可视化前端，并逐步升级为更有科技感的展示界面。

---

## 2. 今日遇到的主要问题

### 问题 1：OpenAI 接口无法连接
- 现象：`APIConnectionError`
- 原因：本地环境无法正常访问 OpenAI 接口
- 处理：改用 **DeepSeek API**

### 问题 2：AutoGen 不识别 DeepSeek 模型名
- 现象：`model_info is required when model name is not a valid OpenAI model`
- 原因：AutoGen 的 OpenAI 兼容客户端对非 OpenAI 官方模型名需要额外 `model_info`
- 处理：为 DeepSeek 增加默认 `model_info`

### 问题 3：最初方向偏“会议决策”，不够聚焦活动策划
- 处理：产品方向调整为“活动策划生成器”
- 后续又升级为“三阶段结构”：
  - 筹备会议 → Agent 讨论 → 活动策划书

### 问题 4：原始讨论方式太机械
- 原来：`RoundRobinGroupChat`
- 问题：像排队发言，不像真实开会
- 处理：升级为 **`SelectorGroupChat`**

### 问题 5：前端不够像真实 AI 多人协作系统
- 处理：新增流式输出、虚拟角色高亮、实时发言面板、决议卡面板、历史任务、导出功能

---

## 3. 当前系统已经完成的能力

### 后端能力
- 使用 **AutoGen** 构建多 Agent 系统
- 使用 **DeepSeek API** 作为底层模型
- 三阶段流程：
  1. `meeting_planner_agent` 生成筹备会议方案
  2. `creative / operations / publicity / risk / moderator` 进行讨论
  3. `activity_synthesizer_agent` 输出最终活动策划书

### 讨论机制
- 已从 `RoundRobinGroupChat` 升级到 **`SelectorGroupChat`**
- 当前讨论支持：
  - 更强角色立场
  - 更明显冲突
  - `moderator` 阶段性收束

### 前端能力
- 科技感 3D 风格驾驶舱界面
- Agent 虚拟舱室
- 实时流式显示讨论过程
- 当前发言角色面板
- moderator “本轮决议”卡片
- Markdown 富渲染
- 导出 PDF / Markdown
- 历史任务回放

---

## 4. 当前项目关键文件

### 核心后端
- `meeting_agents.py`：多 Agent 主流程
- `prompts.py`：各 Agent 提示词与 selector 规则
- `webapp.py`：FastAPI 接口与流式输出
- `main.py`：CLI 入口

### 前端
- `frontend/index.html`
- `frontend/styles.css`
- `frontend/app.js`

### 其他
- `sample_input.json`：示例输入
- `ITERATIONS.md`：迭代记录

---

## 5. 当前运行方式

### 安装依赖
```bash
pip install -r requirements.txt
```

### 设置 DeepSeek Key
```bash
export DEEPSEEK_API_KEY=你的key
```

### 启动 Web 系统
```bash
uvicorn webapp:app --reload
```

浏览器打开：
```text
http://127.0.0.1:8000
```

---

## 6. 当前可直接展示的亮点
- AutoGen 多 Agent 架构
- SelectorGroupChat 动态选人发言
- 三阶段推理流程
- 虚拟角色实时发言展示
- moderator 决议卡
- 最终活动策划书输出

这些内容已经适合课程展示、答辩 demo 或继续二次开发。

---

## 7. 当前仍存在的不足
- 现在的“虚拟角色”还是 UI 级别，不是真正 3D 人物模型
- 没有语音播报
- 决议卡还没有自动写回最终策划书结构中
- 还没有单独的“争议面板”
- 还没有用户系统、数据库、长期任务存储

---

## 8. 下次继续开发时建议优先做的内容

### 第一优先级
1. 增加“争议面板”
2. 将 moderator 决议自动汇总进最终策划书
3. 优化 selector 选择逻辑可解释性（显示为什么选下一个发言者）

### 第二优先级
1. 让虚拟角色带更明显的说话动画
2. 增加语音播报
3. 支持不同活动模板（分享会、比赛、宣讲会、培训）

### 第三优先级
1. 引入真正的 3D 模型（Three.js / WebGL）
2. 增加账号和历史持久化
3. 提供 API 文档和部署方案

---

## 9. 下次可以直接复制使用的提示

### 如果继续开发
可以直接说：

> 继续基于当前项目开发，先读取 `SESSION_REPORT_2026-04-25.md`、`ITERATIONS.md`、`meeting_agents.py`、`webapp.py`、`frontend/app.js`，然后继续实现：____

### 如果继续优化讨论系统
可以直接说：

> 在现有 SelectorGroupChat 基础上，继续优化 Agent 冲突与 moderator 决议机制。

### 如果继续优化前端
可以直接说：

> 在现有驾驶舱前端基础上，继续增加争议面板 / 3D 虚拟人 / 发言动画。

---

## 10. 一句话总结
今天已经把系统从“简单的多 Agent 文本生成器”推进成了一个：

> **基于 AutoGen 的、支持 Selector 动态讨论、带可视化驾驶舱前端的活动策划多 Agent 系统原型。**
