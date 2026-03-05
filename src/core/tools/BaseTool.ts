import type {
    Tool,
    ToolDescription,
    ToolContext,
    ToolResult,
    ToolParameterMetadata,
    ValidationResult,
    ToolInfo,
    TaskState,
} from '@/types';
import { ToolStatus } from '@/types';
import { z } from 'zod';
import { TaskExecutor } from '../task/TaskExecutor';

/**
 * 工具状态选项
 */
type ToolStatusOptions = {
    showTip?: string;
    params?: Record<string, any>;
    result?: any;
    error?: string;
    metadata?: Record<string, any>;
};

export abstract class BaseTool implements Tool {
    /**
     * 工具名称（唯一标识）
     */
    abstract name: string;

    /**
     * 工具显示名称（用于UI展示）
     * 子类应该设置此属性，如果未设置则使用 name
     */
    displayName?: string;

    /**
     * 消息处理器（由Task在执行时注入）
     */
    protected taskExecutor?: TaskExecutor;

    /**
     * 当前状态缓存
     * 用于在同一个工具执行过程中累积状态信息
     */
    private _currentStatus?: Partial<ToolInfo>;

    /**
     * 获取工具描述
     */
    abstract getDescription(): Promise<ToolDescription>;

    /**
     * 获取参数schema
     */
    abstract getParameters(): Promise<z.ZodSchema>;

    /**
     * 执行工具
     * 注意：工具不应该返回值，应该通过 setToolResult 设置 API 消息结果
     */
    abstract execute(params: any, context: ToolContext, isPartial: boolean): Promise<void>;

    /**
     * 设置消息处理器
     * @param handler 消息处理器
     */
    setTaskExecutor(taskExecutor: TaskExecutor): void {
        this.taskExecutor = taskExecutor;
    }

    getTaskExecutor(): TaskExecutor | undefined {
        return this.taskExecutor;
    }


    getTaskState(): TaskState | undefined {
        return this.taskExecutor?.getState();
    }

    /**
     * 发送工具状态消息（便捷方法）
     * 自动填充 toolName 和 displayName，支持增量更新
     * 
     * 注意：此方法会将新的状态信息与之前的状态信息合并，
     * 只有在状态变为 SUCCESS 或 ERROR 后才会清理缓存
     * 
     * 每个工具实例对应一个 Task，状态由实例隔离
     * 但在同一个工具执行过程中（同一个 requestId），状态会累积
     *
     * @param requestId 请求ID
     * @param status 工具执行状态
     * @param options 状态选项
     *
     * @example
     * ```typescript
     * // 第一次：等待状态，设置 params
     * await this.sendToolStatus(context.requestId, ToolStatus.WAIT, {
     *   showTip: '正在准备...',
     *   params: { city: '北京' }
     * });
     *
     * // 第二次：执行中，更新 showTip，params 会保留
     * await this.sendToolStatus(context.requestId, ToolStatus.DOING, {
     *   showTip: '正在查询天气...'
     * });
     *
     * // 第三次：成功，添加 result，params 和之前的信息都会保留
     * await this.sendToolStatus(context.requestId, ToolStatus.SUCCESS, {
     *   result: { temperature: 15 }
     * });
     * ```
     */
    protected async sendToolStatus(
        requestId: string,
        status: ToolStatus,
        options?: ToolStatusOptions
    ): Promise<void> {
        if (!this.taskExecutor) {
            return;
        }

        const now = Date.now();

        // 初始化或重置状态（如果需要）
        this.initializeStatusIfNeeded(requestId, status, now);

        // 计算执行时间
        const timing = this.calculateTiming(status, now);

        // 合并选项到状态
        const mergedOptions = this.mergeStatusOptions(options);

        // 构建最终状态
        this._currentStatus = {
            ...this._currentStatus,
            status,
            requestId,
            ...mergedOptions,
            ...timing,
        };

        // 发送完整的工具信息
        await this.taskExecutor.sendUserMessageFromTool(this._currentStatus as ToolInfo);

        // 如果执行结束（成功或失败），清理缓存
        if (this.isTerminalStatus(status)) {
            this._currentStatus = undefined;
        }
    }

    /**
     * 判断是否为终态（成功或失败）
     */
    private isTerminalStatus(status: ToolStatus): boolean {
        return status === ToolStatus.SUCCESS || status === ToolStatus.ERROR;
    }

    /**
     * 初始化或重置状态（如果需要）
     * 当没有当前状态、状态为 WAIT 或 requestId 变化时，重置状态
     */
    private initializeStatusIfNeeded(
        requestId: string,
        status: ToolStatus,
        now: number
    ): void {
        const shouldReset =
            !this._currentStatus ||
            status === ToolStatus.WAIT ||
            this._currentStatus.requestId !== requestId;

        if (shouldReset) {
            this._currentStatus = {
                toolName: this.name,
                displayName: this.displayName || this.name,
                requestId,
                startTime: now,
            };
        }
    }

