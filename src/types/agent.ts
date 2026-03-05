/**
 * Agent 接口定义
 */

import { Task, TaskState, StartTaskConfig, TaskContext } from './task';
import { Tool, ToolConstructor, ToolRegistration } from './tool';
import { LLMProvider } from './llm';
import { PersistenceManager, UserMessage } from './persistence';
import { MessageParser } from './parser';
import { ILogger } from './common';

/**
 * 任务回调配置
 */
export interface TaskCallbacks {
    /** 用户消息回调 */
    onMessage?: (message: UserMessage) => Promise<void>;
    /** 任务状态更新回调 */
    onTaskStateUpdate?: (state: TaskState) => Promise<void>;
    /** 子任务创建后的回调（用于补充持久化信息等） */
    onSubTaskCreated?: (subTask: Task, parentTask: Task) => Promise<void>;
}

/**
 * 角色提示词构建函数类型
 * 用于动态生成额外的角色相关提示词，会追加到基础系统提示词之后
 */
export type RolePromptBuilder = (taskState: TaskState) => string | Promise<string>;

/**
 * 环境变量提示词构建函数类型
 * 用于动态生成环境变量提示词，会追加到消息队列尾部
 * 入参和出参与 RolePromptBuilder 保持一致
 */
export type EnvironmentPromptBuilder = (taskState: TaskState) => string | Promise<string>;

/**
 * 压缩配置
 */
export interface CompressionConfig {
    /** 是否开启压缩 */
    enabled: boolean;
    /** 阈值（0-1），当当前输入token数 >= 最大输入token数 * 阈值时触发压缩 */
    threshold: number;
    /** 压缩提示词 */
    prompt: string;
}

/**
 * 默认压缩提示词
 */
export const DEFAULT_COMPRESSION_PROMPT =
    '请将以下对话历史压缩，保留关键信息和上下文，去除冗余内容。压缩后的内容应该能够帮助理解对话的核心意图和重要信息。';

/**
 * Agent配置
 */
export interface AgentConfig {
    /** Agent名称 */
    name: string;
    /** Agent描述 */
    description?: string;
    /** LLM提供者 */
    llmProvider: LLMProvider;
    /** 消息解析器（可选，默认使用 SDKMessageParser） */
    messageParser?: MessageParser;
    /** 持久化管理器 */
    persistence: PersistenceManager;
    /** 角色提示词构建函数（动态生成额外的角色相关提示词，追加到基础提示词之后） */
    rolePromptBuilder?: RolePromptBuilder;
    /** 环境变量提示词构建函数（动态生成环境变量提示词，追加到消息队列尾部） */
    environmentPromptBuilder?: EnvironmentPromptBuilder;
    /** 元数据 */
    metadata?: Record<string, any>;
    /** 日志记录器（可选，默认使用 console） */
    logger?: ILogger;
    /** 压缩配置 */
    compressionConfig?: CompressionConfig;
    /** 核心系统提示词（覆盖默认的 coreSystemPrompt） */
    coreSystemPrompt?: string;
    /** 子Agent映射表（key为子Agent名称） */
    subAgents?: Record<string, Agent>;
}

/**
 * Agent主体接口
 */
export interface Agent {
    /** Agent名称 */
    name: string;
    /** Agent描述 */
    description?: string;

    /**
     * 创建新任务
     * Agent 只负责创建任务，不管理任务的生命周期
     * 任务的状态由持久化层管理
     * @param config 任务配置
     * @param context 任务上下文（与 config 分离）
     * @param callbacks 可选的回调配置
     * @returns 创建的任务实例
     */
    createTask(config: StartTaskConfig, context: TaskContext, callbacks?: TaskCallbacks): Promise<Task>;

    /**
     * 从持久化层恢复任务实例
     * @param taskId 任务ID
     * @param context 可选的任务上下文（如果提供，会覆盖持久化层的 context）
     * @param callbacks 可选的回调配置
     * @returns 任务实例或 undefined
     */
    loadTask(taskId: string, context?: TaskContext, callbacks?: TaskCallbacks): Promise<Task | undefined>;

    /**
     * 注册工具
     * 支持两种方式：
     * 1. 直接传入工具类：registerTool(ToolClass) - 默认使用 new ToolClass() 实例化
     * 2. 传入配置对象：registerTool({ name, factory }) - 使用自定义工厂函数
     * @param tool 工具类或工具注册配置
     */
    registerTool(tool: ToolConstructor | ToolRegistration): void;

    /**
     * 批量注册工具
     * @param tools 工具类或工具注册配置数组
     */
    registerTools(tools: (ToolConstructor | ToolRegistration)[]): void;

    /**
     * 注销工具
     * @param name 工具名称
     */
    unregisterTool(name: string): void;

    /**
     * 获取所有已注册的工具（用于生成prompt）
     * @returns 工具列表（临时实例）
     */
    getTools(): Promise<Tool[]>;

    /**
     * 根据名称获取工具（用于生成prompt）
     * @param name 工具名称
     * @returns 工具实例或undefined（临时实例）
     */
    getTool(name: string): Promise<Tool | undefined>;

    /**
     * 检查工具是否已注册
     * @param name 工具名称
     * @returns 是否已注册
     */
    hasTool(name: string): boolean;

    /**
     * 销毁Agent，清理资源
     */
    dispose(): void;

    /**
     * 获取LLM提供者
     */
    getLLMProvider(): LLMProvider;

    /**
     * 获取消息解析器
     */
    getMessageParser(): MessageParser;

    /**
     * 获取持久化管理器
     */
    getPersistenceManager(): PersistenceManager | undefined;

    /**
     * 构建系统提示词（根据任务状态动态生成）
     * @param taskState 任务状态
     * @param additionalTools 额外的工具列表（如系统工具），将与 Agent 注册的工具合并
     * @returns 系统提示词
     */
    buildSystemPrompt(taskState: TaskState, additionalTools?: Tool[]): Promise<string>;

    /**
     * 构建环境变量提示词（根据任务状态动态生成）
     * @param taskState 任务状态
     * @returns 环境变量提示词
     */
    buildEnvironmentPrompt(taskState: TaskState): Promise<string>;

    /**
     * 获取元数据
     */
    getMetadata(): Record<string, any>;

    /**
     * 更新元数据
     * @param metadata 要更新的元数据
     */
    updateMetadata(metadata: Record<string, any>): void;

    /**
     * 获取日志记录器
     */
    getLogger(): ILogger;

    /**
     * 获取压缩配置
     */
    getCompressionConfig(): CompressionConfig | undefined;

    /**
     * 获取子Agent
     * @param name 子Agent名称
     * @returns 子Agent实例或undefined
     */
    getSubAgent(name: string): Agent | undefined;
}

/**
 * Agent工厂接口
 */
export interface AgentFactory {
    /**
     * 创建Agent实例
     * @param config Agent配置
     * @returns Agent实例
     */
    createAgent(config: AgentConfig): Promise<Agent>;

    /**
     * 根据预设创建Agent
     * @param preset 预设名称
     * @param overrides 配置覆盖
     * @returns Agent实例
     */
    createFromPreset(preset: string, overrides?: Partial<AgentConfig>): Promise<Agent>;
}