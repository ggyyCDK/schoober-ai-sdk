import type { Tool, ToolDescription, ToolContext, ToolResult } from '@/types';
import { ValidationError } from '@/types';
import { z } from 'zod';

/**
 * 工具构建器配置
 */
export interface ToolBuilderConfig {
    name: string;
    description: ToolDescription;
    parameters: z.ZodSchema;
    execute: (params: any, context: ToolContext) => Promise<ToolResult>;
    validate?: (params: any) => Promise<{ valid: boolean; error?: string }>;
    initialize?: () => Promise<void>;
    dispose?: () => void;
    isAvailable?: (context?: ToolContext) => Promise<boolean>;
}

/**
 * 工具工厂配置
 */
export interface ToolFactoryConfig {
    /** 默认的工具分类 */
    defaultCategory?: string;
    /** 默认的工具版本 */
    defaultVersion?: string;
    /** 是否自动初始化工具 */
    autoInitialize?: boolean;
}

/**
 * 工具工厂类
 * 用于创建和管理工具实例
 * 
 * @example
 * ```typescript
 * const factory = new ToolFactory({
 *   defaultCategory: 'utility',
 *   autoInitialize: true
 * });
 * 
 * // 注册工具构造函数
 * factory.registerConstructor('myTool', async () => new MyTool());
 * 
 * // 创建工具实例
 * const tool = await factory.create('myTool');
 * 
 * // 使用构建器模式
 * const customTool = factory.builder()
 *   .name('customTool')
 *   .description({ displayName: 'Custom Tool', description: 'A custom tool' })
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(async (params) => ({ type: 'success', data: params }))
 *   .build();
 * ```
 */
export class ToolFactory {
    private config: ToolFactoryConfig;
    private toolConstructors = new Map<string, ToolConstructor>();
    private toolInstances = new Map<string, Tool>();

    constructor(config: ToolFactoryConfig = {}) {
        this.config = {
            defaultCategory: 'general',
            defaultVersion: '1.0.0',
            autoInitialize: false,
            ...config
        };
    }

    /**
     * 注册工具构造函数
     * @param name 工具名称
     * @param constructor 工具构造函数
     */
    registerConstructor(name: string, constructor: ToolConstructor): void {
        if (this.toolConstructors.has(name)) {
            throw new ValidationError(`Tool constructor "${name}" is already registered`);
        }
        this.toolConstructors.set(name, constructor);
    }

    /**
     * 创建工具实例
     * @param name 工具名称
     * @param config 工具配置
     */
    async create(name: string, config?: any): Promise<Tool> {
        const constructor = this.toolConstructors.get(name);
        if (!constructor) {
            throw new ValidationError(`Tool constructor "${name}" not found`);
        }

        // 创建工具实例
        const tool = await constructor(config);

        // 自动初始化
        if (this.config.autoInitialize && tool.initialize) {
            await tool.initialize();
        }

        // 缓存实例（如果是单例）
        if (config?.singleton) {
            this.toolInstances.set(name, tool);
        }

        return tool;
    }

    /**
     * 获取或创建工具实例（单例模式）
     * @param name 工具名称
     * @param config 工具配置
     */
    async getOrCreate(name: string, config?: any): Promise<Tool> {
        if (this.toolInstances.has(name)) {
            return this.toolInstances.get(name)!;
        }
        return this.create(name, { ...config, singleton: true });
    }

    /**
     * 使用构建器模式创建工具
     * @param config 工具构建器配置
     */
    createFromBuilder(config: ToolBuilderConfig): Tool {
        return new BuiltTool(config);
    }

    /**
     * 创建工具构建器
     */
    builder(): ToolBuilder {
        return new ToolBuilder(this.config);
    }

    /**
     * 清理所有工具实例
     */
    async dispose(): Promise<void> {
        const disposalPromises: Promise<void>[] = [];

        for (const tool of this.toolInstances.values()) {
            if (tool.dispose) {
                disposalPromises.push(
                    Promise.resolve().then(() => {
                        try {
                            tool.dispose!();
                        } catch (error) {
                            // Silently ignore disposal errors
                        }
                    })
                );
            }
        }

        await Promise.all(disposalPromises);
        this.toolInstances.clear();
        this.toolConstructors.clear();
    }

    /**
     * 获取已注册的工具构造函数列表
     */
    getRegisteredConstructors(): string[] {
        return Array.from(this.toolConstructors.keys());
    }

