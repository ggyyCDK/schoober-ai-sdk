# schoober-ai-sdk 使用指南

## 安装

```bash
npm install schoober-ai-sdk
```

要求 Node.js >= 18.0.0。

---

## 快速开始

以下是一个最小化的示例，展示如何创建 Agent 并执行任务：

```typescript
import { Agent, OpenAIProvider } from 'schoober-ai-sdk';

// 1. 创建 LLM Provider
const llmProvider = new OpenAIProvider({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o',
});

// 2. 实现持久化管理器（最简内存版）
const memoryPersistence = {
  _states: new Map(),
  _messages: new Map(),
  _inputs: new Map(),
  _userMessages: new Map(),

  async saveTaskState(taskId, state) { this._states.set(taskId, state); },
  async loadTaskState(taskId) { return this._states.get(taskId) || null; },
  async updateTaskState(taskId, updates) {
    const existing = this._states.get(taskId);
    if (existing) this._states.set(taskId, { ...existing, ...updates });
  },
  async deleteTaskState(taskId) { this._states.delete(taskId); },
  async listTaskStates() { return Array.from(this._states.values()); },

  async saveApiMessages(taskId, messages) { this._messages.set(taskId, messages); },
  async loadApiMessages(taskId) { return this._messages.get(taskId) || []; },
  async appendApiMessage(taskId, message) {
    const msgs = this._messages.get(taskId) || [];
    msgs.push(message);
    this._messages.set(taskId, msgs);
  },
  async deleteApiMessages(taskId) { this._messages.delete(taskId); },

  async saveUserMessages(taskId, messages) { this._userMessages.set(taskId, messages); },
  async loadUserMessages(taskId) { return this._userMessages.get(taskId) || []; },
  async deleteUserMessages(taskId) { this._userMessages.delete(taskId); },

  async saveTaskInput(taskId, input) { this._inputs.set(taskId, input); },
  async loadTaskInput(taskId) { return this._inputs.get(taskId) || null; },
  async deleteTaskInput(taskId) { this._inputs.delete(taskId); },
};

// 3. 创建 Agent
const agent = new Agent({
  name: 'my-assistant',
  description: '你是一个智能助手，擅长回答各类问题。',
  llmProvider,
  persistence: memoryPersistence,
});

// 4. 创建并执行任务
async function main() {
  const task = await agent.createTask(
    { name: '问答任务' },
    { userId: 'user-1', sessionId: 'session-1' },
    {
      onMessage: async (message) => {
        // 接收 Agent 发送的消息（文本、工具状态等）
        if (message.type === 'text' && message.content) {
          process.stdout.write(message.content);
        }
      },
      onTaskStateUpdate: async (state) => {
        console.log(`\n[状态] ${state.status}`);
      },
    }
  );

  // 启动任务
  await task.start({
    message: '请介绍一下 TypeScript 的类型系统',
  });

  // 等待任务完成
  const result = await task.wait();
  console.log('\n[完成]', result.status);
}

main();
```

---

## 使用 Anthropic Claude

```typescript
import { Agent, AnthropicProvider } from 'schoober-ai-sdk';

const llmProvider = new AnthropicProvider({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: 'claude-3-5-sonnet-20241022',
});

const agent = new Agent({
  name: 'claude-assistant',
  description: '你是一个基于 Claude 的智能助手。',
  llmProvider,
  persistence: memoryPersistence, // 同上
});
```

### 使用 OpenAI 兼容 API

对于兼容 OpenAI 协议的第三方服务（如 DeepSeek、Moonshot 等），通过 `baseUrl` 配置即可：

```typescript
const llmProvider = new OpenAIProvider({
  provider: 'openai',
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
});
```

---

## 自定义工具

工具是 Agent 与外部世界交互的方式。LLM 在推理过程中会自主决定调用哪些工具。

### 方式一：继承 BaseTool

```typescript
import { BaseTool, ToolStatus } from 'schoober-ai-sdk';
import { z } from 'zod';

class WeatherTool extends BaseTool {
  name = 'get_weather';
  displayName = '天气查询';

  async getDescription() {
    return {
      displayName: '天气查询',
      description: '查询指定城市的实时天气信息',
    };
  }

  async getParameters() {
    return z.object({
      city: z.string().describe('城市名称，如"北京"、"上海"'),
    });
  }

  async execute(params, context, isPartial) {
    // isPartial 为 true 时表示参数还在流式解析中
    if (isPartial) {
      await this.sendToolStatus(context.requestId, ToolStatus.WAIT, {
        showTip: '正在准备查询...',
        params,
      });
      return;
    }

    // 开始执行
    await this.sendToolStatus(context.requestId, ToolStatus.DOING, {
      showTip: `正在查询 ${params.city} 的天气...`,
    });

    // 调用天气 API（示例）
    const weather = { city: params.city, temperature: 22, condition: '晴' };

    // 设置工具结果（写入消息历史，供 LLM 后续参考）
    await this.setToolResult(
      context.requestId,
      JSON.stringify(weather)
    );

    // 发送成功状态
    await this.sendToolStatus(context.requestId, ToolStatus.SUCCESS, {
      result: weather,
    });
  }
}

// 注册到 Agent
agent.registerTool(WeatherTool);
```

