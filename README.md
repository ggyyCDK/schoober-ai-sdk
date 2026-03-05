# schoober-ai-sdk SDK 架构文档

## 1. 项目概述

schoober-ai-sdk 是一个基于 **ReAct（Reasoning + Acting）模式** 的 AI Agent 框架，使用 TypeScript 编写，支持 OpenAI 和 Anthropic Claude 两种 LLM 提供者。框架采用管理器模式（Manager Pattern）将复杂的任务执行逻辑拆分为多个独立的职责单元，实现了高内聚、低耦合的架构设计。

- **包名**: `glint-ai-agent`
- **版本**: `0.0.1`
- **模块格式**: ESM + CJS 双输出
- **构建工具**: Rslib（基于 Rspack）
- **运行环境**: Node.js >= 18.0.0

---

## 2. 项目结构

```
src/
├── core/                          # 核心框架
│   ├── agent/
│   │   └── Agent.ts               # Agent 主体实现
│   ├── task/                      # 任务执行系统（14 个管理器）
│   │   ├── TaskExecutor.ts        # 任务执行器（核心调度）
│   │   ├── ReActEngine.ts         # ReAct 推理循环引擎
│   │   ├── ExecutionManager.ts    # LLM 请求执行
│   │   ├── MessageManager.ts      # 消息历史管理
│   │   ├── MessageCoordinator.ts  # 消息协调（API + 用户消息）
│   │   ├── StateManager.ts        # 任务状态管理
│   │   ├── ToolManager.ts         # 工具注册与执行
│   │   ├── LifecycleManager.ts    # 任务生命周期
│   │   ├── SubTaskManager.ts      # 子任务管理
│   │   ├── CallbackManager.ts     # 事件回调管理
│   │   ├── TokenUsageManager.ts   # Token 用量统计
│   │   ├── ErrorHandler.ts        # 错误处理与恢复
│   │   ├── ErrorTracker.ts        # 错误追踪与分析
│   │   └── TaskRestoreManager.ts  # 任务状态恢复
│   ├── tools/                     # 工具系统
│   │   ├── BaseTool.ts            # 工具基类
│   │   ├── ToolFactory.ts         # 工具工厂
│   │   ├── ToolRegistry.ts        # 工具注册表
│   │   ├── AttemptCompletionTool.ts  # 系统工具：任务完成
│   │   └── NewTaskTool.ts         # 系统工具：创建子任务
│   ├── parser/
│   │   └── MessageParser.ts       # LLM 流式消息解析
│   └── utils/                     # 工具函数
│       ├── idGenerator.ts         # ID 生成
│       ├── deepMerge.ts           # 深度合并
│       ├── sleep.ts               # 异步延时
│       ├── messageValidator.ts    # 消息内容校验
│       └── ImageTemplateParser.ts # 图片模板解析
├── types/                         # 类型定义（9 个文件）
│   ├── agent.ts                   # Agent 接口与配置
│   ├── task.ts                    # Task 状态机与接口
│   ├── tool.ts                    # Tool 接口与注册
│   ├── llm.ts                     # LLM Provider 接口
│   ├── common.ts                  # 错误类与通用类型
│   ├── message.ts                 # 消息类型
│   ├── parser.ts                  # 解析器接口
│   └── persistence.ts             # 持久化接口
├── providers/                     # LLM 提供者实现
│   └── llm/
│       ├── openai/
│       │   └── OpenAIProvider.ts
│       └── anthropic/
│           └── AnthropicProvider.ts
└── prompts/                       # 系统提示词模板
    ├── system.ts                  # 系统提示词构建
    ├── tool.ts                    # 工具提示词生成
    ├── sub-agents.ts              # 子 Agent 提示词
    └── core-prompt.ts             # 核心提示词
```

---

## 3. 核心架构

### 3.1 分层架构

```
┌───────────────────────────────────────────────────┐
│                  应用层 (Application)               │
│         用户代码：创建 Agent、注册工具、执行任务         │
├───────────────────────────────────────────────────┤
│                 Agent 层 (Agent)                    │
│     Agent.ts：工具注册、任务创建/恢复、系统提示词构建     │
├───────────────────────────────────────────────────┤
│               任务执行层 (Task Execution)            │
│   TaskExecutor + 11 个专职管理器 + ReActEngine       │
├───────────────────────────────────────────────────┤
│              工具层 (Tool System)                    │
│     BaseTool / ToolFactory / ToolRegistry           │
├───────────────────────────────────────────────────┤
│            LLM 提供者层 (LLM Provider)              │
│       OpenAIProvider / AnthropicProvider            │
├───────────────────────────────────────────────────┤
│            持久化层 (Persistence)                    │
│          PersistenceManager 接口（外部实现）          │
└───────────────────────────────────────────────────┘
```

