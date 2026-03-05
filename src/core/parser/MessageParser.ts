/**
 * 消息解析器实现
 * 基于RooCode的AssistantMessageParser实现
 */

import { z } from 'zod';
import {
    MessageParser,
    ParsedContent,
    TextContent,
    ToolUse,
    ParserState,
    ParserConfig,
    TagHandler,
    Tool,
    ValidationError,
} from '@/types';

/**
 * SDK内置消息解析器
 * 支持流式XML解析和工具调用处理
 */
export class SDKMessageParser implements MessageParser {
    private tools: Map<string, Tool> = new Map();
    private parameterSchemas: Map<string, z.ZodSchema> = new Map();
    private toolParamNames: Map<string, Set<string>> = new Map();
    private config: ParserConfig;
    private state: ParserState;

    constructor(config?: ParserConfig) {
        this.config = {
            strictMode: false,
            validateParams: true,
            keepRawParams: true,
            maxAccumulatorSize: 1024 * 1024, // 1MB
            specialTools: [],
            customTagHandlers: new Map(),
            ...config
        };

        this.state = this.createInitialState();
    }

    /**
     * 创建初始状态
     */
    private createInitialState(): ParserState {
        return {
            accumulator: '',
            contentBlocks: [],
            currentTextContent: undefined,
            currentToolUse: undefined,
            currentParamName: undefined,
            currentParamValue: undefined,
            inToolTag: false,
            inParamTag: false,
            tagStack: [],
            inCDATA: false
        };
    }

    /**
     * 注册工具
     */
    async registerTool(tool: Tool): Promise<void> {
        this.tools.set(tool.name, tool);
        if (this.config.validateParams) {
            try {
                const schema = await tool.getParameters();
                this.parameterSchemas.set(tool.name, schema);

                // 提取并缓存参数名称
                const paramNames = this.extractParamNamesFromSchema(schema);
                if (paramNames.size > 0) {
                    this.toolParamNames.set(tool.name, paramNames);
                }
            } catch (error) {
                // Silently ignore - tools may not always have parameters ready
            }
        }
    }

    /**
     * 批量注册工具
     */
    async registerTools(tools: Tool[]): Promise<void> {
        for (const tool of tools) {
            await this.registerTool(tool);
        }
    }

    /**
     * 注销工具
     */
    unregisterTool(name: string): void {
        this.tools.delete(name);
        this.parameterSchemas.delete(name);
        this.toolParamNames.delete(name);
    }

    /**
     * 解析流式内容块
     */
    parseChunk(chunk: string): ParsedContent[] {
        // 检查累积器大小
        if (this.config.maxAccumulatorSize &&
            this.state.accumulator.length + chunk.length > this.config.maxAccumulatorSize) {
            throw new Error('Parser accumulator size exceeded maximum limit');
        }

        // 记录当前内容块数量
        const previousBlockCount = this.state.contentBlocks.length;

        // 逐字符处理
        for (let i = 0; i < chunk.length; i++) {
            const char = chunk[i];
            this.state.accumulator += char;
            this.processCharacter(i);
        }

        // 返回新增的内容块
        return this.state.contentBlocks
    }

