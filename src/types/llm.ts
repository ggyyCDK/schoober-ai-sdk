/**
 * LLM Provider 接口和相关类型定义 - 简化版
 * 参考 glint-agent-sdk 的设计，去除复杂的模型列表和可用性判断
 */

import { Content, StreamChunk, ModelInfo, ILogger } from './common';
import { Anthropic } from '@anthropic-ai/sdk';

/**
 * 流配置
 */
export interface StreamConfig {
    messages: Anthropic.MessageParam[];
    model?: ModelInfo;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    stopSequences?: string[];
    metadata?: Record<string, any>;
    logger?: ILogger;
    taskId?: string;
    /** 缓存控制索引，指定哪条消息应该添加缓存控制标记。如果不提供，默认使用最后一条消息 */
    cacheControlIndex?: number;
}

/**
 * LLM提供者配置
 */
export interface LLMProviderConfig {
    /** 提供者名称 */
    provider: 'openai' | 'anthropic' | 'azure' | 'custom' | string;
    /** API密钥 */
    apiKey?: string;
    /** API基础URL */
    baseUrl?: string;
    /** 默认模型 */
    defaultModel?: string;
    /** 默认参数 */
    defaultParams?: LLMParameters;
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 重试配置 */
    retry?: RetryConfig;
    /** 代理配置 */
    proxy?: ProxyConfig;
    /** 自定义头部 */
    headers?: Record<string, string>;
    /** 自定义body */
    extraBody?: Record<string, any>;
}

/**
 * LLM参数
 */
export interface LLMParameters {
    /** 温度（0-2） */
    temperature?: number;
    /** Top P */
    topP?: number;
    /** Top K */
    topK?: number;
    /** 最大token数 */
    maxTokens?: number;
    /** 停止序列 */
    stopSequences?: string[];
    /** 频率惩罚 */
    frequencyPenalty?: number;
    /** 存在惩罚 */
    presencePenalty?: number;
    /** 种子（用于确定性输出） */
    seed?: number;
    /** 响应格式 */
    responseFormat?: 'text' | 'json' | 'json_object';
}

/**
 * 重试配置
 */
export interface RetryConfig {
    /** 最大重试次数 */
    maxAttempts: number;
    /** 初始延迟（毫秒） */
    initialDelay: number;
    /** 最大延迟（毫秒） */
    maxDelay?: number;
    /** 退避策略 */
    backoff?: 'linear' | 'exponential';
    /** 退避因子 */
    backoffFactor?: number;
    /** 可重试的状态码 */
    retryableStatusCodes?: number[];
}

/**
 * 代理配置
 */
export interface ProxyConfig {
    /** 代理主机 */
    host: string;
    /** 代理端口 */
    port: number;
    /** 代理协议 */
    protocol?: 'http' | 'https' | 'socks5';
    /** 代理认证 */
    auth?: {
        username: string;
        password: string;
    };
}

/**
 * LLM提供者接口 - 简化版
 */
export interface LLMProvider {
    /**
     * 获取模型信息
     * @returns 模型信息
     */
    getModel(): ModelInfo;

    /**
     * 设置模型
     * @param model 模型名称或配置
     */
    setModel(model: string | ModelInfo): void;

    /**
     * 创建流式响应
     * @param config 流配置
     * @returns 异步可迭代的流块
     */
    createStream(config: StreamConfig): AsyncIterable<StreamChunk>;
}

/**
 * 完成请求配置
 */
export interface CompletionConfig extends StreamConfig {
    /** 是否返回token使用情况 */
    includeUsage?: boolean;
    /** 是否返回日志概率 */
    logprobs?: boolean;
    /** 返回的日志概率数量 */
    topLogprobs?: number;
    /** 用户标识 */
    user?: string;
}

/**
 * 完成响应
 */
export interface CompletionResponse {
    /** 响应ID */
    id: string;
    /** 响应内容 */
    content: string;
    /** 模型名称 */
    model: string;
    /** 完成原因 */
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
    /** Token使用情况 */
    usage?: TokenUsage;
    /** 工具调用 */
    toolCalls?: ToolCall[];
    /** 创建时间 */
    createdAt: Date;
    /** 响应元数据 */
    metadata?: Record<string, any>;
}

