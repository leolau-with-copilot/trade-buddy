# 系统架构说明

## 1. 总体架构
本系统采用前后端分离结构：

```text
用户输入
   ↓
前端控制台（frontend）
   ↓ HTTP / Stream
FastAPI 接口（webapp.py）
   ↓
多 Agent 编排核心（meeting_agents.py）
   ↓
DeepSeek API
   ↓
返回阶段结果 + 讨论消息 + 最终策划书
   ↓
前端实时渲染
```

## 2. 三阶段流程

### 阶段 1：筹备会议生成
- Agent：`meeting_planner_agent`
- 输入：活动主题、目标、预算、场地、约束等
- 输出：内部筹备会议方案

### 阶段 2：多 Agent 讨论
- 团队：`SelectorGroupChat`
- 角色：
  - `creative_agent`
  - `operations_agent`
  - `publicity_agent`
  - `risk_agent`
  - `moderator_agent`
- 输出：
  - 实时讨论消息
  - moderator 决议卡

### 阶段 3：活动策划书汇总
- Agent：`activity_synthesizer_agent`
- 输入：阶段 1 + 阶段 2 结果
- 输出：最终活动策划书

## 3. 核心模块

### `meeting_agents.py`
负责：
- 输入规范化
- 创建模型客户端
- 三阶段编排
- 流式事件推送
- moderator 决议卡提取

### `prompts.py`
负责：
- 各 Agent 的角色设定
- selector 的选择规则
- moderator 的决议卡格式约束

### `webapp.py`
负责：
- 提供 `/api/generate`
- 提供 `/api/generate-stream`
- 托管静态前端资源

### `frontend/`
负责：
- 表单输入
- Agent 虚拟舱室展示
- 实时讨论流
- 决议卡面板
- 最终策划书展示
- 历史任务和导出功能

## 4. 为什么使用 SelectorGroupChat
相比固定轮流发言的 `RoundRobinGroupChat`，`SelectorGroupChat` 能根据上下文动态决定：
- 谁最适合回应上一条消息
- 谁最应该提出反驳
- 何时让 moderator 收束讨论

因此讨论过程更接近真实会议。

## 5. 数据流

```text
用户提交表单
→ 后端接收 JSON
→ 生成筹备会议方案
→ 进入多 Agent 讨论
→ 流式返回每条消息
→ moderator 输出决议卡
→ 汇总最终策划书
→ 前端实时展示与存档
```

## 6. 可扩展点
- 接入数据库存储历史任务
- 接入 RAG 读取活动资料
- 加入语音、3D 人物、动画
- 支持更多模型与活动模板