    /**
     * 处理单个字符
     */
    private processCharacter(position: number): void {
        const { accumulator } = this.state;

        // 处理CDATA部分
        if (!this.state.inCDATA && accumulator.endsWith('<![CDATA[')) {
            this.state.inCDATA = true;
            return;
        }

        if (this.state.inCDATA) {
            if (accumulator.endsWith(']]>')) {
                // 找到 CDATA 开始标记的位置
                const cdataStartIndex = accumulator.lastIndexOf('<![CDATA[');
                // CDATA 之前的内容
                const contentBeforeCDATA = accumulator.slice(0, cdataStartIndex);
                // CDATA 内部的内容
                const cdataInnerContent = accumulator.slice(cdataStartIndex + 9, -3);

                // 将 CDATA 标记"透明化"：前部分 + CDATA内容，保留在累积器中
                this.state.accumulator = contentBeforeCDATA + cdataInnerContent;
                this.state.inCDATA = false;
                // 不再调用 handleCDATAContent，也不清空累积器
            }
            return;
        }

        // 在参数标签内收集参数值
        if (this.state.inParamTag && this.state.currentParamName) {
            const paramEndTag = `</${this.state.currentParamName}>`;
            if (accumulator.endsWith(paramEndTag)) {
                this.endParam();
                return;
            }

            // 实时更新参数值到 rawParams（流式解析的关键）
            // accumulator 在 startParam 中已经被重置，只包含参数值部分
            if (this.state.currentToolUse && this.state.currentParamName) {
                let paramValue = accumulator;

                // 特殊处理content参数（保留换行符但移除首部的单个换行符）
                if (this.state.currentParamName === 'content') {
                    paramValue = paramValue.replace(/^\n/, '');
                } else {
                    // 其他参数去除首尾空白（但在流式解析中不去除，保持原样）
                    // paramValue = paramValue.trim();
                }

                // 实时更新到 rawParams
                this.state.currentToolUse.rawParams[this.state.currentParamName] = paramValue;
            }

            // 特殊处理content参数（可能包含XML标签）
            if (this.state.currentParamName === 'content' &&
                this.state.currentToolUse &&
                this.config.specialTools?.includes(this.state.currentToolUse.name)) {
                // 对于特殊工具的content参数，需要特殊处理
                this.handleSpecialContent();
            }
            return;
        }

        // 在工具标签内
        if (this.state.inToolTag && this.state.currentToolUse) {
            // 检测工具结束标签
            const toolEndTag = `</${this.state.currentToolUse.name}>`;
            if (accumulator.endsWith(toolEndTag)) {
                this.endToolUse();
                return;
            }

            // 检测参数开始标签
            const paramMatch = this.detectParamStart();
            if (paramMatch) {
                this.startParam(paramMatch);
                return;
            }
        }

        // 检测工具开始标签
        if (!this.state.inToolTag) {
            const toolMatch = this.detectToolStart();
            if (toolMatch) {
                this.startToolUse(toolMatch);
                return;
            }

            // 处理普通文本
            this.processTextContent();
        }
    }

    /**
    * 检测工具开始标签
    */
    private detectToolStart(): string | null {
        const { accumulator } = this.state;

        // 检查所有已注册的工具
        const toolNames = Array.from(this.tools.keys());
        for (const toolName of toolNames) {
            const toolTag = `<${toolName}>`;
            if (accumulator.endsWith(toolTag)) {
                return toolName;
            }
        }

        return null;
    }

    /**
     * 检测参数开始标签
     */
    private detectParamStart(): string | null {
        const { accumulator } = this.state;

        // 只在工具标签内检测参数
        if (!this.state.currentToolUse) {
            return null;
        }

        // 获取当前工具的参数名称列表
        const toolName = this.state.currentToolUse.name;
        const paramNames = this.toolParamNames.get(toolName);

        if (paramNames) {
            // 检查是否匹配任何已知的参数名称
            for (const param of paramNames) {
                const paramTag = `<${param}>`;
                if (accumulator.endsWith(paramTag)) {
                    return param;
                }
            }
        }

        // 如果没有预定义的参数列表，使用通用检测（向后兼容）
        // 但要确保不是工具名称
        const match = accumulator.match(/<(\w+)>$/);
        if (match && !this.tools.has(match[1])) {
            return match[1];
        }

        return null;
    }

    /**
     * 从 Zod schema 中提取参数名称
     */
    private extractParamNamesFromSchema(schema: z.ZodSchema): Set<string> {
        const paramNames = new Set<string>();

        try {
            // 处理 ZodObject 类型
            if (schema instanceof z.ZodObject) {
                const shape = schema.shape;
                if (shape && typeof shape === 'object') {
                    Object.keys(shape).forEach(key => {
                        paramNames.add(key);
                    });
                }
            }
            // 处理 ZodEffects (如 refine, transform 等包装的 schema)
            else if ('_def' in schema && schema._def) {
                const def = schema._def as any;
                if (def.schema) {
                    // 递归处理内部 schema
                    return this.extractParamNamesFromSchema(def.schema);
                }
            }
            // 处理其他可能的 Zod 类型
            else if ('shape' in schema && schema.shape) {
                const shape = (schema as any).shape;
                if (shape && typeof shape === 'object') {
                    Object.keys(shape).forEach(key => {
                        paramNames.add(key);
                    });
                }
            }
        } catch (error) {
            // Silently ignore - schema extraction is a best-effort feature
        }

        return paramNames;
    }