/**
 * Token使用情况
 */
export interface TokenUsage {
    /** 输入token数 */
    inputTokens: number;
    /** 输出token数 */
    outputTokens: number;
    /** 总token数 */
    totalTokens: number;
    /** 缓存的输入token数（隐式或显式缓存命中） */
    cachedInputTokens?: number;
    /** 显式缓存创建时使用的输入token数 */
    cacheCreationInputTokens?: number;
    /** 显式缓存命中时读取的输入token数 */
    cacheReadInputTokens?: number;
}

/**
 * 工具调用
 */
export interface ToolCall {
    /** 调用ID */
    id: string;
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    arguments: any;
    /** 调用类型 */
    type?: 'function' | 'code_interpreter' | 'retrieval';
}

/**
 * 基础LLM提供者抽象类
 */
export abstract class BaseLLMProvider implements LLMProvider {
    protected config: LLMProviderConfig;
    protected model: ModelInfo;

    constructor(config: LLMProviderConfig) {
        this.config = config;
        this.model = {
            provider: config.provider,
            model: config.defaultModel || '',
            ...config.defaultParams,
        };
    }

    abstract createStream(config: StreamConfig): AsyncIterable<StreamChunk>;

    getModel(): ModelInfo {
        return { ...this.model };
    }

    setModel(model: string | ModelInfo): void {
        if (typeof model === 'string') {
            this.model.model = model;
        } else {
            this.model = {
                ...this.model,
                ...model,
            };
        }
    }

    getConfig(): LLMProviderConfig {
        return this.config;
    }
}

/**
 * 嵌入模型接口
 */
export interface EmbeddingProvider {
    /**
     * 创建文本嵌入
     * @param texts 文本数组
     * @param model 模型名称（可选）
     * @returns 嵌入向量数组
     */
    createEmbeddings(texts: string[], model?: string): Promise<number[][]>;

    /**
     * 获取嵌入维度
     * @param model 模型名称（可选）
     * @returns 嵌入维度
     */
    getEmbeddingDimension(model?: string): number;

    /**
     * 获取最大输入长度
     * @param model 模型名称（可选）
     * @returns 最大输入长度
     */
    getMaxInputLength(model?: string): number;
}

/**
 * 对话消息
 */
export interface Message {
    /** 消息角色 */
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** 消息内容 */
    content: string | Content[];
    /** 消息名称（用于工具消息） */
    name?: string;
    /** 工具调用ID（用于工具响应） */
    toolCallId?: string;
    /** 工具调用列表 */
    toolCalls?: ToolCall[];
    /** 消息元数据 */
    metadata?: Record<string, any>;
}
/**
 * LLM提供者工厂
 */
export interface LLMProviderFactory {
    /**
     * 创建LLM提供者
     * @param config 提供者配置
     * @returns LLM提供者实例
     */
    createProvider(config: LLMProviderConfig): LLMProvider;

    /**
     * 注册自定义提供者
     * @param name 提供者名称
     * @param factory 提供者工厂函数
     */
    registerProvider(name: string, factory: (config: LLMProviderConfig) => LLMProvider): void;

    /**
     * 获取支持的提供者列表
     * @returns 提供者名称列表
     */
    getSupportedProviders(): string[];
}

/**
 * 模型能力
 */
export interface ModelCapabilities {
    /** 是否支持流式输出 */
    streaming: boolean;
    /** 是否支持工具调用 */
    toolCalling: boolean;
    /** 是否支持视觉 */
    vision: boolean;
    /** 是否支持JSON模式 */
    jsonMode: boolean;
    /** 是否支持系统消息 */
    systemMessage: boolean;
    /** 最大上下文长度 */
    maxContextLength: number;
    /** 最大输出长度 */
    maxOutputLength: number;
    /** 支持的媒体类型 */
    supportedMediaTypes?: string[];
}