### 3.2 模块导出

SDK 提供 4 个入口点，通过 `package.json` 的 `exports` 字段暴露：

| 入口路径 | 说明 |
|---------|------|
| `glint-ai-agent` | 主入口，导出所有公开 API |
| `glint-ai-agent/core` | 核心模块（Agent、Task、Tools、所有 Manager） |
| `glint-ai-agent/providers` | LLM 提供者（OpenAI、Anthropic） |
| `glint-ai-agent/prompts` | 提示词构建工具 |

---

## 4. ReAct 推理循环

框架的核心执行模式是 **ReAct 循环**（Reason-Act-Observe），由 `ReActEngine` 驱动：

```
                    ┌──────────────┐
                    │  任务开始     │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │   检查任务状态            │
              │   status === RUNNING?    │◄──────────────────┐
              └────────────┬────────────┘                   │
                    Yes    │    No → 退出循环                │
                           │                                │
              ┌────────────▼────────────┐                   │
              │  1. REASON（推理）       │                   │
              │  构建 systemPrompt      │                   │
              │  发送消息到 LLM          │                   │
              │  流式接收响应            │                   │
              └────────────┬────────────┘                   │
                           │                                │
              ┌────────────▼────────────┐                   │
              │  解析 LLM 响应           │                   │
              │  文本内容？工具调用？      │                   │
              └─────┬──────────┬────────┘                   │
                    │          │                             │
            文本内容 │          │ 工具调用                     │
                    │          │                             │
       ┌────────────▼──┐  ┌───▼──────────────┐             │
       │ 更新用户消息   │  │ 2. ACT（执行）    │             │
       │ (Thought)     │  │ ToolManager       │             │
       └───────────────┘  │ 执行工具           │             │
                          └───┬──────────────┘             │
                              │                             │
                    ┌─────────▼───────────┐                │
                    │ 3. OBSERVE（观察）    │                │
                    │ 工具结果写入消息历史   │────────────────┘
                    │ 供 LLM 下轮参考      │
                    └─────────────────────┘
```

### 关键机制

- **循环终止条件**：任务状态不再是 `RUNNING`（如 `COMPLETED`、`PAUSED`、`FAILED`）
- **无工具调用保护**：连续 3 次 LLM 未调用工具 → 自动暂停任务
- **错误追踪**：相同错误重复 3 次 → 自动暂停任务
- **AbortController**：支持外部中止正在进行的 LLM 请求

---

## 5. 管理器模式

`TaskExecutor` 将复杂逻辑拆分为 11 个专职管理器，每个管理器负责单一职责：

```
                          TaskExecutor
                          (核心调度器)
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    ┌────▼─────┐    ┌────────▼────────┐    ┌─────▼──────┐
    │ Lifecycle │    │   ReActEngine   │    │   State    │
    │ Manager  │    │  (ReAct 循环)    │    │  Manager   │
    └──────────┘    └────────┬────────┘    └────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───┐  ┌──────▼──────┐  ┌────▼────────┐
     │ Execution  │  │  Message    │  │    Tool     │
     │  Manager   │  │ Coordinator │  │   Manager   │
     └────────────┘  └──────┬──────┘  └─────────────┘
                            │
                    ┌───────▼───────┐
                    │   Message     │
                    │   Manager     │
                    └───────────────┘
```

### 管理器职责一览