### 方式二：使用 createSimpleTool 快捷创建

```typescript
import { createSimpleTool } from 'schoober-ai-sdk';
import { z } from 'zod';

const calculatorTool = createSimpleTool({
  name: 'calculator',
  description: {
    displayName: '计算器',
    description: '执行数学运算',
  },
  parameters: z.object({
    expression: z.string().describe('数学表达式，如 "2 + 3 * 4"'),
  }),
  execute: async (params, context, isPartial) => {
    if (isPartial) return;
    // 注意：createSimpleTool 中无法使用 this.setToolResult
    // 适合简单场景，复杂工具推荐继承 BaseTool
  },
});
```

### 批量注册工具

```typescript
agent.registerTools([WeatherTool, SearchTool, DatabaseTool]);
```

### 使用工厂模式注册

适合需要注入依赖或动态创建工具实例的场景：

```typescript
agent.registerTool({
  name: 'database_query',
  factory: async (context) => {
    const tool = new DatabaseQueryTool();
    await tool.connectToDatabase(process.env.DB_URL);
    return tool;
  },
});
```

---

## 任务生命周期

### 创建任务

```typescript
const task = await agent.createTask(
  // 任务配置
  {
    name: '数据分析任务',
    description: '分析用户上传的数据集',
    timeout: 60000,       // 超时 60 秒
    maxRetries: 2,        // 最多重试 2 次
    metadata: {
      temperature: 0.7,   // LLM 温度参数
      maxTokens: 4096,    // 最大输出 token
    },
  },
  // 任务上下文
  {
    userId: 'user-123',
    sessionId: 'session-456',
    custom: {
      // 自定义数据，工具中可通过 context.custom 访问
      dataSource: '/path/to/data.csv',
    },
  },
  // 回调函数
  {
    onMessage: async (message) => { /* 处理消息 */ },
    onTaskStateUpdate: async (state) => { /* 处理状态变化 */ },
  }
);
```

### 启动与等待

```typescript
// 启动任务（传入用户输入）
await task.start({ message: '请分析这份数据的趋势' });

// 等待任务完成，获取结果
const result = await task.wait();

console.log(result.status);   // 'success' | 'error' | 'partial'
console.log(result.data);     // 任务结果数据
console.log(result.duration); // 执行耗时（毫秒）
```

### 暂停与恢复

```typescript
// 暂停任务
task.pause();

// 恢复任务（通过再次调用 start）
await task.start({ message: '请继续上次的分析' });
```

### 中止任务

```typescript
task.abort();
```

### 多轮对话

任务在运行中或暂停后可以继续发送消息：

```typescript
// 第一轮
await task.start({ message: '帮我查一下北京的天气' });
const result1 = await task.wait();

// 第二轮（在同一个任务中继续对话）
await task.start({ message: '那上海呢？' });
const result2 = await task.wait();
```

### 从持久化恢复任务

```typescript
// 应用重启后，从持久化层恢复之前的任务
const restoredTask = await agent.loadTask(
  'task-id-xxx',
  { userId: 'user-123' },  // 可选：覆盖上下文
  { onMessage: async (msg) => { /* ... */ } }
);

if (restoredTask) {
  await restoredTask.start({ message: '继续之前的工作' });
}
```

---

## 回调与消息处理

### onMessage 回调

通过 `onMessage` 接收 Agent 产生的所有消息，用于 UI 展示：

```typescript
const callbacks = {
  onMessage: async (message) => {
    switch (message.type) {
      case 'text':
        // LLM 的文本回复（流式更新）
        process.stdout.write(message.content || '');
        break;

      case 'tool':
        // 工具状态更新
        const tool = message.toolInfo;
        if (tool.status === 'doing') {
          console.log(`[工具] ${tool.displayName}: ${tool.showTip}`);
        } else if (tool.status === 'success') {
          console.log(`[工具] ${tool.displayName} 完成`, tool.result);
        } else if (tool.status === 'error') {
          console.error(`[工具] ${tool.displayName} 失败`, tool.error);
        }
        break;

      case 'error':
        console.error('[错误]', message.content);
        break;
    }
  },
};
```

### onTaskStateUpdate 回调

监听任务状态变化：

```typescript
const callbacks = {
  onTaskStateUpdate: async (state) => {
    // state.status: pending | running | paused | completed | failed | aborted
    console.log(`任务 ${state.id} 状态: ${state.status}`);

    // 可以访问 token 用量
    if (state.context.tokenUsage) {
      console.log(`Token 用量: ${state.context.tokenUsage.totalTokens}`);
    }
  },
};
```

---

## 子 Agent 与子任务

将复杂任务拆分给不同的专业 Agent 处理：