    /**
     * 开始工具使用
     */
    private startToolUse(toolName: string): void {
        // 检查是否已经有工具调用（通过检查 contentBlocks 中是否有 tool_use 类型）
        const hasExistingToolUse = this.state.contentBlocks.some(block => block.type === 'tool_use');

        // 结束当前文本块（只在第一个工具调用前保留文本）
        if (this.state.currentTextContent) {
            // 移除工具标签的开始部分
            const toolTagStart = `<${toolName}`;
            const lastIndex = this.state.currentTextContent.text.lastIndexOf(toolTagStart);
            if (lastIndex !== -1) {
                this.state.currentTextContent.text =
                    this.state.currentTextContent.text.slice(0, lastIndex).trim();
            }

            // 如果已经有工具调用，说明这是工具调用之间的文本，应该被丢弃
            if (hasExistingToolUse) {
                // 移除这个文本块（工具调用之间的内容）
                this.state.contentBlocks.pop();
            } else if (this.state.currentTextContent.text) {
                // 第一个工具调用前的文本，保留
                this.state.currentTextContent.partial = false;
            } else {
                // 如果文本为空，移除这个块
                this.state.contentBlocks.pop();
            }
            this.state.currentTextContent = undefined;
        }

        // 创建新的工具使用块
        this.state.currentToolUse = {
            type: 'tool_use',
            id: this.generateToolId(),
            name: toolName,
            rawParams: {},
            partial: true
        };

        this.state.contentBlocks.push(this.state.currentToolUse);
        this.state.inToolTag = true;
        this.state.tagStack.push(toolName);

        // 重置累积器（丢弃工具调用之间的内容）
        this.state.accumulator = '';
    }

    /**
     * 结束工具使用
     */
    private endToolUse(): void {
        if (!this.state.currentToolUse) return;

        // 验证和转换参数
        if (this.config.validateParams) {
            this.validateToolParams();
        }

        // 直接清空 accumulator，丢弃工具调用后的所有内容
        this.state.accumulator = '';

        this.state.currentToolUse.partial = false;
        this.state.currentToolUse = undefined;
        this.state.inToolTag = false;
        this.state.tagStack.pop();
    }

    /**
     * 开始参数
     */
    private startParam(paramName: string): void {
        this.state.currentParamName = paramName;
        this.state.currentParamValue = '';
        this.state.inParamTag = true;
        this.state.tagStack.push(paramName);

        // 记录参数值的起始位置
        const paramTag = `<${paramName}>`;
        const startIndex = this.state.accumulator.lastIndexOf(paramTag) + paramTag.length;
        this.state.accumulator = this.state.accumulator.slice(startIndex);
    }