| 管理器 | 职责 |
|-------|------|
| **StateManager** | 任务状态转换、状态快照、持久化触发 |
| **MessageManager** | API 消息历史存储、消息角色管理、持久化 |
| **MessageCoordinator** | 消息协调（API 消息 + 用户消息）、流式消息追踪 |
| **ExecutionManager** | LLM API 调用、流式响应处理、消息解析 |
| **ToolManager** | 工具注册表管理、工具实例化与执行、参数验证 |
| **ReActEngine** | ReAct 推理循环编排、迭代控制、错误处理 |
| **LifecycleManager** | 任务启动/暂停/恢复/中止/完成生命周期 |
| **SubTaskManager** | 子任务创建、完成通知、活跃子任务路由 |
| **CallbackManager** | 事件回调分发（onMessage、onTaskStateUpdate 等） |
| **TokenUsageManager** | Token 用量累计统计、压缩阈值判断 |
| **ErrorHandler** | 错误分类处理、重试策略、失败恢复 |
| **ErrorTracker** | 错误签名计算、重复错误检测、错误计数 |
| **TaskRestoreManager** | 从持久化层恢复任务状态和消息历史 |

---

## 6. 任务状态机

`TaskStatus` 采用值对象（Value Object）设计模式，封装了状态转换的业务规则：

```
                    ┌─────────┐
                    │ PENDING │
                    └────┬────┘
                         │ start()
                    ┌────▼────┐
           ┌────────│ RUNNING │────────┐
           │        └────┬────┘        │
           │ pause()     │      abort()│
     ┌─────▼─────┐      │      ┌──────▼─────┐
     │  PAUSED   │      │      │  ABORTED   │
     └─────┬─────┘      │      └──────┬─────┘
           │ start()     │             │
           └─────►RUNNING│             │
                         │             │
              complete() │   fail()    │
                    ┌────▼────┐        │
                    │COMPLETED│        │
                    └─────────┘        │
                    ┌────────┐         │
                    │ FAILED │◄────────┘
                    └────────┘

    特殊状态：
    RUNNING ──► WAITING_FOR_SUBTASK ──► RUNNING
                (子任务执行期间)        (子任务完成后)

    终态重激活：
    COMPLETED / FAILED / ABORTED ──► RUNNING（允许重新执行）
```

### 状态说明

| 状态 | 值 | 说明 |
|-----|---|------|
| `PENDING` | `pending` | 任务已创建，等待启动 |
| `RUNNING` | `running` | 任务正在执行 |
| `PAUSED` | `paused` | 任务已暂停（可恢复） |
| `COMPLETED` | `completed` | 任务成功完成 |
| `FAILED` | `failed` | 任务执行失败 |
| `ABORTED` | `aborted` | 任务被主动中止 |
| `WAITING_FOR_SUBTASK` | `waiting_for_subtask` | 等待子任务完成 |

---

## 7. 工具系统

### 7.1 架构

```
┌──────────────────────────────────────────┐
│             ToolRegistry                  │
│    (存储 ToolFactory，按名称查找)           │
└────────────────┬─────────────────────────┘
                 │ get(name)
         ┌───────▼───────┐
         │  ToolFactory   │
         │  (创建工具实例)  │
         └───────┬───────┘
                 │ create()
         ┌───────▼───────┐
         │   BaseTool     │  ◄── 用户自定义工具继承
         │  (抽象基类)     │
         ├───────────────┤
         │ name          │
         │ getDescription │
         │ getParameters  │  ← Zod Schema 定义参数
         │ execute()      │  ← 核心执行逻辑
         │ sendToolStatus │  ← 状态报告
         │ setToolResult  │  ← 结果设置
         └───────────────┘
```

### 7.2 系统内置工具

| 工具名 | 类 | 职责 |
|-------|---|------|
| `attempt_completion` | `AttemptCompletionTool` | 标记任务完成或中止 |
| `new_task` | `NewTaskTool` | 创建子任务并委派给子 Agent |

### 7.3 工具注册方式

```typescript
// 方式一：直接传入工具类
agent.registerTool(MyCustomTool);

// 方式二：传入配置对象（自定义工厂）
agent.registerTool({
  name: 'my_tool',
  factory: async (context) => new MyCustomTool(context)
});

// 批量注册
agent.registerTools([ToolA, ToolB, ToolC]);
```

### 7.4 工具执行流程

```
ToolManager.executeTool(toolUse)
    │
    ├── 1. 从 Registry 获取或创建工具实例
    │
    ├── 2. 注入 TaskExecutor 引用（供工具发消息）
    │
    ├── 3. 验证参数（Zod Schema）
    │
    ├── 4. 发送 DOING 状态
    │
    ├── 5. tool.execute(params, context, isPartial)
    │       │
    │       ├── 工具内部逻辑执行
    │       ├── sendToolStatus() → 状态更新
    │       └── setToolResult() → 设置结果
    │
    ├── 6. 发送 SUCCESS/ERROR 状态
    │
    └── 7. 工具结果写入消息历史
```

