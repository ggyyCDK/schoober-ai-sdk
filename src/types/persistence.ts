/**
 * Persistence Manager 接口和相关类型定义
 */

import { TaskState, TaskInput } from './task';
import Anthropic from '@anthropic-ai/sdk';

/**
 * API消息（LLM对话历史）
 */
export interface ApiMessage extends Anthropic.MessageParam {
    id: string;
    ts?: number;
    taskId: string;
    /** 消息来源，用于标记消息是来自用户输入、工具返回、助手响应还是系统消息 */
    source?: 'user' | 'tool' | 'assistant' | 'system';
}

/**
 * 工具执行状态
 */
export enum ToolStatus {
    /** 准备状态，等待参数解析完成 */
    WAIT = 'wait',
    /** 执行中 */
    DOING = 'doing',
    /** 执行成功 */
    SUCCESS = 'success',
    /** 执行失败 */
    ERROR = 'error',
}

/**
 * 工具信息（统一的工具状态表示）
 */
export interface ToolInfo {
    requestId: string;
    /** 工具名称（唯一标识） */
    toolName: string;
    /** 工具显示名称 */
    displayName: string;
    /** 执行状态 */
    status: ToolStatus;
    /** 状态提示信息（如"正在查询天气..."） */
    showTip?: string;
    /** 工具参数 */
    params?: Record<string, any>;
    /** 执行结果数据 */
    result?: any;
    /** 错误信息 */
    error?: string;
    /** 执行时长（毫秒） */
    duration?: number;
    /** 开始时间 */
    startTime?: number;
    /** 结束时间 */
    endTime?: number;
    /** 结果元数据 */
    metadata?: Record<string, any>;
}

/**
 * 错误上下文
 */
export interface ErrorContext {
    /** 错误类型 */
    errorType: 'llm' | 'tool' | 'execution' | 'network' | 'timeout' | 'validation' | 'unknown';
    /** 错误代码 */
    errorCode?: string;
    /** 错误来源，如 'ExecutionManager', 'ReActEngine' 等 */
    source?: string;
    /** 请求ID */
    requestId?: string;
    /** 工具名称（如果是工具错误） */
    toolName?: string;
    /** 重试次数 */
    retryCount?: number;
    /** 额外信息 */
    additionalInfo?: Record<string, any>;
}

/**
 * 用户消息（UI展示消息）
 */
export interface UserMessage {
    /** 消息ID */
    id: string;
    /** 任务ID */
    taskId: string;
    /** 消息类型 */
    type: 'text' | 'tool' | 'error' | 'system';
    /** 消息角色 */
    role: 'user' | 'assistant' | 'system';
    /** 消息内容 */
    content?: string;
    /** 工具信息（当 type 为 'tool' 时） */
    toolInfo?: ToolInfo;
    /** 时间戳 */
    ts: number;
    /** 是否可见 */
    visible?: boolean;
    /** 元数据 */
    metadata?: Record<string, any>;
}

/**
 * 持久化管理器接口
 */
export interface PersistenceManager {
    /**
     * 保存API消息
     * @param taskId 任务ID
     * @param messages 消息列表
     */
    saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void>;

    /**
     * 加载API消息
     * @param taskId 任务ID
     * @returns 消息列表
     */
    loadApiMessages(taskId: string): Promise<ApiMessage[]>;

    /**
     * 追加API消息
     * @param taskId 任务ID
     * @param message 消息
     */
    appendApiMessage(taskId: string, message: ApiMessage): Promise<void>;

    /**
     * 删除API消息
     * @param taskId 任务ID
     */
    deleteApiMessages(taskId: string): Promise<void>;

    /**
     * 保存用户消息
     * @param taskId 任务ID
     * @param messages 消息列表
     */
    saveUserMessages(taskId: string, messages: UserMessage[]): Promise<void>;

    /**
     * 加载用户消息
     * @param taskId 任务ID
     * @returns 消息列表
     */
    loadUserMessages(taskId: string): Promise<UserMessage[]>;

    /**
     * 删除用户消息
     * @param taskId 任务ID
     */
    deleteUserMessages(taskId: string): Promise<void>;

    /**
     * 保存任务状态
     * @param taskId 任务ID
     * @param state 任务状态
     */
    saveTaskState(taskId: string, state: TaskState): Promise<void>;

    /**
     * 加载任务状态
     * @param taskId 任务ID
     * @returns 任务状态或null
     */
    loadTaskState(taskId: string): Promise<TaskState | null>;

    /**
     * 更新任务状态
     * @param taskId 任务ID
     * @param updates 状态更新
     */
    updateTaskState(taskId: string, updates: Partial<TaskState>): Promise<void>;

    /**
     * 删除任务状态
     * @param taskId 任务ID
     */
    deleteTaskState(taskId: string): Promise<void>;

    /**
     * 列出所有任务状态
     * @returns 任务状态列表
     */
    listTaskStates(): Promise<TaskState[]>;

    /**
     * 保存任务输入
     * @param taskId 任务ID
     * @param input 任务输入
     */
    saveTaskInput(taskId: string, input: TaskInput): Promise<void>;

    /**
     * 加载任务输入
     * @param taskId 任务ID
     * @returns 任务输入或null
     */
    loadTaskInput(taskId: string): Promise<TaskInput | null>;

    /**
     * 删除任务输入
     * @param taskId 任务ID
     */
    deleteTaskInput(taskId: string): Promise<void>;

    /**
     * 初始化存储
     */
    initialize?(): Promise<void>;
}

/**
 * 对话过滤条件
 */
export interface ConversationFilter {
    /** 用户ID */
    userId?: string;
    /** 开始时间 */
    startDate?: Date;
    /** 结束时间 */
    endDate?: Date;
    /** 关键词 */
    keyword?: string;
    /** 限制数量 */
    limit?: number;
    /** 偏移量 */
    offset?: number;
}

/**
 * 存储统计信息
 */
export interface StorageStats {
    /** 任务总数 */
    totalTasks: number;
    /** 消息总数 */
    totalMessages: number;
    /** 对话总数 */
    totalConversations: number;
    /** 存储大小（字节） */
    storageSize: number;
    /** 最早的数据时间 */
    oldestDataDate?: Date;
    /** 最新的数据时间 */
    newestDataDate?: Date;
}