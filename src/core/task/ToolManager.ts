/**
 * 工具管理器 - 负责工具的注册、执行和审批
 *
 * 核心改进:
 * - 工具通过Task对象处理消息
 * - 工具执行前后发送消息
 * - Task 层提供消息处理接口
 */

import { Tool, ToolContext, ToolResult, ToolExecutionRequest, ToolUse, ApiMessage, UserMessage, AgentSDKError, ILogger, createDefaultLogger, ToolRegistry } from '@/types';
import { BaseTool } from '../tools/BaseTool';
import { TaskExecutor } from './TaskExecutor';

/**
 * Task消息处理接口
 * 用于避免循环依赖,定义Task需要提供的消息处理能力
 */
export interface TaskMessageHandler {
    /**
     * 发送用户消息（包含新增和更新）
     */
    sendUserMessage(message: UserMessage): Promise<void>;

    /**
     * 插入 API 消息
     */
    insertApiMessage(message: ApiMessage): Promise<void>;
}

/**
 * 工具管理器配置
 */
export interface ToolManagerConfig {
    /** 工具注册表（用于获取工具工厂） */
    toolRegistry: ToolRegistry;
    /** 系统工具列表（需要实例化的系统工具） */
    systemTools?: Tool[];
    /** 工具执行超时(毫秒) */
    executionTimeout?: number;
    /** 日志记录器（可选） */
    logger?: ILogger;
}

/**
 * 工具执行统计
 */
export interface ToolExecutionStats {
    /** 工具名称 */
    toolName: string;
    /** 执行次数 */
    executionCount: number;
    /** 成功次数 */
    successCount: number;
    /** 失败次数 */
    failureCount: number;
    /** 总执行时间(毫秒) */
    totalDuration: number;
    /** 平均执行时间(毫秒) */
    averageDuration: number;
}

/**
 * 工具管理器实现
 * 负责工具的实例管理和执行
 */
export class ToolManager {
    private toolRegistry: ToolRegistry;
    private systemTools: Map<string, Tool> = new Map();

    // 两级缓存
    /** Task 级别缓存：每个工具名称对应一个实例 */
    private taskToolInstances: Map<string, Tool> = new Map();
    /** ToolUse.id 级别缓存：同一个 ToolUse.id 复用实例（用于流式执行） */
    private toolUseInstanceCache: Map<string, Tool> = new Map();

    private executionTimeout: number;
    private executionStats: Map<string, ToolExecutionStats> = new Map();
    private logger: ILogger;

    constructor(config: ToolManagerConfig) {
        if (!config.toolRegistry) {
            throw new Error('ToolRegistry is required');
        }

        this.toolRegistry = config.toolRegistry;
        this.executionTimeout = config.executionTimeout ?? 300000 * 2; // 默认10分钟
        this.logger = config.logger || createDefaultLogger();

        // 注册系统工具（系统工具直接使用实例）
        if (config.systemTools) {
            for (const tool of config.systemTools) {
                this.systemTools.set(tool.name, tool);
                this.initializeStats(tool.name);
            }
        }
    }

    /**
     * 初始化统计
     */
    private initializeStats(toolName: string): void {
        if (!this.executionStats.has(toolName)) {
            this.executionStats.set(toolName, {
                toolName,
                executionCount: 0,
                successCount: 0,
                failureCount: 0,
                totalDuration: 0,
                averageDuration: 0,
            });
        }
    }

    /**
     * 获取或创建工具实例
     * 使用两级缓存策略：
     * 1. 优先使用 ToolUse.id 缓存（流式执行复用）
     * 2. 使用 Task 级别的工具实例（常规执行）
     * 3. 用户注册的工具（ToolRegistry）优先于系统工具
     * 4. 系统工具作为兜底
     */
    private async getOrCreateToolInstance(
        toolUse: ToolUse,
        context: ToolContext
    ): Promise<Tool> {
        const toolName = toolUse.name;

        // 1. 优先使用 ToolUse.id 缓存（流式执行复用）
        if (toolUse.id && this.toolUseInstanceCache.has(toolUse.id)) {
            return this.toolUseInstanceCache.get(toolUse.id)!;
        }


        // 2. 用户注册的工具优先（可覆盖系统工具）
        const factory = this.toolRegistry.getFactory(toolName);
        if (factory) {
            const instance = await factory(context);
            this.taskToolInstances.set(toolName, instance);
            if (toolUse.id) {
                this.toolUseInstanceCache.set(toolUse.id, instance);
            }
            this.initializeStats(toolName);
            return instance;
        }

        // 3. 系统工具作为兜底
        if (this.systemTools.has(toolName)) {
            const instance = this.systemTools.get(toolName)!;
            if (toolUse.id) {
                this.toolUseInstanceCache.set(toolUse.id, instance);
            }
            return instance;
        }

        throw new AgentSDKError(
            `Tool factory not found: ${toolName}`,
            'TOOL_NOT_FOUND',
            { toolName }
        );
    }