---

## 8. 消息流

### 8.1 消息类型

| 类型 | 说明 |
|-----|------|
| `ApiMessage` | LLM 通信用消息（存储在 MessageManager） |
| `UserMessage` | UI 展示用消息（通过回调发送） |
| `ToolInfo` | 工具状态/结果消息（由工具产生） |

### 8.2 完整消息流

```
用户输入 (TaskInput)
    │
    ▼
MessageCoordinator.addUserInput()
    │
    ├── 创建 ApiMessage (role: user) → MessageManager
    └── 创建 UserMessage (type: text) → onMessage 回调
    │
    ▼
ReActEngine.executeStep()
    │
    ├── 构建 systemPrompt（Agent.buildSystemPrompt）
    ├── 追加 envPrompt（Agent.buildEnvironmentPrompt）
    ├── 过滤空消息
    │
    ▼
ExecutionManager.execute(messages, config)
    │
    ├── LLM Provider.createStream()
    │
    ▼
流式响应解析 (SDKMessageParser)
    │
    ├── 文本内容 → MessageCoordinator.updateUserMessageContent()
    │                  └── onMessage 回调（流式更新 UI）
    │
    ├── 工具调用 → ToolManager.executeTool()
    │                  ├── 工具执行
    │                  ├── 工具结果 → ApiMessage (role: user)
    │                  └── 工具状态 → UserMessage → onMessage 回调
    │
    └── 流结束 → MessageCoordinator.finalizeApiMessage()
                     └── ApiMessage (role: assistant) → MessageManager
```

---

## 9. LLM Provider 层

### 9.1 接口设计

`LLMProvider` 接口只定义 3 个核心方法：

```typescript
interface LLMProvider {
  getModel(): ModelInfo;            // 获取模型信息
  setModel(model): void;            // 设置模型
  createStream(config): AsyncIterable<StreamChunk>;  // 流式请求
}
```

### 9.2 Provider 实现

| Provider | SDK | 特性 |
|----------|-----|------|
| **OpenAIProvider** | `openai@6.15.0` | 消息格式转换、流式响应、图片 URL 处理 |
| **AnthropicProvider** | `@anthropic-ai/sdk@0.71.2` | 流式缓存、图片 Base64 转换、超时控制、扩展用量追踪 |

### 9.3 StreamChunk 数据流

```typescript
interface StreamChunk {
  type: 'text' | 'tool_use' | 'usage' | 'error' | 'end';
  // text 类型
  text?: string;
  // tool_use 类型
  toolUse?: ToolUse;
  // usage 类型
  usage?: StreamUsage;
}
```

---

## 10. 子任务与子 Agent

### 10.1 子 Agent 注册

```typescript
const mainAgent = new Agent({
  name: 'main',
  subAgents: {
    'researcher': researcherAgent,
    'coder': coderAgent,
  }
});
```

### 10.2 子任务执行流程

```
主任务 (RUNNING)
    │
    ├── LLM 决定调用 new_task 工具
    │
    ▼
NewTaskTool.execute()
    │
    ├── 1. 查找对��子 Agent
    ├── 2. 子 Agent 创建子任务
    ├── 3. 设置父子关系
    ├── 4. 主任务状态 → WAITING_FOR_SUBTASK
    ├── 5. 子任务 start() 执行
    │
    ▼
子任务执行（独立 ReAct 循环）
    │
    ├── 子任务完成
    │
    ▼
SubTaskManager.subTaskDone()
    │
    ├── 1. 将子任务结果写入父任务消息历史
    ├── 2. 父任务状态 → RUNNING
    └── 3. 父任务继续 ReAct 循环
```

---

## 11. 持久化设计

持久化通过 `PersistenceManager` 接口实现，**由用户自行实现**：

```typescript
interface PersistenceManager {
  saveTaskState(taskId, state): Promise<void>;
  loadTaskState(taskId): Promise<TaskState | null>;
  saveTaskInput(taskId, input): Promise<void>;
  loadTaskInput(taskId): Promise<TaskInput | null>;
  saveApiMessage(taskId, message): Promise<void>;
  loadApiMessages(taskId): Promise<ApiMessage[]>;
}
```

