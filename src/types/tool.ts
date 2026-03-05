/**
 * Tool 接口和相关类型定义
 */

import { z } from 'zod';
import { ValidationResult, BaseResult } from './common';

/**
 * 工具描述
 */
export interface ToolDescription {
    /** 工具显示名称 */
    displayName: string;
    /** 工具描述 */
    description: string;
    /** 工具类别 */
    category?: string;
    /** 工具版本 */
    version?: string;
    /** 使用示例 */
    examples?: string[];
    /** 工具标签 */
    tags?: string[];
    /** 是否为危险操作 */
    isDangerous?: boolean;
}

/**
 * 工具上下文
 */
export interface ToolContext {
    /** 任务ID */
    taskId: string;
    /** 请求ID */
    requestId: string;
    /** Agent上下文 */
    agentContext?: Record<string, any>;
    /** 自定义上下文 */
    custom?: Record<string, any>;
}

/**
 * 工具执行结果
 */
export interface ToolResult extends BaseResult {
    /** 工具名称 */
    toolName?: string;
    /** 执行时长（毫秒） */
    duration?: number;
    /** 是否使用缓存 */
    cached?: boolean;
    /** 结果元数据 */
    metadata?: Record<string, any>;
    /**
     * 是否继续ReAct循环
     * - true: 继续循环，让LLM思考下一步（默认）
     * - false: 停止循环，但不完成任务（等待外部输入）
     */
    shouldContinue?: boolean;
    /**
     * 是否完成任务
     * - true: 立即完成任务，不再继续循环
     * - false: 不完成任务（默认）
     */
    shouldComplete?: boolean;
    /**
     * 是否暂停任务
     * - true: 暂停任务执行
     * - false: 不暂停（默认）
     */
    shouldPause?: boolean;
    /**
     * 完成任务时的额外数据
     * 仅当shouldComplete=true时有效
     */
    completionData?: any;
}

/**
 * 工具参数元数据
 */
export interface ToolParameterMetadata {
    /** 参数名称 */
    name: string;
    /** 参数类型 */
    type: string;
    /** 参数描述 */
    description?: string;
    /** 是否必需 */
    required?: boolean;
    /** 默认值 */
    defaultValue?: any;
    /** 参数示例 */
    examples?: any[];
    /** 参数约束 */
    constraints?: Record<string, any>;
}

/**
 * 工具工厂函数类型
 * 用于创建工具实例，支持传入上下文
 */
export type ToolFactory = (context?: ToolContext) => Tool | Promise<Tool>;

/**
 * 工具注册配置
 */
export interface ToolRegistration {
    /** 工具名称 */
    name: string;
    /** 工具实例化函数 */
    factory: ToolFactory;
}

/**
 * 工具构造函数类型
 * 用于直接注册工具类
 */
export type ToolConstructor = new (...args: any[]) => Tool;

/**
 * 工具接口 - 支持异步获取描述和参数
 */
export interface Tool {
    /** 工具名称（唯一标识） */
    name: string;
    /** 工具显示名称（用于UI展示） */
    displayName?: string;

    /**
     * 异步获取工具描述
     * @returns 工具描述信息
     */
    getDescription(): Promise<ToolDescription>;

    /**
     * 异步获取参数schema（使用Zod定义）
     * @returns Zod schema
     */
    getParameters(): Promise<z.ZodSchema>;

    /**
     * 获取参数元数据（用于生成文档和UI）
     * @returns 参数元数据列表
     */
    getParameterMetadata?(): Promise<ToolParameterMetadata[]>;

    /**
     * 执行工具
     * @param params 工具参数（已经过验证）
     * @param context 执行上下文
     * @returns 执行结果
     */
    execute(params: any, context: ToolContext, isPartial: boolean): Promise<void | any>;

    /**
     * 验证参数（基于Zod schema自动验证）
     * @param params 待验证的参数
     * @returns 验证结果
     */
    validate(params: any): Promise<ValidationResult>;

    /**
     * 工具初始化（可选）
     */
    initialize?(): Promise<void>;