```typescript
// 创建专业子 Agent
const researchAgent = new Agent({
  name: 'researcher',
  description: '你是一个专业的研究助手，擅长搜索和整理资料。',
  llmProvider,
  persistence: memoryPersistence,
});
researchAgent.registerTool(WebSearchTool);

const writerAgent = new Agent({
  name: 'writer',
  description: '你是一个专业的写作助手，擅长撰写文章。',
  llmProvider,
  persistence: memoryPersistence,
});

// 创建主 Agent，注册子 Agent
const mainAgent = new Agent({
  name: 'coordinator',
  description: '你是一个任务协调者，负责将任务分配给合适的子 Agent。',
  llmProvider,
  persistence: memoryPersistence,
  subAgents: {
    researcher: researchAgent,
    writer: writerAgent,
  },
});

// 主 Agent 执行任务时，LLM 会自动通过 new_task 工具创建子任务
const task = await mainAgent.createTask(
  { name: '文章撰写' },
  { userId: 'user-1' },
  { onMessage: async (msg) => { /* ... */ } }
);

await task.start({ message: '写一篇关于量子计算的科普文章' });
// LLM 可能会：
// 1. 调用 new_task 让 researcher 搜索量子计算相关资料
// 2. 收到研究结果后，调用 new_task 让 writer 撰写文章
// 3. 最终调用 attempt_completion 完成任务
```

---

## 高级配置

### 动态提示词

通过 `rolePromptBuilder` 和 `environmentPromptBuilder` 根据任务状态动态生成提示词：

```typescript
const agent = new Agent({
  name: 'dynamic-agent',
  description: '你是一个智能助手。',
  llmProvider,
  persistence: memoryPersistence,

  // 追加到 systemPrompt 尾部（每轮 ReAct 循环都会重新生成）
  rolePromptBuilder: (taskState) => {
    const retryInfo = taskState.retryCount
      ? `\n注意：当前是第 ${taskState.retryCount} 次重试。`
      : '';
    return `当前任务: ${taskState.config.name}${retryInfo}`;
  },

  // 追加到消息队列尾部（作为 user 消息，适合注入实时环境信息）
  environmentPromptBuilder: (taskState) => {
    return `当前时间: ${new Date().toISOString()}`;
  },
});
```

### 消息压缩

长对话场景下自动压缩消息历史，节省 token：

```typescript
const agent = new Agent({
  name: 'long-conversation-agent',
  description: '支持长对话的助手。',
  llmProvider,
  persistence: memoryPersistence,
  compressionConfig: {
    enabled: true,
    threshold: 0.8,  // 当 token 用量达 80% 时触发压缩
    prompt: '请将以下对话历史压缩，保留关键信息和上下文。',
  },
});
```

### 自定义核心提示词

覆盖 SDK 内置的核心系统提示词：

```typescript
const agent = new Agent({
  name: 'custom-agent',
  description: '你是一个客服助手。',
  llmProvider,
  persistence: memoryPersistence,
  coreSystemPrompt: `
## 消息风格
- 回复简洁友好
- 使用中文

## 任务执行规则
- 必须使用工具完成任务
- 完成后调用 attempt_completion 工具
  `,
});
```

### 自定义日志

```typescript
const agent = new Agent({
  name: 'logged-agent',
  description: '带日志的助手。',
  llmProvider,
  persistence: memoryPersistence,
  logger: {
    debug: (tag, data) => { /* 自定义 debug 日志 */ },
    info: (tag, data) => console.log(`[INFO] ${tag}`, data),
    warn: (tag, data) => console.warn(`[WARN] ${tag}`, data),
    error: (tag, data) => console.error(`[ERROR] ${tag}`, data),
  },
});
```

---

## API 速查

### Agent

| 方法 | 说明 |
|------|------|
| `createTask(config, context, callbacks?)` | 创建新任务 |
| `loadTask(taskId, context?, callbacks?)` | 从持久化恢复任务 |
| `registerTool(tool)` | 注册工具 |
| `registerTools(tools)` | 批量注册工具 |
| `unregisterTool(name)` | 注销工具 |
| `getTools()` | 获取已注册工具列表 |
| `dispose()` | 销毁 Agent，释放资源 |

### Task

| 方法 | 说明 |
|------|------|
| `start(input?)` | 启动/恢复任务 |
| `pause()` | 暂停任务 |
| `abort()` | 中止任务 |
| `wait()` | 等待任务完成，返回 `TaskResult` |
| `sendMessage(message)` | 向运行中的任务发送消息 |
| `getState()` | 获取任务状态快照 |
| `getMessages()` | 获取消息历史 |

### BaseTool

| 方法 | 说明 |
|------|------|
| `getDescription()` | 返回工具描述（抽象方法，需实现） |
| `getParameters()` | 返回 Zod 参数 Schema（抽象方法，需实现） |
| `execute(params, context, isPartial)` | 执行工具（抽象方法，需实现） |
| `sendToolStatus(requestId, status, options?)` | 发送工具状态消息 |
| `setToolResult(requestId, content)` | 设置工具结果（写入消息历史） |
| `getTaskState()` | 获取当前任务状态 |