    /**
     * 结束参数
     */
    private endParam(): void {
        if (!this.state.currentToolUse || !this.state.currentParamName) return;

        const paramEndTag = `</${this.state.currentParamName}>`;
        const endIndex = this.state.accumulator.lastIndexOf(paramEndTag);

        if (endIndex !== -1) {
            let paramValue = this.state.accumulator.slice(0, endIndex);

            // 特殊处理content参数
            if (this.state.currentParamName === 'content') {
                // 保留换行符，但移除首尾的单个换行符
                paramValue = paramValue.replace(/^\n/, '').replace(/\n$/, '');
            } else {
                // 其他参数去除首尾空白
                paramValue = paramValue.trim();
            }

            this.state.currentToolUse.rawParams[this.state.currentParamName] = paramValue;
        }

        this.state.currentParamName = undefined;
        this.state.currentParamValue = undefined;
        this.state.inParamTag = false;
        this.state.tagStack.pop();
        this.state.accumulator = '';
    }
    /**
   * 处理特殊内容（如write_to_file的content参数）
   */
    private handleSpecialContent(): void {
        if (!this.state.currentToolUse || !this.state.currentParamName) return;

        const { accumulator } = this.state;
        const paramName = this.state.currentParamName;

        // 对于write_to_file等工具，content可能包含结束标签
        // 需要找到最后一个有效的结束标签
        if (this.state.currentToolUse.name === 'write_to_file' && paramName === 'content') {
            const contentEndTag = `</${paramName}>`;
            const toolEndTag = `</${this.state.currentToolUse.name}>`;

            // 查找所有content结束标签的位置
            const contentEndIndices: number[] = [];
            let searchIndex = 0;
            while (true) {
                const index = accumulator.indexOf(contentEndTag, searchIndex);
                if (index === -1) break;
                contentEndIndices.push(index);
                searchIndex = index + contentEndTag.length;
            }

            // 检查是否有工具结束标签
            const toolEndIndex = accumulator.lastIndexOf(toolEndTag);

            if (contentEndIndices.length > 0) {
                // 找到最后一个在工具结束标签之前的content结束标签
                let validEndIndex = -1;
                for (let i = contentEndIndices.length - 1; i >= 0; i--) {
                    const endIndex = contentEndIndices[i];
                    // 检查这个结束标签后是否紧跟着其他参数或工具结束标签
                    const afterTag = accumulator.slice(endIndex + contentEndTag.length).trim();
                    if (afterTag.startsWith('<') &&
                        (afterTag.startsWith(toolEndTag) || afterTag.match(/^<\/?\w+>/))) {
                        validEndIndex = endIndex;
                        break;
                    }
                }

                if (validEndIndex !== -1) {
                    // 找到有效的结束位置
                    const content = accumulator.slice(0, validEndIndex);
                    this.state.currentToolUse.rawParams[paramName] =
                        content.replace(/^\n/, '').replace(/\n$/, '');
                    this.state.currentParamName = undefined;
                    this.state.inParamTag = false;
                    this.state.tagStack.pop();

                    // 继续处理剩余内容
                    this.state.accumulator = accumulator.slice(validEndIndex + contentEndTag.length);
                }
            }
        }
    }


    /**
     * 处理文本内容
     */
    private processTextContent(): void {
        const { accumulator } = this.state;

        // 检查是否已经有工具调用
        const hasExistingToolUse = this.state.contentBlocks.some(block => block.type === 'tool_use');

        // 检查是否可能是标签的开始
        const lastOpenBracket = accumulator.lastIndexOf('<');

        if (lastOpenBracket === -1) {
            // 没有标签，全部是文本
            // 如果已经有工具调用，这是工具调用之间的内容，应该被丢弃
            if (!hasExistingToolUse) {
                // 第一个工具调用前的文本，保留
                this.appendText(accumulator);
            }
            // 丢弃工具调用之间的内容
            this.state.accumulator = '';
        } else {
            // 检查是否是有效的标签开始
            const possibleTag = accumulator.slice(lastOpenBracket);

            // 检查是否是已知的工具标签开始
            let isValidTagStart = false;
            const toolNames = Array.from(this.tools.keys());
            for (const toolName of toolNames) {
                if (possibleTag.startsWith(`<${toolName}`) ||
                    possibleTag === `<${toolName.slice(0, possibleTag.length - 1)}`) {
                    isValidTagStart = true;
                    break;
                }
            }

            if (isValidTagStart) {
                // 检测到工具标签开始
                // 如果已经有工具调用，accumulator 中的内容（工具调用之间的内容）应该被丢弃
                if (hasExistingToolUse) {
                    // 丢弃工具调用之间的内容
                    this.state.accumulator = accumulator.slice(lastOpenBracket);
                } else {
                    // 第一个工具调用前，保留工具标签前的文本
                    if (lastOpenBracket > 0) {
                        const text = accumulator.slice(0, lastOpenBracket);
                        this.appendText(text);
                    }
                    this.state.accumulator = accumulator.slice(lastOpenBracket);
                }
            } else if (!isValidTagStart && lastOpenBracket > 0) {
                // 不是有效的标签开始，将之前的内容作为文本
                // 如果已经有工具调用，这是工具调用之间的内容，应该被丢弃
                if (!hasExistingToolUse) {
                    const text = accumulator.slice(0, lastOpenBracket);
                    this.appendText(text);
                }
                this.state.accumulator = accumulator.slice(lastOpenBracket);
            }
        }
    }