    /**
     * 计算执行时间和结束时间
     * 仅在终态（SUCCESS/ERROR）时计算
     */
    private calculateTiming(
        status: ToolStatus,
        now: number
    ): { duration?: number; endTime?: number } {
        if (!this.isTerminalStatus(status) || !this._currentStatus) {
            return {};
        }

        const startTime = this._currentStatus.startTime || now;
        const endTime = now;
        const duration = endTime - startTime;

        return { duration, endTime };
    }

    /**
     * 合并选项到状态
     * 处理 params 和 metadata 的深度合并，其他字段直接覆盖
     */
    private mergeStatusOptions(
        options?: ToolStatusOptions
    ): Partial<ToolInfo> {
        if (!options) {
            return {};
        }

        const merged: Partial<ToolInfo> = {};

        // showTip: 如果提供了值则更新
        if (options.showTip !== undefined) {
            merged.showTip = options.showTip;
        }

        // params: 深度合并
        if (options.params !== undefined) {
            const existingParams =
                (this._currentStatus?.params as Record<string, any>) || {};
            merged.params = { ...existingParams, ...options.params };
        }

        // result: 直接覆盖
        if (options.result !== undefined) {
            merged.result = options.result;
        }

        // error: 直接覆盖
        if (options.error !== undefined) {
            merged.error = options.error;
        }

        // metadata: 深度合并
        if (options.metadata !== undefined) {
            const existingMetadata =
                (this._currentStatus?.metadata as Record<string, any>) || {};
            merged.metadata = { ...existingMetadata, ...options.metadata };
        }

        return merged;
    }


    protected async setToolResult(requestId: string, content: string) {
        if (!this.taskExecutor) return
        await this.taskExecutor.insertApiMessage({
            id: requestId,
            taskId: this.taskExecutor.id,
            content: content,
            role: 'user',
            ts: Date.now(),
            source: 'tool',
        })
    }

    /**
     * 验证参数
     * 提供基于Zod schema的默认验证实现
     */
    async validate(params: any): Promise<ValidationResult> {
        try {
            const schema = await this.getParameters();
            const result = schema.safeParse(params);

            if (result.success) {
                return { valid: true };
            } else {
                const errors = result.error.issues.map((e: z.ZodIssue) =>
                    `${e.path.join('.')}: ${e.message}`
                ).join(', ');
                return {
                    valid: false,
                    error: errors,
                    details: result.error.issues
                };
            }
        } catch (error) {
            return {
                valid: false,
                error: error instanceof Error ? error.message : 'Validation failed'
            };
        }
    }

    /**
     * 获取参数元数据
     * 子类可以重写此方法以提供更详细的参数信息
     */
    async getParameterMetadata?(): Promise<ToolParameterMetadata[]> {
        // 默认返回空数组，子类可以重写
        return [];
    }

    /**
     * 工具初始化
     * 子类可以重写此方法进行初始化操作
     */
    async initialize?(): Promise<void> {
        // 默认空实现
    }

    /**
     * 工具销毁
     * 子类可以重写此方法进行清理操作
     */
    dispose?(): void {
        // 清理状态缓存
        this._currentStatus = undefined;
    }

    /**
     * 检查工具是否可用
     * 子类可以重写此方法实现可用性检查
     */
    async isAvailable?(context?: ToolContext): Promise<boolean> {
        return true;
    }


    // ============= 辅助方法 =============

    /**
     * 测量异步函数执行时间
     * @param fn 要执行的异步函数
     * @returns [结果, 执行时间(毫秒)]
     */
    protected async measureExecutionTime<T>(
        fn: () => Promise<T>
    ): Promise<[T, number]> {
        const start = Date.now();
        const result = await fn();
        const duration = Date.now() - start;
        return [result, duration];
    }