    /**
     * 获取工具（用于兼容性，返回 Task 级别的实例）
     */
    getTool(name: string): Tool | undefined {
        return this.taskToolInstances.get(name) || this.systemTools.get(name);
    }
    /**
     * 清理所有缓存的工具实例
     * 在 Task 完成或销毁时调用
     */
    cleanup(): void {
        // 清理 Task 级别的实例
        for (const tool of this.taskToolInstances.values()) {
            if (tool.dispose) {
                try {
                    tool.dispose();
                } catch (error) {
                    this.logger.warn("ToolManager_disposeTool_error", {
                        toolName: tool.name,
                        error
                    });
                }
            }
        }
        this.taskToolInstances.clear();

        // 清理 ToolUse.id 级别的缓存（不需要 dispose，因为实例已经在 Task 级别清理）
        this.toolUseInstanceCache.clear();

        // 注意：系统工具不需要清理，因为它们会被复用
    }

    /**
     * 转换参数对象中的布尔值字符串为布尔值
     * 递归处理嵌套对象和数组
     * @param params 参数对象
     * @returns 转换后的参数对象
     */

    private convertBooleanStrings(params: any): any {
        if (params === null || params === undefined) {
            return params;
        }

        // 如果是字符串，检查是否为布尔值字符串
        if (typeof params === 'string') {
            const trimmed = params.trim().toLowerCase();
            if (trimmed === 'true') {
                return true;
            }
            if (trimmed === 'false') {
                return false;
            }
            return params; // 不是布尔值字符串，返回原值
        }

        // 如果是数组，递归处理每个元素
        if (Array.isArray(params)) {
            return params.map(item => this.convertBooleanStrings(item));
        }

        // 如果是对象，递归处理每个属性
        if (typeof params === 'object') {
            const converted: any = {};
            for (const [key, value] of Object.entries(params)) {
                converted[key] = this.convertBooleanStrings(value);
            }
            return converted;
        }

        // 其他类型直接返回
        return params;
    }

    /**
     * 执行工具
     *
     * 核心改进:
     * - 工具通过Task对象处理消息
     * - 工具内部可以使用 BaseToolMessageHandler 操作消息
     * - 工具不再返回 ToolResult，而是通过 setToolResult 设置 API 消息
     *
     * @param toolUse - 工具使用信息
     * @param context - 工具上下文
     * @param taskExecutor - Task执行器
     */
    async executeTool(
        toolUse: ToolUse,
        context: ToolContext,
        taskExecutor: TaskExecutor
    ): Promise<void> {
        const startTime = Date.now();

        try {
            // 获取或创建工具实例（使用两级缓存）
            const tool = await this.getOrCreateToolInstance(toolUse, context);

            // 验证参数
            if (toolUse.validated === false) {
                // 尝试转换布尔值字符串后重新验证
                try {
                    const convertedParams = this.convertBooleanStrings(toolUse.rawParams);
                    const schema = await tool.getParameters();
                    const result = schema.safeParse(convertedParams);

                    if (result.success) {
                        // 转换后验证成功，更新参数并继续执行
                        toolUse.params = result.data;
                        toolUse.validated = true;
                        this.logger.debug("ToolManager_executeTool_paramsConverted", {
                            toolName: toolUse.name
                        });
                    } else {
                        // 转换后仍然验证失败，抛出原始错误
                        const errorMessage = `Tool parameter validation failed: ${toolUse.validationError}`;

                        // 参数验证失败也要设置 API 消息（除非是 partial）
                        if (!toolUse.partial) {
                            await taskExecutor.insertApiMessage({
                                id: context.requestId,
                                taskId: context.taskId,
                                role: 'user',
                                content: JSON.stringify({
                                    error: errorMessage,
                                    success: false,
                                    toolName: toolUse.name,
                                }),
                                ts: Date.now(),
                                source: 'tool',
                            });
                        }

                        throw new AgentSDKError(
                            errorMessage,
                            'TOOL_VALIDATION_ERROR',
                            { toolName: toolUse.name, error: toolUse.validationError }
                        );
                    }
                } catch (error) {
                    // 如果错误已经是 AgentSDKError（重新验证失败），直接抛出
                    if (error instanceof AgentSDKError) {
                        throw error;
                    }

                    // 转换或重新验证过程中出错，使用原始错误
                    const errorMessage = `Tool parameter validation failed: ${toolUse.validationError}`;

                    // 参数验证失败也要设置 API 消息（除非是 partial）
                    if (!toolUse.partial) {
                        await taskExecutor.insertApiMessage({
                            id: context.requestId,
                            taskId: context.taskId,
                            role: 'user',
                            content: JSON.stringify({
                                error: errorMessage,
                                success: false,
                                toolName: toolUse.name,
                            }),
                            ts: Date.now(),
                            source: 'tool',
                        });
                    }

                    throw new AgentSDKError(
                        errorMessage,
                        'TOOL_VALIDATION_ERROR',
                        { toolName: toolUse.name, error: toolUse.validationError }
                    );
                }
            }

            // 注入消息处理器到工具（如果工具是BaseTool）
            if (taskExecutor && tool instanceof BaseTool) {
                tool.setTaskExecutor(taskExecutor);
            }

            // 执行工具(带超时)
            // 对最终使用的参数进行转换，确保即使验证通过但参数中仍有字符串形式的布尔值，也能正确处理
            const finalParams = toolUse.params || toolUse.rawParams;
            const convertedParams = this.convertBooleanStrings(finalParams);

            await this.executeWithTimeout(
                tool,
                convertedParams,
                context,
                toolUse.partial
            );

            // 更新统计
            const duration = Date.now() - startTime;
            this.updateStats(toolUse.name, true, duration);

        } catch (error) {
            // 更新统计
            const duration = Date.now() - startTime;
            this.updateStats(toolUse.name, false, duration);

            // 抛出错误以触发错误追踪
            throw error;
        }
    }