    /**
     * 添加文本内容
     */
    private appendText(text: string): void {
        // 只过滤空字符串，保留换行符等空白字符
        if (!text) return;

        if (!this.state.currentTextContent) {
            this.state.currentTextContent = {
                type: 'text',
                text: '',
                partial: true
            };
            this.state.contentBlocks.push(this.state.currentTextContent);
        }

        this.state.currentTextContent.text += text;
    }

    /**
     * 验证工具参数
     */
    private validateToolParams(): void {
        if (!this.state.currentToolUse) return;

        const schema = this.parameterSchemas.get(this.state.currentToolUse.name);
        if (!schema) return;

        try {
            const result = schema.safeParse(this.state.currentToolUse.rawParams);
            if (result.success) {
                this.state.currentToolUse.params = result.data;
                this.state.currentToolUse.validated = true;
            } else {
                const errors = result.error.issues.map((e: z.ZodIssue) =>
                    `${e.path.join('.')}: ${e.message}`
                ).join(', ');

                this.state.currentToolUse.validationError = errors;
                this.state.currentToolUse.validated = false;

                if (this.config.strictMode) {
                    throw new ValidationError(
                        `Tool parameter validation failed for ${this.state.currentToolUse.name}: ${errors}`
                    );
                }
            }
        } catch (error) {
            if (this.config.strictMode) {
                throw error;
            }
            this.state.currentToolUse.validationError =
                error instanceof Error ? error.message : 'Validation failed';
            this.state.currentToolUse.validated = false;
        }
    }

    /**
     * 生成工具ID
     */
    private generateToolId(): string {
        return `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 完成解析
     */
    finalize(): ParsedContent[] {
        // 处理剩余的累积器内容
        if (this.state.accumulator) {
            // 如果在参数标签内，完成参数
            if (this.state.inParamTag && this.state.currentParamName && this.state.currentToolUse) {
                // 未完成的参数，保存当前值
                let paramValue = this.state.accumulator;
                if (this.state.currentParamName === 'content') {
                    paramValue = paramValue.replace(/^\n/, '').replace(/\n$/, '');
                } else {
                    paramValue = paramValue.trim();
                }
                this.state.currentToolUse.rawParams[this.state.currentParamName] = paramValue;
            } else if (!this.state.inToolTag) {
                // 不在工具标签内
                // 检查是否已经有工具调用
                const hasExistingToolUse = this.state.contentBlocks.some(block => block.type === 'tool_use');
                // 如果已经有工具调用，这是工具调用后的内容，应该被丢弃
                if (!hasExistingToolUse) {
                    // 第一个工具调用前的文本，保留
                    this.appendText(this.state.accumulator);
                }
                // 工具调用后的内容被丢弃
            }

            this.state.accumulator = '';
        }

        // 标记所有部分内容为完成
        for (const block of this.state.contentBlocks) {
            if (block.partial) {
                block.partial = false;
            }
        }

        // 如果有未完成的工具调用，进行验证
        if (this.state.currentToolUse && this.config.validateParams) {
            this.validateToolParams();
            this.state.currentToolUse.partial = false;
        }

        // 如果有未完成的文本内容，标记为完成
        if (this.state.currentTextContent) {
            this.state.currentTextContent.partial = false;
        }

        return [...this.state.contentBlocks];
    }

    /**
     * 重置解析器状态
     */
    reset(): void {
        this.state = this.createInitialState();
    }

    /**
     * 获取当前状态
     */
    getState(): ParserState {
        return {
            accumulator: this.state.accumulator,
            contentBlocks: [...this.state.contentBlocks],
            currentTextContent: this.state.currentTextContent ? { ...this.state.currentTextContent } : undefined,
            currentToolUse: this.state.currentToolUse ? { ...this.state.currentToolUse } : undefined,
            currentParamName: this.state.currentParamName,
            currentParamValue: this.state.currentParamValue,
            inToolTag: this.state.inToolTag,
            inParamTag: this.state.inParamTag,
            tagStack: [...this.state.tagStack],
            inCDATA: this.state.inCDATA
        };
    }

    /**
     * 设置配置
     */
    setConfig(config: ParserConfig): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * 获取已注册的工具
     */
    getTools(): Map<string, Tool> {
        return new Map(this.tools);
    }
}