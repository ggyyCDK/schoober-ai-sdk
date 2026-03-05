/**
 * OpenAI 消息转换器
 * 将 Anthropic.MessageParam 转换为 OpenAI 的 ChatCompletionMessageParam
 * 参考 AnthropicProvider，在确定的消息位置添加固定的缓存控制标签
 */

import { Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// 固定的缓存控制常量，参考 AnthropicProvider
const cacheControl = { type: 'ephemeral' as const };

/**
 * 消息转换器
 */
export class MessageConverter {
    /**
     * 转换消息格式
     * 参考 AnthropicProvider，在系统提示词和指定索引的消息添加缓存控制标签
     *
     * @param messages - Anthropic.MessageParam 数组
     * @param systemPrompt - 系统提示词(可选)
     * @param cacheControlIndex - 缓存控制索引，指定哪条消息应该添加缓存控制标记。如果不提供，默认使用最后一条消息
     * @returns OpenAI 的 ChatCompletionMessageParam 数组
     */
    convert(
        messages: Anthropic.MessageParam[],
        systemPrompt?: string,
        cacheControlIndex?: number
    ): OpenAI.ChatCompletionMessageParam[] {
        const result: OpenAI.ChatCompletionMessageParam[] = [];

        // 添加系统提示词（如果存在），参考 AnthropicProvider 添加缓存控制
        if (systemPrompt) {
            result.push({
                role: 'system',
                content: systemPrompt,
                // OpenAI API 可能支持 cache_control，如果不支持会被忽略
                // 使用 as any 绕过类型检查，参考 AnthropicProvider
                cache_control: cacheControl,
            } as any);
        }

        // 获取缓存控制索引
        // 如果提供了 cacheControlIndex，使用它；否则使用最后一条消息的索引（向后兼容）
        const targetCacheControlIndex = cacheControlIndex !== undefined
            ? cacheControlIndex
            : messages.length - 1;

        // 转换消息
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            // 为指定索引的消息设置缓存控制（无论角色）
            // API 会自动向后检查并匹配之前缓存过的内容
            const shouldAddCacheControl = i === targetCacheControlIndex;

            if (msg.role === 'user') {
                result.push({
                    role: 'user',
                    content: this.extractContent(msg.content, shouldAddCacheControl),
                } as any);
            } else if (msg.role === 'assistant') {
                result.push({
                    role: 'assistant',
                    content: this.extractContent(msg.content, shouldAddCacheControl),
                } as any);
            }
        }

        return result;
    }

    /**
     * 提取消息内容
     * Anthropic.MessageParam.content 可能是 string 或各种 BlockParam 类型
     * 支持图片内容转换为 GPT-4V 格式
     * 支持 base64 和 URL 两种图片源类型
     * 支持缓存控制的 cache_control 标记（参考 AnthropicProvider）
     *
     * @param content - 消息内容
     * @param addCacheControl - 是否添加 cache_control 标记（用于最后一条消息）
     */
    private extractContent(
        content: string | Anthropic.ContentBlockParam[],
        addCacheControl: boolean = false
    ): string | Array<{ type: 'text'; text: string; cache_control?: typeof cacheControl } | { type: 'image_url'; image_url: { url: string }; cache_control?: typeof cacheControl }> {
        if (typeof content === 'string') {
            if (addCacheControl) {
                // 参考 AnthropicProvider：将字符串转换为数组格式并添加 cache_control
                return [
                    {
                        type: 'text',
                        text: content,
                        cache_control: cacheControl,
                    },
                ];
            }
            return content;
        }

        // 如果是数组，检查是否包含图片
        if (Array.isArray(content)) {
            const hasImages = content.some((block) => block.type === 'image');

            if (!hasImages) {
                // 纯文本
                if (addCacheControl) {
                    // 参考 AnthropicProvider：转换为数组格式，为最后一个 content 块添加 cache_control
                    const textParts = content
                        .filter((item) => item.type === 'text')
                        .map((item, index, array) => {
                            if (item.type === 'text') {
                                const textBlock = item as Anthropic.TextBlockParam;
                                const isLast = index === array.length - 1;
                                return {
                                    type: 'text' as const,
                                    text: textBlock.text,
                                    ...(isLast && addCacheControl ? { cache_control: cacheControl } : {}),
                                };
                            }
                            return null;
                        })
                        .filter((item): item is { type: 'text'; text: string; cache_control?: typeof cacheControl } => item !== null);
                    return textParts;
                } else {
                    // 隐式缓存：返回拼接字符串
                    return content
                        .filter((item) => item.type === 'text')
                        .map((item) => {
                            if (item.type === 'text') {
                                return (item as Anthropic.TextBlockParam).text;
                            }
                            return '';
                        })
                        .join('\n');
                }
            }

            // 包含图片，转换为 GPT-4V 格式
            const openAIContent: Array<
                | { type: 'text'; text: string; cache_control?: typeof cacheControl }
                | { type: 'image_url'; image_url: { url: string }; cache_control?: typeof cacheControl }
            > = [];

            for (let i = 0; i < content.length; i++) {
                const block = content[i];
                const isLast = i === content.length - 1;

                if (block.type === 'text') {
                    const textBlock = block as Anthropic.TextBlockParam;
                    if (textBlock.text) {
                        const textPart: { type: 'text'; text: string; cache_control?: typeof cacheControl } = {
                            type: 'text',
                            text: textBlock.text,
                        };
                        // 参考 AnthropicProvider：为最后一个 content 块添加 cache_control
                        if (addCacheControl && isLast) {
                            textPart.cache_control = cacheControl;
                        }
                        openAIContent.push(textPart);
                    }
                } else if (block.type === 'image') {
                    const imageBlock = block as Anthropic.ImageBlockParam;
                    if (imageBlock.source.type === 'base64') {
                        // 转换 Anthropic 的 base64 格式到 OpenAI 的 data URL 格式
                        const imagePart: { type: 'image_url'; image_url: { url: string }; cache_control?: typeof cacheControl } = {
                            type: 'image_url',
                            image_url: {
                                url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                            },
                        };
                        // 参考 AnthropicProvider：为最后一个 content 块添加 cache_control
                        if (addCacheControl && isLast) {
                            imagePart.cache_control = cacheControl;
                        }
                        openAIContent.push(imagePart);
                    } else if (imageBlock.source.type === 'url') {
                        // 直接使用 URL 格式的图片源
                        const imagePart: { type: 'image_url'; image_url: { url: string }; cache_control?: typeof cacheControl } = {
                            type: 'image_url',
                            image_url: {
                                url: imageBlock.source.url,
                            },
                        };
                        // 参考 AnthropicProvider：为最后一个 content 块添加 cache_control
                        if (addCacheControl && isLast) {
                            imagePart.cache_control = cacheControl;
                        }
                        openAIContent.push(imagePart);
                    }
                }
            }

            return openAIContent;
        }

        return String(content);
    }
}

/**
 * 创建消息转换器
 */
export function createMessageConverter(): MessageConverter {
    return new MessageConverter();
}