    /**
     * 带超时的工具执行
     */
    private async executeWithTimeout(
        tool: Tool,
        params: any,
        context: ToolContext,
        isPartial: boolean = false
    ): Promise<void> {
        await Promise.race([
            tool.execute(params, context, isPartial),
            new Promise<void>((_, reject) => {
                setTimeout(() => {
                    reject(new AgentSDKError(
                        `Tool execution timeout after ${this.executionTimeout}ms`,
                        'TOOL_TIMEOUT',
                        { toolName: tool.name, timeout: this.executionTimeout }
                    ));
                }, this.executionTimeout);
            })
        ]);
    }

    /**
     * 更新工具执行统计
     */
    private updateStats(toolName: string, success: boolean, duration: number): void {
        const stats = this.executionStats.get(toolName);
        if (!stats) {
            // 如果统计不存在，初始化它
            this.initializeStats(toolName);
            const newStats = this.executionStats.get(toolName)!;
            newStats.executionCount++;
            if (success) {
                newStats.successCount++;
            } else {
                newStats.failureCount++;
            }
            newStats.totalDuration += duration;
            newStats.averageDuration = newStats.totalDuration / newStats.executionCount;
            return;
        }
        stats.executionCount++;
        if (success) {
            stats.successCount++;
        } else {
            stats.failureCount++;
        }
        stats.totalDuration += duration;
        stats.averageDuration = stats.totalDuration / stats.executionCount;

        this.executionStats.set(toolName, stats);
    }

    /**
     * 获取工具执行统计
     */
    getToolStats(toolName?: string): ToolExecutionStats | ToolExecutionStats[] {
        if (toolName) {
            const stats = this.executionStats.get(toolName);
            if (!stats) {
                throw new AgentSDKError(
                    `No stats found for tool: ${toolName}`,
                    'TOOL_NOT_FOUND'
                );
            }
            return stats;
        }

        return Array.from(this.executionStats.values());
    }

    /**
     * 重置统计
     */
    resetStats(toolName?: string): void {
        if (toolName) {
            const stats = this.executionStats.get(toolName);
            if (stats) {
                this.executionStats.set(toolName, {
                    toolName,
                    executionCount: 0,
                    successCount: 0,
                    failureCount: 0,
                    totalDuration: 0,
                    averageDuration: 0,
                });
            }
        } else {
            for (const [name] of this.executionStats) {
                this.executionStats.set(name, {
                    toolName: name,
                    executionCount: 0,
                    successCount: 0,
                    failureCount: 0,
                    totalDuration: 0,
                    averageDuration: 0,
                });
            }
        }
    }
}

/**
 * 创建工具管理器
 */
export function createToolManager(config: ToolManagerConfig): ToolManager {
    return new ToolManager(config);
}