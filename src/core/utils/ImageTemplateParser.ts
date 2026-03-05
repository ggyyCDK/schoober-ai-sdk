/**
 * 图片模板解析器
 * 
 * 负责解析用户消息中的图片模板，将其转换为 Anthropic ContentBlock 格式
 * 模板格式: @|{"type":"pic","content":"base64或URL","name":"xxx"}|
 */

import { Anthropic } from '@anthropic-ai/sdk';

/**
 * 图片模板接口
 */
export interface ImageTemplate {
    /** 类型标识，必须为 'pic' */
    type: 'pic';
    /** base64 编码的图片数据或图片 URL 地址 */
    content: string;
    /** 图片名称（可选） */
    name?: string;
    /** MIME 类型（可选，如 'image/png'，仅对 base64 格式有效） */
    mediaType?: string;
}

/**
 * 解析结果接口
 */
export interface ParseResult {
    /** 是否包含图片 */
    hasImages: boolean;
    /** 解析后的内容块数组 */
    blocks: Anthropic.ContentBlockParam[];
}

/**
 * 图片模板解析器
 */
export class ImageTemplateParser {
    /**
     * 模板正则表达式
     * 匹配格式: @|{...}|
     */
    private static readonly TEMPLATE_REGEX = /@\|(\{[^}]+\})\|/g;

    /**
     * 解析消息中的图片模板
     * 
     * @param message - 原始消息字符串，可能包含图片模板
     * @returns 解析结果，包含是否有图片和内容块数组
     * 
     * @example
     * ```typescript
     * const parser = new ImageTemplateParser();
     * const result = parser.parse('这是图片 @|{"type":"pic","content":"iVBORw..."}| 的说明');
     * // result.hasImages === true
     * // result.blocks === [
     * //   { type: 'text', text: '这是图片 ' },
     * //   { type: 'image', source: { type: 'base64', ... } },
     * //   { type: 'text', text: ' 的说明' }
     * // ]
     * ```
     */
    parse(message: string): ParseResult {
        const regex = new RegExp(ImageTemplateParser.TEMPLATE_REGEX);
        const blocks: Anthropic.ContentBlockParam[] = [];
        let lastIndex = 0;
        let hasImages = false;

        let match: RegExpExecArray | null;
        while ((match = regex.exec(message)) !== null) {
            // 添加前面的文本块
            if (match.index > lastIndex) {
                const text = message.substring(lastIndex, match.index);
                if (text) {
                    blocks.push({
                        type: 'text',
                        text,
                    });
                }
            }

            // 解析图片模板
            try {
                const template: ImageTemplate = JSON.parse(match[1]);

                // 验证模板格式
                if (template.type === 'pic' && template.content) {
                    const content = template.content;
                    let processed = false;

                    // 优先级 1: 检查是否为 Data URL 格式 (data:image/png;base64,...)
                    if (content.startsWith('data:')) {
                        const dataUrlMatch = content.match(/^data:([^;]+);base64,(.+)$/);
                        if (dataUrlMatch) {
                            const base64Data = dataUrlMatch[2];
                            const mediaType = template.mediaType || dataUrlMatch[1];

                            // 验证 base64 格式
                            if (this.validateBase64(base64Data)) {
                                blocks.push({
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: mediaType || this.inferMediaType(base64Data),
                                        data: base64Data,
                                    },
                                } as Anthropic.ImageBlockParam);
                                hasImages = true;
                                processed = true;
                            }
                        }
                    }

                    // 优先级 2: 检查是否为有效的 URL
                    if (!processed && this.validateUrl(content)) {
                        blocks.push({
                            type: 'image',
                            source: {
                                type: 'url',
                                url: content,
                            },
                        } as Anthropic.ImageBlockParam);
                        hasImages = true;
                        processed = true;
                    }

                    // 优先级 3: 检查是否为 base64 字符串
                    if (!processed && this.validateBase64(content)) {
                        blocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: template.mediaType || this.inferMediaType(content),
                                data: content,
                            },
                        } as Anthropic.ImageBlockParam);
                        hasImages = true;
                        processed = true;
                    }

                    // 如果都不匹配，当作普通文本
                    if (!processed) {
                        blocks.push({ type: 'text', text: match[0] });
                    }
                } else {
                    // 模板格式无效，当作普通文本
                    blocks.push({ type: 'text', text: match[0] });
                }
            } catch (e) {
                // JSON 解析失败，当作普通文本
                blocks.push({ type: 'text', text: match[0] });
            }

            lastIndex = regex.lastIndex;
        }

        // 添加剩余文本
        if (lastIndex < message.length) {
            const text = message.substring(lastIndex);
            if (text) {
                blocks.push({
                    type: 'text',
                    text,
                });
            }
        }

        // 如果没有任何内容块，添加空文本块
        if (blocks.length === 0) {
            blocks.push({ type: 'text', text: '' });
        }

        return { hasImages, blocks };
    }

    /**
     * 验证 base64 编码格式
     * 
     * @param content - base64 字符串
     * @returns 是否为有效的 base64 格式
     */
    validateBase64(content: string): boolean {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // 基本长度检查
        if (content.length < 10) {
            return false;
        }

        // base64 格式检查：只包含合法字符
        const base64Regex = /^[A-Za-z0-9+/]+=*$/;
        return base64Regex.test(content);
    }

    /**
     * 验证 URL 格式
     * 
     * @param content - URL 字符串
     * @returns 是否为有效的 HTTP/HTTPS URL
     */
    validateUrl(content: string): boolean {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // 必须以 http:// 或 https:// 开头
        if (!content.startsWith('http://') && !content.startsWith('https://')) {
            return false;
        }

        // 基本的 URL 格式验证
        // 避免误判 base64 字符串为 URL（base64 可能以 http 开头但不符合 URL 格式）
        try {
            const url = new URL(content);
            // 验证协议和主机名
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    }
    /**
   * 从 base64 数据推断媒体类型
   * 通过检查 base64 magic bytes 来判断图片类型
   * 
   * @param base64 - base64 编码的图片数据
   * @returns MIME 类型
   */
    inferMediaType(base64: string): string {
        // 检查常见图片格式的 magic bytes
        // JPEG: /9j/
        if (base64.startsWith('/9j/')) {
            return 'image/jpeg';
        }

        // PNG: iVBORw0KGgo
        if (base64.startsWith('iVBORw0KGgo')) {
            return 'image/png';
        }

        // GIF: R0lGOD
        if (base64.startsWith('R0lGOD')) {
            return 'image/gif';
        }

        // WebP: UklGR
        if (base64.startsWith('UklGR')) {
            return 'image/webp';
        }

        // BMP: Qk
        if (base64.startsWith('Qk')) {
            return 'image/bmp';
        }

        // 默认返回 PNG
        return 'image/png';
    }

    /**
     * 检查消息是否包含图片模板
     * 
     * @param message - 消息字符串
     * @returns 是否包含图片模板
     */
    hasImageTemplate(message: string): boolean {
        const regex = new RegExp(ImageTemplateParser.TEMPLATE_REGEX);
        return regex.test(message);
    }

    /**
     * 提取消息中的所有图片模板
     * 
     * @param message - 消息字符串
     * @returns 图片模板数组
     */
    extractTemplates(message: string): ImageTemplate[] {
        const regex = new RegExp(ImageTemplateParser.TEMPLATE_REGEX);
        const templates: ImageTemplate[] = [];

        let match: RegExpExecArray | null;
        while ((match = regex.exec(message)) !== null) {
            try {
                const template: ImageTemplate = JSON.parse(match[1]);
                if (template.type === 'pic' && template.content) {
                    templates.push(template);
                }
            } catch (e) {
                // 忽略解析失败的模板
            }
        }

        return templates;
    }
}

/**
 * 创建图片模板解析器实例
 * 
 * @returns ImageTemplateParser 实例
 */
export function createImageTemplateParser(): ImageTemplateParser {
    return new ImageTemplateParser();
}