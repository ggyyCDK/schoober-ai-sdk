/**
 * Parser 相关类型定义
 *
 * 基于RooCode的AssistantMessageParser实现
 * 参考：third_partry/src/core/assistant-message/AssistantMessageParser.ts
 */

import { Tool } from './tool';
import { ValidationError } from './common';

/**
 * 解析内容类型
 */
export type ParsedContentType = 'text' | 'tool_use';

/**
 * 解析内容基础接口
 */
export interface ParsedContent {
    /** 内容类型 */
    type: ParsedContentType;
    /** 是否为部分内容（流式传输中） */
    partial?: boolean;
}

/**
 * 文本内容
 */
export interface TextContent extends ParsedContent {
    type: 'text';
    /** 文本内容 */
    text: string;
}

/**
 * 工具使用内容
 */
export interface ToolUse extends ParsedContent {
    type: 'tool_use';
    /** 工具ID */
    id: string;
    /** 工具名称 */
    name: string;
    /** 工具参数（原始字符串形式） */
    rawParams: Record<string, string>;
    /** 工具参数（验证和转换后） */
    params?: any;
    /** 是否已验证 */
    validated?: boolean;
    /** 验证错误 */
    validationError?: string;
    requestId?: string;
}

/**
 * 解析器状态
 */
export interface ParserState {
    /** 当前累积的字符 */
    accumulator: string;
    /** 已解析的内容块 */
    contentBlocks: ParsedContent[];
    /** 当前文本内容 */
    currentTextContent?: TextContent;
    /** 当前工具使用 */
    currentToolUse?: ToolUse;
    /** 当前参数名 */
    currentParamName?: string;
    /** 当前参数值 */
    currentParamValue?: string;
    /** 是否在工具标签内 */
    inToolTag: boolean;
    /** 是否在参数标签内 */
    inParamTag: boolean;
    /** 标签栈（用于处理嵌套） */
    tagStack: string[];
    /** 是否在CDATA部分 */
    inCDATA: boolean;
}

/**
 * 解析器配置
 */
export interface ParserConfig {
    /** 是否严格模式（遇到错误立即抛出） */
    strictMode?: boolean;
    /** 是否验证工具参数 */
    validateParams?: boolean;
    /** 是否保留原始参数 */
    keepRawParams?: boolean;
    /** 最大累积器大小（防止内存溢出） */
    maxAccumulatorSize?: number;
    /** 特殊处理的工具（如write_to_file） */
    specialTools?: string[];
    /** 自定义标签处理器 */
    customTagHandlers?: Map<string, TagHandler>;
}

/**
 * 标签处理器
 */
export interface TagHandler {
    /** 处理开始标签 */
    onStart?: (tagName: string, state: ParserState) => void;
    /** 处理结束标签 */
    onEnd?: (tagName: string, state: ParserState) => void;
    /** 处理标签内容 */
    onContent?: (content: string, state: ParserState) => void;
}

/**
 * 消息解析器接口
 */
export interface MessageParser {
    /**
     * 注册工具
     * @param tool 工具实例
     */
    registerTool(tool: Tool): Promise<void>;

    /**
     * 批量注册工具
     * @param tools 工具实例数组
     */
    registerTools(tools: Tool[]): Promise<void>;

    /**
     * 注销工具
     * @param name 工具名称
     */
    unregisterTool(name: string): void;

    /**
     * 解析流式内容块
     * @param chunk 内容块
     * @returns 解析的内容数组
     */
    parseChunk(chunk: string): ParsedContent[];

    /**
     * 完成解析
     * @returns 最终的内容数组
     */
    finalize(): ParsedContent[];

    /**
     * 重置解析器状态
     */
    reset(): void;

    /**
     * 获取当前状态
     * @returns 解析器状态
     */
    getState(): ParserState;

    /**
     * 设置配置
     * @param config 解析器配置
     */
    setConfig(config: ParserConfig): void;

    /**
     * 获取已注册的工具
     * @returns 工具映射
     */
    getTools(): Map<string, Tool>;
}

/**
 * 内置消息解析器
 *
 * 核心解析逻辑参考RooCode的实现：
 * third_partry/src/core/assistant-message/AssistantMessageParser.ts
 */
export class BuiltinMessageParser implements MessageParser {
    private tools: Map<string, Tool> = new Map();
    private parameterSchemas: Map<string, any> = new Map();
    private config: Required<ParserConfig>;
    private state: ParserState;