    /**
     * @deprecated 不再需要创建返回结果，请使用 setToolResult 设置 API 消息
     * 创建成功结果
     * @param data 返回数据
     * @param metadata 元数据
     */
    protected createSuccessResult(
        data: any,
        metadata?: Record<string, any>
    ): ToolResult {
        return {
            type: 'success',
            data,
            toolName: this.name,
            metadata: {
                ...metadata,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * @deprecated 不再需要创建返回结果，请使用 setToolResult 设置 API 消息
     * 创建错误结果
     * @param error 错误信息或错误对象
     * @param metadata 元数据
     */
    protected createErrorResult(
        error: string | Error,
        metadata?: Record<string, any>
    ): ToolResult {
        return {
            type: 'error',
            message: error instanceof Error ? error.message : error,
            toolName: this.name,
            metadata: {
                ...metadata,
                timestamp: new Date().toISOString(),
                errorStack: error instanceof Error ? error.stack : undefined
            }
        };
    }

    /**
     * @deprecated 不再需要包装执行，请直接在 execute 方法中处理错误并调用 setToolResult
     * 包装执行函数，自动处理错误和计时
     * @param fn 要执行的函数
     * @param context 执行上下文
     */
    protected async wrapExecution<T>(
        fn: () => Promise<T>,
        context?: ToolContext
    ): Promise<ToolResult> {
        try {
            const [result, duration] = await this.measureExecutionTime(fn);
            return this.createSuccessResult(result, {
                duration,
                context: context?.custom
            });
        } catch (error) {
            return this.createErrorResult(
                error instanceof Error ? error : new Error(String(error)),
                { context: context?.custom }
            );
        }
    }

    /**
     * 记录日志（可被子类重写以使用自定义日志器）
     * @param level 日志级别
     * @param message 日志消息
     * @param data 附加数据
     */
    protected log(
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
        data?: any
    ): void {
        // Use logger from TaskExecutor if available, otherwise fall back to console
        const logger = this.taskExecutor ? (this.taskExecutor as any).logger : undefined;

        // 构建规范格式的日志标识符：BaseTool_工具名_阶段_步骤
        const logTag = `BaseTool_${this.name}_${message}`;
        const logData = {
            toolName: this.name,
            ...(data || {})
        };

        if (logger) {
            switch (level) {
                case 'debug':
                    logger.debug(logTag, logData);
                    break;
                case 'info':
                    logger.info(logTag, logData);
                    break;
                case 'warn':
                    logger.warn(logTag, logData);
                    break;
                case 'error':
                    logger.error(logTag, logData);
                    break;
            }
        } else {
            // Fallback to console if logger not available
            switch (level) {
                case 'debug':
                    console.debug(logTag, logData);
                    break;
                case 'info':
                    console.info(logTag, logData);
                    break;
                case 'warn':
                    console.warn(logTag, logData);
                    break;
                case 'error':
                    console.error(logTag, logData);
                    break;
            }
        }
    }

    /**
     * 验证必需的上下文字段
     * @param context 工具上下文
     * @param requiredFields 必需的字段列表
     */
    protected validateContext(
        context: ToolContext,
        requiredFields: (keyof ToolContext)[]
    ): void {
        const missingFields = requiredFields.filter(field => !context[field]);
        if (missingFields.length > 0) {
            throw new Error(
                `Missing required context fields: ${missingFields.join(', ')}`
            );
        }
    }

    /**
     * 安全地获取嵌套属性值
     * @param obj 对象
     * @param path 属性路径
     * @param defaultValue 默认值
     */
    protected getNestedValue<T = any>(
        obj: any,
        path: string,
        defaultValue?: T
    ): T {
        const keys = path.split('.');
        let result = obj;

        for (const key of keys) {
            if (result == null) {
                return defaultValue as T;
            }
            result = result[key];
        }

        return result ?? defaultValue;
    }
}

/**
 * 创建简单工具的辅助函数
 * 用于快速创建不需要复杂继承的工具
 * 
 * @example
 * ```typescript
 * const echoTool = createSimpleTool({
 *   name: 'echo',
 *   description: {
 *     displayName: 'Echo Tool',
 *     description: 'Echoes the input'
 *   },
 *   parameters: z.object({
 *     message: z.string()
 *   }),
 *   execute: async (params, context, isPartial) => {
 *     if (isPartial) return;
 *
 *     const result = { echo: params.message };
 *     // 必须设置API消息结果
 *     await this.setToolResult(context.requestId, JSON.stringify(result));
 *   }
 * });
 * ```
 */
export function createSimpleTool(config: {
    name: string;
    description: ToolDescription;
    parameters: z.ZodSchema;
    execute: (params: any, context: ToolContext, isPartial: boolean) => Promise<void>;
    initialize?: () => Promise<void>;
    dispose?: () => void;
    isAvailable?: (context?: ToolContext) => Promise<boolean>;
}): Tool {
    return new class extends BaseTool {
        name = config.name;

        async getDescription() {
            return config.description;
        }

        async getParameters() {
            return config.parameters;
        }

        async execute(params: any, context: ToolContext, isPartial: boolean) {
            return config.execute(params, context, isPartial);
        }

        async initialize() {
            if (config.initialize) {
                await config.initialize();
            }
        }

        dispose() {
            if (config.dispose) {
                config.dispose();
            }
        }

        async isAvailable(context?: ToolContext) {
            if (config.isAvailable) {
                return config.isAvailable(context);
            }
            return true;
        }
    };
}