    /**
     * 工具销毁（可选）
     */
    dispose?(): void | Promise<void>;

    /**
     * 检查工具是否可用（可选）
     * @param context 检查上下文
     * @returns 是否可用
     */
    isAvailable?(context?: ToolContext): Promise<boolean>;
}

/**
 * 工具注册表接口
 */
export interface ToolRegistry {
    /**
     * 注册工具工厂
     * @param name 工具名称
     * @param factory 工具工厂函数
     */
    registerFactory(name: string, factory: ToolFactory): void;

    /**
     * 获取工具工厂
     * @param name 工具名称
     * @returns 工具工厂函数或undefined
     */
    getFactory(name: string): ToolFactory | undefined;

    /**
     * 注销工具
     * @param name 工具名称
     */
    unregister(name: string): void;

    /**
     * 获取工具实例（用于生成prompt等场景）
     * 调用 factory(undefined) 创建临时实例
     * @param name 工具名称
     * @returns 工具实例或undefined
     */
    get(name: string): Promise<Tool | undefined>;

    /**
     * 获取所有工具工厂
     * @returns 工具名称到工厂的映射
     */
    getAllFactories(): Map<string, ToolFactory>;

    /**
     * 获取工具列表（用于生成prompt）
     * 调用每个 factory(undefined) 创建临时实例
     * @returns 工具数组
     */
    list(): Promise<Tool[]>;

    /**
     * 检查工具是否存在
     * @param name 工具名称
     * @returns 是否存在
     */
    has(name: string): boolean;

    /**
     * 清空注册表
     */
    clear(): void;

    /**
     * 获取工具分类
     * @returns 分类到工具的映射
     */
    getCategories(): Promise<Map<string, Tool[]>>;

    /**
     * 根据标签获取工具
     * @param tag 标签
     * @returns 工具列表
     */
    getByTag(tag: string): Promise<Tool[]>;

    /**
     * 搜索工具
     * @param query 搜索关键词
     * @returns 匹配的工具列表
     */
    search(query: string): Promise<Tool[]>;
}
/**
 * 工具执行器接口
 */
export interface ToolExecutor {
    /**
     * 执行工具
     * @param toolName 工具名称
     * @param params 工具参数
     * @param context 执行上下文
     * @returns 执行结果
     */
    execute(toolName: string, params: any, context: ToolContext): Promise<ToolResult>;

    /**
     * 批量执行工具
     * @param executions 执行请求列表
     * @returns 执行结果列表
     */
    executeBatch(executions: ToolExecutionRequest[]): Promise<ToolResult[]>;

    /**
     * 并行执行工具
     * @param executions 执行请求列表
     * @returns 执行结果列表
     */
    executeParallel(executions: ToolExecutionRequest[]): Promise<ToolResult[]>;

    /**
     * 顺序执行工具（支持管道）
     * @param executions 执行请求列表
     * @returns 最终执行结果
     */
    executeSequential(executions: ToolExecutionRequest[]): Promise<ToolResult>;
}

/**
 * 工具执行请求
 */
export interface ToolExecutionRequest {
    /** 工具名称 */
    toolName: string;
    /** 工具参数 */
    params: any;
    /** 执行上下文（可选） */
    context?: Partial<ToolContext>;
    /** 是否跳过验证 */
    skipValidation?: boolean;
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 重试配置 */
    retry?: {
        maxAttempts: number;
        delay: number;
        backoff?: 'linear' | 'exponential';
    };
}

/**
 * 工具使用统计
 */
export interface ToolUsageStats {
    /** 工具名称 */
    toolName: string;
    /** 执行次数 */
    executionCount: number;
    /** 成功次数 */
    successCount: number;
    /** 失败次数 */
    failureCount: number;
    /** 平均执行时间（毫秒） */
    averageDuration: number;
    /** 最短执行时间 */
    minDuration: number;
    /** 最长执行时间 */
    maxDuration: number;
    /** 最后执行时间 */
    lastExecutedAt?: Date;
    /** 错误分布 */
    errorDistribution?: Record<string, number>;
}