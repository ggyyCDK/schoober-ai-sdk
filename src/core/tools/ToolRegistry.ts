import type { Tool, ToolRegistry, ToolFactory } from '@/types';
import { ValidationError } from '@/types';

/**
 * 工具注册表实现
 * 管理所有注册的工具工厂函数
 */
export class DefaultToolRegistry implements ToolRegistry {
    private factories: Map<string, ToolFactory> = new Map();

    /**
     * 注册工具工厂
     */
    registerFactory(name: string, factory: ToolFactory): void {
        if (!name) {
            throw new ValidationError('Tool name is required');
        }

        if (this.factories.has(name)) {
            throw new ValidationError(`Tool "${name}" is already registered`);
        }

        this.factories.set(name, factory);
    }

    /**
     * 获取工具工厂
     */
    getFactory(name: string): ToolFactory | undefined {
        return this.factories.get(name);
    }

    /**
     * 注销工具
     */
    unregister(name: string): void {
        this.factories.delete(name);
    }

    /**
     * 获取工具实例（用于生成prompt等场景）
     * 调用 factory(undefined) 创建临时实例
     */
    async get(name: string): Promise<Tool | undefined> {
        const factory = this.factories.get(name);
        if (!factory) {
            return undefined;
        }
        return await factory(undefined);
    }

    /**
     * 获取所有工具工厂
     */
    getAllFactories(): Map<string, ToolFactory> {
        return new Map(this.factories);
    }

    /**
     * 获取工具列表（用于生成prompt）
     * 调用每个 factory(undefined) 创建临时实例
     */
    async list(): Promise<Tool[]> {
        const tools: Tool[] = [];
        for (const factory of this.factories.values()) {
            try {
                const tool = await factory(undefined);
                tools.push(tool);
            } catch (error) {
                // Silently ignore errors when creating temporary instances
            }
        }
        return tools;
    }

    /**
     * 检查工具是否存在
     */
    has(name: string): boolean {
        return this.factories.has(name);
    }

    /**
     * 清空注册表
     */
    clear(): void {
        this.factories.clear();
    }

    /**
     * 获取工具分类
     * @deprecated 暂未使用，返回空 Map
     */
    async getCategories(): Promise<Map<string, Tool[]>> {
        return new Map();
    }

    /**
     * 根据标签获取工具
     * @deprecated 暂未使用，返回空数组
     */
    async getByTag(_tag: string): Promise<Tool[]> {
        return [];
    }

    /**
     * 搜索工具
     * @deprecated 暂未使用，返回空数组
     */
    async search(_query: string): Promise<Tool[]> {
        return [];
    }
}