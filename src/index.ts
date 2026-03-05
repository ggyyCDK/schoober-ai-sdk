/**
 * Glint AI Agent
 * 一个基于 ReAct 模式的 AI Agent 框架
 */

// ============= Re-export Types =============
export type {
    Agent as IAgent,
    AgentConfig,
    Task,
    TaskState,
    TaskContext,
    TaskCallbacks,
    StartTaskConfig,
    Tool,
    ToolDescription,
    ToolContext,
    ToolResult,
    ToolRegistry,
    ToolFactory as IToolFactory,
    ToolConstructor,
    ToolRegistration,
    LLMProvider,
    LLMProviderConfig,
    StreamConfig,
    StreamChunk,
    StreamUsage,
    ApiMessage,
    MessageParser,
    PersistenceManager,
    ILogger,
    CompressionConfig,
    RolePromptBuilder,
    EnvironmentPromptBuilder,
} from '@/types';

export { TaskStatus, ToolStatus, ValidationError, AgentSDKError, createDefaultLogger } from '@/types';

// ============= Core =============
// Agent
export { Agent } from './core/agent/Agent';

// Parser
export { SDKMessageParser } from './core/parser/MessageParser';

// Task
export { TaskExecutor } from './core/task/TaskExecutor';
export { ReActEngine, createReActEngine } from './core/task/ReActEngine';
export type { ReActCallbacks, ReActEngineConfig, ReActStepResult } from './core/task/ReActEngine';

// Tools
export { BaseTool, createSimpleTool } from './core/tools/BaseTool';
export { DefaultToolRegistry } from './core/tools/ToolRegistry';
export { ToolFactory, ToolBuilder, createToolFactory } from './core/tools/ToolFactory';
export type { ToolBuilderConfig, ToolFactoryConfig } from './core/tools/ToolFactory';
export { AttemptCompletionTool } from './core/tools/AttemptCompletionTool';
export { NewTaskTool } from './core/tools/NewTaskTool';

// Utils
export { generateTaskId, generateApiMessageId, generateUserMessageId, generateToolRequestId, generateId } from './core/utils/idGenerator';
export { deepMerge } from './core/utils/deepMerge';
export { sleep } from './core/utils/sleep';

// ============= Providers =============
export { OpenAIProvider } from './providers/llm/openai/OpenAIProvider';
export { AnthropicProvider } from './providers/llm/anthropic/AnthropicProvider';
export { OpenAIError } from './providers/llm/openai/utils/OpenAIError';

// ============= Prompts =============
export { buildSystemPrompt, defaultRole } from './prompts/system';
export { generateToolsPrompt } from './prompts/tool';
export { generateSubAgentsPrompt } from './prompts/sub-agents';
export { coreSystemPrompt } from './prompts/core-prompt';