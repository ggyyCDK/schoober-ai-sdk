/**
 * 通用类型定义
 */

/**
 * 验证结果
 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
    details?: Record<string, any>;
}

/**
 * 执行结果基础类型
 */
export interface BaseResult {
    type: 'success' | 'error' | 'warning';
    message?: string;
    data?: any;
}

/**
 * 模型信息
 */
export interface ModelInfo {
    provider: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
}

/**
 * 内容类型
 */
export interface Content {
    type: 'text' | 'image' | 'tool_use' | 'tool_result';
    text?: string;
    imageUrl?: string;
    toolName?: string;
    toolParams?: any;
    toolResult?: any;
}

/**
 * 图片模板格式
 * 用于在用户消息中嵌入图片
 * 格式: @|{"type":"pic","content":"base64","name":"xxx"}|
 */
export interface ImageTemplate {
    /** 类型标识，必须为 'pic' */
    type: 'pic';
    /** base64 编码的图片数据 */
    content: string;
    /** 图片名称（可选） */
    name?: string;
    /** MIME 类型（可选，如 'image/png'） */
    mediaType?: string;
}

/**
 * 图片模板正则表达式
 * 匹配格式: @|{...}|
 */
export const IMAGE_TEMPLATE_REGEX = /@\|(\{[^}]+\})\|/g;

/**
 * Token 使用情况（用于流式响应）
 */
export interface StreamUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** 缓存的输入token数（隐式或显式缓存命中） */
    cachedInputTokens?: number;
    /** 显式缓存创建时使用的输入token数 */
    cacheWriteTokens?: number;
    /** 显式缓存命中时读取的输入token数 */
    cacheReadTokens?: number;
}

/**
 * 流式响应块
 */
export type StreamChunk =
    | {
        type: 'text';
        text: string;
    }
    | {
        type: 'tool_use';
        toolName: string;
        toolParams: any;
    }
    | {
        type: 'error';
        error: string;
    }
    | {
        type: 'end';
    }
    | {
        type: 'usage';
        usage: StreamUsage;
    };

/**
 * 错误代码枚举
 */
export enum ErrorCode {
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
    TASK_EXECUTION_ERROR = 'TASK_EXECUTION_ERROR',
    TASK_NOT_FOUND = 'TASK_NOT_FOUND',
    TIMEOUT = 'TIMEOUT',
    ABORTED = 'ABORTED',
    INVALID_STATE = 'INVALID_STATE',
}

/**
 * 错误类型
 */
export class AgentSDKError extends Error {
    constructor(public code: ErrorCode | string, message: string, public details?: any) {
        super(message);
        this.name = 'AgentSDKError';
    }
}

export class ValidationError extends AgentSDKError {
    constructor(message: string, details?: any) {
        super(ErrorCode.VALIDATION_ERROR, message, details);
        this.name = 'ValidationError';
    }
}

export class ToolExecutionError extends AgentSDKError {
    constructor(message: string, toolName: string, details?: any) {
        super(ErrorCode.TOOL_EXECUTION_ERROR, message, { toolName, ...details });
        this.name = 'ToolExecutionError';
    }
}

export class TaskExecutionError extends AgentSDKError {
    constructor(message: string, taskId: string, details?: any) {
        super(ErrorCode.TASK_EXECUTION_ERROR, message, { taskId, ...details });
        this.name = 'TaskExecutionError';
    }
}

/**
 * 序列化后的错误结构
 */
export interface SerializedError {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    details?: any;
}

/**
 * 清理 details 对象，避免循环引用和过大的日志
 * @param details 要清理的 details 对象
 * @param depth 当前递归深度
 * @param maxDepth 最大递归深度
 */
export function sanitizeDetails(details: any, depth: number = 0, maxDepth: number = 3): any {
    if (depth > maxDepth) {
        return '[Max Depth Reached]';
    }

    if (details instanceof Error) {
        return serializeError(details);
    }

    if (Array.isArray(details)) {
        return details.map((item) => sanitizeDetails(item, depth + 1, maxDepth));
    }

    if (details && typeof details === 'object') {
        const sanitized: Record<string, any> = {};
        for (const [key, value] of Object.entries(details)) {
            if (value instanceof Error) {
                sanitized[key] = serializeError(value);
            } else if (typeof value === 'object' && value !== null) {
                sanitized[key] = sanitizeDetails(value, depth + 1, maxDepth);
            } else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }

    return details;
}

/**
 * 将 Error 对象转换为可序列化的普通对象
 * @param error 要序列化的错误对象
 * @returns 序列化后的错误对象
 */
export function serializeError(error: unknown): SerializedError {
    if (error instanceof AgentSDKError) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: error.code,
            details: error.details ? sanitizeDetails(error.details) : undefined,
        };
    }

    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return {
        name: 'UnknownError',
        message: String(error),
    };
}

/**
 * Logger interface for external logger injection
 */
export interface ILogger {
    info(msg: any, ...args: any[]): void;
    debug(msg: any, ...args: any[]): void;
    error(msg: any, error?: Error | unknown, ...args: any[]): void;
    warn(msg: any, ...args: any[]): void;
}

/**
 * Default console logger implementation
 */
export class ConsoleLogger implements ILogger {
    info(msg: any, ...args: any[]): void {
        console.info(msg, ...args);
    }

    debug(msg: any, ...args: any[]): void {
        console.debug(msg, ...args);
    }

    error(msg: any, error?: Error | unknown, ...args: any[]): void {
        if (error instanceof Error || (error && typeof error === 'object')) {
            const serializedError = serializeError(error);
            console.error(msg, serializedError, ...args);
        } else {
            console.error(msg, error, ...args);
        }
    }

    warn(msg: any, ...args: any[]): void {
        console.warn(msg, ...args);
    }
}

/**
 * Create a default logger instance (console-based)
 */
export function createDefaultLogger(): ILogger {
    return new ConsoleLogger();
}