    constructor(config?: ParserConfig) {
        this.config = {
            strictMode: false,
            validateParams: true,
            keepRawParams: true,
            maxAccumulatorSize: 1024 * 1024, // 1MB
            specialTools: ['write_to_file', 'apply_diff'],
            customTagHandlers: new Map(),
            ...config,
        };
        this.state = this.createInitialState();
    }

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
            inCDATA: false,
        };
    }

    async registerTool(tool: Tool): Promise<void> {
        this.tools.set(tool.name, tool);
        if (this.config.validateParams) {
            const schema = await tool.getParameters();
            this.parameterSchemas.set(tool.name, schema);
        }
    }

    async registerTools(tools: Tool[]): Promise<void> {
        for (const tool of tools) {
            await this.registerTool(tool);
        }
    }

    unregisterTool(name: string): void {
        this.tools.delete(name);
        this.parameterSchemas.delete(name);
    }

    /**
     * 解析流式内容
     * 实现细节参考RooCode的AssistantMessageParser.processChunk()
     */
    parseChunk(chunk: string): ParsedContent[] {
        if (
            this.config.maxAccumulatorSize &&
            this.state.accumulator.length + chunk.length > this.config.maxAccumulatorSize
        ) {
            throw new Error('Parser accumulator size exceeded maximum limit');
        }

        for (const char of chunk) {
            this.state.accumulator += char;
            this.processAccumulator();
        }

        return [...this.state.contentBlocks];
    }

    private processAccumulator(): void {
        const { accumulator } = this.state;

        // 检测 CDATA 开始
        if (accumulator.endsWith('<![CDATA[')) {
            this.state.inCDATA = true;
            this.state.accumulator = '';
            return;
        }

        // 处理 CDATA 内容
        if (this.state.inCDATA) {
            if (accumulator.endsWith(']]>')) {
                const content = accumulator.slice(0, -3);
                this.handleCDATAContent(content);
                this.state.inCDATA = false;
                this.state.accumulator = '';
            }
            return;
        }
        // 检测工具开始标签
        const toolStartMatch = accumulator.match(/<(\w+)>$/);
        if (toolStartMatch && this.tools.has(toolStartMatch[1])) {
            this.startToolUse(toolStartMatch[1]);
            this.state.accumulator = '';
            return;
        }

        // 处理工具内的内容
        if (this.state.currentToolUse) {
            const toolEndTag = `</${this.state.currentToolUse.name}>`;
            if (accumulator.endsWith(toolEndTag)) {
                this.endToolUse();
                this.state.accumulator = '';
                return;
            }

            // 检测参数开始标签
            const paramMatch = accumulator.match(/<(\w+)>$/);
            if (paramMatch && !this.state.inParamTag) {
                this.startParam(paramMatch[1]);
                this.state.accumulator = '';
                return;
            }

            // 检测参数结束标签
            if (this.state.currentParamName) {
                const paramEndTag = `</${this.state.currentParamName}>`;
                if (accumulator.endsWith(paramEndTag)) {
                    this.endParam();
                    this.state.accumulator = '';
                    return;
                }
            }
        }

        // 处理普通文本
        if (!this.state.inToolTag && !this.state.inParamTag) {
            const lastOpenBracket = accumulator.lastIndexOf('<');
            if (lastOpenBracket === -1) {
                this.appendText(accumulator);
                this.state.accumulator = '';
            } else if (lastOpenBracket > 0) {
                const text = accumulator.slice(0, lastOpenBracket);
                this.appendText(text);
                this.state.accumulator = accumulator.slice(lastOpenBracket);
            }
        }
    }

    private startToolUse(toolName: string): void {
        if (this.state.currentTextContent) {
            this.state.currentTextContent.partial = false;
            this.state.currentTextContent = undefined;
        }

        this.state.currentToolUse = {
            type: 'tool_use',
            id: this.generateToolId(),
            name: toolName,
            rawParams: {},
            partial: true,
        };
        this.state.contentBlocks.push(this.state.currentToolUse);
        this.state.inToolTag = true;
        this.state.tagStack.push(toolName);
    }

    private endToolUse(): void {
        if (this.state.currentToolUse) {
            if (this.config.validateParams) {
                this.validateToolParams();
            }
            this.state.currentToolUse.partial = false;
            this.state.currentToolUse = undefined;
            this.state.inToolTag = false;
            this.state.tagStack.pop();
        }
    }

    private startParam(paramName: string): void {
        this.state.currentParamName = paramName;
        this.state.currentParamValue = '';
        this.state.inParamTag = true;
        this.state.tagStack.push(paramName);
    }

    private endParam(): void {
        if (this.state.currentToolUse && this.state.currentParamName) {
            this.state.currentToolUse.rawParams[this.state.currentParamName] =
                this.state.currentParamValue || '';
        }
        this.state.currentParamName = undefined;
        this.state.currentParamValue = undefined;
        this.state.inParamTag = false;
        this.state.tagStack.pop();
    }

    private handleCDATAContent(content: string): void {
        if (this.state.inParamTag && this.state.currentParamValue !== undefined) {
            this.state.currentParamValue += content;
        } else {
            this.appendText(content);
        }
    }

    private appendText(text: string): void {
        if (!text) return;

        if (!this.state.currentTextContent) {
            this.state.currentTextContent = {
                type: 'text',
                text: '',
                partial: true,
            };
            this.state.contentBlocks.push(this.state.currentTextContent);
        }
        this.state.currentTextContent.text += text;
    }

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
                const errors = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
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

    finalize(): ParsedContent[] {
        for (const block of this.state.contentBlocks) {
            if (block.partial) {
                block.partial = false;
            }
        }

        if (this.state.accumulator) {
            this.appendText(this.state.accumulator);
            this.state.accumulator = '';
        }

        return [...this.state.contentBlocks];
    }

    reset(): void {
        this.state = this.createInitialState();
    }

    getState(): ParserState {
        return { ...this.state };
    }

    setConfig(config: ParserConfig): void {
        this.config = {
            ...this.config,
            ...config,
        };
    }

    getTools(): Map<string, Tool> {
        return new Map(this.tools);
    }

    private generateToolId(): string {
        return `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}