### 持久化时机

- **任务创建时**：保存初始 `TaskState` 和 `TaskInput`
- **状态变化时**：`StateManager` 触发持久化
- **消息追加时**：`MessageManager` 防抖持久化
- **任务恢复时**：`TaskRestoreManager` 从持久化层加载状态和消息

---

## 12. 错误处理机制

### 12.1 ErrorTracker（错误追踪）

- 基于错误签名（message + 可选 stack）去重
- 相同错误出现 **3 次** → 触发暂停
- 支持 `simple` 签名算法

### 12.2 ErrorHandler（错误处理）

- LLM 错误：记录日志，插入错误消息到历史，供 LLM 参考
- 工具执行错误：追踪错误，达阈值则暂停任务
- 支持配置 `maxRetries` 最大重试次数

### 12.3 错误恢复策略

```
错误发生
    │
    ├── ErrorTracker.trackError()
    │       │
    │       ├── 未达阈值 → 插入错误消息 → 继续 ReAct 循环
    │       │                            （LLM 可参考错误信息调整策略）
    │       │
    │       └── 达到阈值 → 暂停任务 → 等待外部恢复
    │
    └── 非重复错误 → ErrorHandler.handleError()
            │
            ├── retryCount < maxRetries → 重试
            └── retryCount >= maxRetries → FAILED
```

---

## 13. Token 管理与消息压缩

### 13.1 TokenUsageManager

- 累计统计所有请求的 `inputTokens` 和 `outputTokens`
- 记录最新一次请求的 `lastRequestInputTokens`（用于压缩判断）
- 统计信息持久化到 `TaskContext.tokenUsage`

### 13.2 消息压缩

当 token 用量超过阈值时，自动压缩消息历史：

```typescript
interface CompressionConfig {
  enabled: boolean;      // 是否启用
  threshold: number;     // 阈值（0-1），如 0.8 表示使用 80% 时触发
  prompt: string;        // 压缩提示词
}
```

---

## 14. 系统提示词构建

`Agent.buildSystemPrompt()` 按以下顺序组合系统提示词：

```
1. 基础系统提示词（coreSystemPrompt + Agent.description）
        │
2. 角色提示词（rolePromptBuilder 动态生成）
        │
3. 工具定义（注册工具 + 系统工具的 prompt）
        │
4. 子 Agent 信息（名称、描述列表）
        │
        ▼
    最终 systemPrompt
```

`Agent.buildEnvironmentPrompt()` 生成环境变量提示词，追加到消息队列尾部（作为 `user` 消息），支持每轮动态更新。

---

## 15. 技术依赖

### 运行时依赖

| 依赖 | 版本 | 用途 |
|-----|------|------|
| `@anthropic-ai/sdk` | 0.71.2 | Claude API |
| `openai` | 6.15.0 | OpenAI API |
| `@ai-sdk/openai` | ^2.0.88 | Vercel AI SDK OpenAI 适配 |
| `ai` | 5.0.114 | Vercel AI SDK 核心 |
| `zod` | 4.2.1 | 参数 Schema 验证 |
| `nanoid` | ^5.1.6 | 唯一 ID 生成 |
| `tiktoken` | ^1.0.22 | Token 计数 |
| `fs-extra` | ^11.3.2 | 文件操作 |
| `zod-to-json-schema` | ^3.23.5 | Zod → JSON Schema 转换 |

### 开发依赖

| 依赖 | 版本 | 用途 |
|-----|------|------|
| `@rslib/core` | 0.11.1 | ��建工具 |
| `typescript` | ^5.3.3 | 类型系统 |
| `vitest` | ^2.0.0 | 测试框架 |
| `@vitest/coverage-v8` | ^2.0.0 | 测试覆盖率 |

---

## 16. 构建与发布

### 构建配置

- **入口文件**：`index.ts`、`core/index.ts`、`providers/index.ts`、`prompts/index.ts`
- **输出目录**：`dist/esm/`（ESM）、`dist/cjs/`（CJS）
- **目标环境**：Node.js
- **TypeScript**：ES2022、ESNext 模块、严格模式、路径别名 `@/* → ./src/*`

### 脚本

```bash
npm run build          # 构建
npm run dev            # 监听模式构建
npm run test           # 运行测试
npm run test:coverage  # 测试覆盖率
npm run clean          # 清理构建产物
```
