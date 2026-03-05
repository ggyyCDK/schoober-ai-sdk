/**
 * 消息传输相关类型定义
 */

import { UserMessage } from './persistence';
import { TaskState, TaskMessage } from './task';

/**
 * 消息类型
 */
export type MessageType =
    | 'task_state'
    | 'task_started'
    | 'task_paused'
    | 'task_resumed'
    | 'task_aborted'
    | 'task_completed'
    | 'task_failed'
    | 'user_message'
    | 'assistant'
    | 'tool'
    | 'tool_started'
    | 'tool_completed'
    | 'tool_failed'
    | 'partial'
    | 'stream_chunk'
    | 'subtask_created'
    | 'subtask_completed'
    | 'historical';

/**
 * 流式上下文
 */
export interface StreamingContext {
    /** 任务ID */
    taskId: string;
    /** 消息ID */
    messageId: string;
    /** 缓冲区内容 */
    buffer: string;
    /** 是否为部分消息 */
    isPartial: boolean;
    /** 最后更新时间 */
    lastChunkTime: number;
    /** 已处理的字节数 */
    processedBytes: number;
}

/**
 * 工具消息上下文
 */
export interface ToolMessageContext {
    /** 已完成的消息列表 */
    completeMessages: TaskMessage[];
    /** 部分解析的消息 */
    partialMessage?: {
        content: string;
        isStreaming: boolean;
        lastUpdate: number;
    };
    /** 当前任务状态 */
    taskState: TaskState;
    /** 流式上下文 */
    streamingContext?: StreamingContext;
}

/**
 * 消息优先级
 */
export enum MessagePriority {
    /** 低优先级 */
    LOW = 0,
    /** 普通优先级 */
    NORMAL = 1,
    /** 高优先级 */
    HIGH = 2,
    /** 紧急 */
    URGENT = 3,
}

/**
 * 消息回调函数
 * 外部系统通过此回调接收消息，并自行决定如何发送（SSE、WebSocket等）
 */
export type MessageCallback = (message: UserMessage) => void | Promise<void>;

/**
 * 消息处理器配置
 */
export interface MessageHandlerConfig {
    /** 消息回调函数 */
    onMessage?: MessageCallback;
    /** 是否启用消息队列 */
    enableQueue?: boolean;
    /** 队列最大长度 */
    maxQueueSize?: number;
    /** 批量发送的最大消息数 */
    batchSize?: number;
    /** 重试次数 */
    maxRetries?: number;
    /** 重试延迟（毫秒） */
    retryDelay?: number;
}