    /**
     * 获取已创建的工具实例列表
     */
    getInstances(): Map<string, Tool> {
        return new Map(this.toolInstances);
    }

    /**
     * 检查工具构造函数是否已注册
     * @param name 工具名称
     */
    hasConstructor(name: string): boolean {
        return this.toolConstructors.has(name);
    }

    /**
     * 检查工具实例是否存在
     * @param name 工具名称
     */
    hasInstance(name: string): boolean {
        return this.toolInstances.has(name);
    }

    /**
     * 移除工具实例
     * @param name 工具名称
     */
    removeInstance(name: string): void {
        const tool = this.toolInstances.get(name);
        if (tool && tool.dispose) {
            try {
                tool.dispose();
            } catch (error) {
                // Silently ignore disposal errors
            }
        }
        this.toolInstances.delete(name);
    }
}
/**
 * 工具构造函数类型
 * 简化后不再需要依赖容器参数
 */
export type ToolConstructor = (config?: any) => Promise<Tool> | Tool;

/**
 * 使用构建器模式创建的工具
 */
class BuiltTool implements Tool {
    name: string;
    private config: ToolBuilderConfig;

    constructor(config: ToolBuilderConfig) {
        this.name = config.name;
        this.config = config;
    }

    async getDescription(): Promise<ToolDescription> {
        return this.config.description;
    }

    async getParameters(): Promise<z.ZodSchema> {
        return this.config.parameters;
    }

    async execute(params: any, context: ToolContext): Promise<ToolResult> {
        return this.config.execute(params, context);
    }

    async validate(params: any): Promise<{ valid: boolean; error?: string; details?: any }> {
        if (this.config.validate) {
            return this.config.validate(params);
        }

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

    async initialize(): Promise<void> {
        if (this.config.initialize) {
            return this.config.initialize();
        }
    }

    dispose(): void {
        if (this.config.dispose) {
            this.config.dispose();
        }
    }

    async isAvailable(context?: ToolContext): Promise<boolean> {
        if (this.config.isAvailable) {
            return this.config.isAvailable(context);
        }
        return true;
    }
}

/**
 * 工具构建器
 * 提供流式API来构建工具
 */
export class ToolBuilder {
    private config: Partial<ToolBuilderConfig> = {};
    private factoryConfig: ToolFactoryConfig;

    constructor(factoryConfig: ToolFactoryConfig) {
        this.factoryConfig = factoryConfig;
    }

    /**
     * 设置工具名称
     */
    name(name: string): this {
        this.config.name = name;
        return this;
    }

    /**
     * 设置工具描述
     */
    description(description: ToolDescription): this {
        this.config.description = {
            ...description,
            category: description.category || this.factoryConfig.defaultCategory,
            version: description.version || this.factoryConfig.defaultVersion,
        };
        return this;
    }

    /**
     * 设置参数schema
     */
    parameters(schema: z.ZodSchema): this {
        this.config.parameters = schema;
        return this;
    }

    /**
     * 设置执行函数
     */
    execute(fn: (params: any, context: ToolContext) => Promise<ToolResult>): this {
        this.config.execute = fn;
        return this;
    }

    /**
     * 设置验证函数
     */
    validate(fn: (params: any) => Promise<{ valid: boolean; error?: string }>): this {
        this.config.validate = fn;
        return this;
    }

    /**
     * 设置初始化函数
     */
    initialize(fn: () => Promise<void>): this {
        this.config.initialize = fn;
        return this;
    }

    /**
     * 设置销毁函数
     */
    dispose(fn: () => void): this {
        this.config.dispose = fn;
        return this;
    }

    /**
     * 设置可用性检查函数
     */
    isAvailable(fn: (context?: ToolContext) => Promise<boolean>): this {
        this.config.isAvailable = fn;
        return this;
    }

    /**
     * 构建工具实例
     */
    build(): Tool {
        if (!this.config.name) {
            throw new ValidationError('Tool name is required');
        }
        if (!this.config.description) {
            throw new ValidationError('Tool description is required');
        }
        if (!this.config.parameters) {
            throw new ValidationError('Tool parameters schema is required');
        }
        if (!this.config.execute) {
            throw new ValidationError('Tool execute function is required');
        }

        return new BuiltTool(this.config as ToolBuilderConfig);
    }
}

/**
 * 创建默认的工具工厂实例
 * @param config 工厂配置
 */
export function createToolFactory(config?: ToolFactoryConfig): ToolFactory {
    return new ToolFactory(config);
}