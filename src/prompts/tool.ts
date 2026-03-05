/**
 * 工具定义生成器
 * 用于将注册的工具转换为提示词格式
 */

import { Tool } from '@/types';
import { z } from 'zod';

/**
 * 将 Zod schema 转换为可读的参数描述
 */
function formatSchema(schema: any): string {
    try {
        const jsonSchema = z.toJSONSchema(schema)

        if (jsonSchema && typeof jsonSchema === 'object' && jsonSchema.type === 'object' && jsonSchema.properties) {
            const properties = jsonSchema.properties as Record<string, any>;
            const required = (jsonSchema.required as string[]) || [];

            const lines: string[] = [];
            for (const [key, prop] of Object.entries(properties)) {
                const isRequired = required.includes(key);
                const requiredMark = isRequired ? ' (required)' : ' (optional)';
                const description = prop.description ? ` - ${prop.description}` : '';
                const type = prop.type || 'any';

                lines.push(`  - ${key}: ${type}${requiredMark}${description}`);

                // 如果有枚举值，显示可选项
                if (prop.enum && Array.isArray(prop.enum)) {
                    lines.push(`    Allowed values: ${prop.enum.join(', ')}`);
                }
            }

            return lines.join('\n');
        }

        return '  No parameters';
    } catch (error) {
        // 开发调试日志：schema 格式化失败不影响工具使用，仅记录警告
        console.warn('Failed to format schema:', error);
        return '  Schema unavailable';
    }
}

/**
 * 生成单个工具的定义文本
 */
async function generateToolDefinition(tool: Tool): Promise<string> {
    const description = await tool.getDescription();
    const parameters = await tool.getParameters();

    const lines: string[] = [];

    // 工具名称和显示名称
    lines.push(`## ${tool.name}`);
    if (description.displayName && description.displayName !== tool.name) {
        lines.push(`Display Name: ${description.displayName}`);
    }

    // 描述
    if (description.description) {
        lines.push(`Description: ${description.description}`);
    }

    // 分类
    if (description.category) {
        lines.push(`Category: ${description.category}`);
    }

    // 参数
    lines.push('\nParameters:');
    const paramSchema = formatSchema(parameters);
    lines.push(paramSchema);

    // 示例
    if (description.examples && description.examples.length > 0) {
        lines.push('\nExamples:');
        description.examples.forEach((example: any) => {
            lines.push(`  ${example}`);
        });
    }

    return lines.join('\n');
}

/**
 * 生成完整的工具定义提示词
 * @param tools 已注册的工具列表
 * @returns 包含所有工具定义的提示词
 */
export async function generateToolsPrompt(tools: Tool[]): Promise<string> {
    if (tools.length === 0) {
        return '';
    }

    const sections: string[] = [];

    sections.push('# Available Tools');
    sections.push('');
    sections.push(`You have access to the following ${tools.length} tool(s):`);
    sections.push('');

    // 生成每个工具的定义
    for (const tool of tools) {
        try {
            const definition = await generateToolDefinition(tool);
            sections.push(definition);
            sections.push('');
        } catch (error) {
            // 开发调试日志：工具定义生成失败不影响其他工具，仅记录警告
            console.warn(`Failed to generate definition for tool ${tool.name}:`, error);
        }
    }

    return sections.join('\n');
}