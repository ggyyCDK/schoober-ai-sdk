import { Anthropic } from '@anthropic-ai/sdk';
import { Stream as AnthropicStream } from '@anthropic-ai/sdk/streaming';
import { LLMProviderConfig, StreamConfig, BaseLLMProvider, StreamChunk } from '@/types';
import { CacheControlEphemeral } from '@anthropic-ai/sdk/resources/messages';
import https from 'https';
import http from 'http';

const ANTHROPIC_DEFAULT_MAX_TOKENS = 50000;
const CHUNK_TIMEOUT_MS = 40000; // 40 秒超时
const cacheControl: CacheControlEphemeral = { type: 'ephemeral' };

// 扩展 Usage 类型以包含缓存相关字段
// SDK 的 Usage 类型不包含这些字段，但 API 实际会返回
type ExtendedUsage = Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
};

/**
 * Anthropic LLM Provider 实现
 * 直接使用 Anthropic SDK，不需要转换
 */
export class AnthropicProvider extends BaseLLMProvider {
    private client: Anthropic;

    constructor(config: LLMProviderConfig) {
        super(config);

        this.client = new Anthropic({
            baseURL: config.baseUrl || undefined,
            apiKey: config.apiKey,
            authToken: null,
        });
    }

    getDefaultModel(): string {
        return 'claude-3-5-sonnet-20241022';
    }

    /**
     * 从 URL 下载图片并转换为 base64
     */
    private async downloadImageToBase64(url: string): Promise<{ data: string; mediaType: string }> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;

            client
                .get(url, (response) => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
                        return;
                    }

                    const chunks: Buffer[] = [];

                    response.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                    });

                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        const base64 = buffer.toString('base64');

                        // 从响应头或 URL 推断 media type
                        const contentType = response.headers['content-type'] || '';
                        let mediaType = 'image/png'; // 默认值

                        if (contentType.includes('image/')) {
                            mediaType = contentType.split(';')[0].trim();
                        } else {
                            // 从 URL 扩展名推断
                            const ext = url.split('.').pop()?.toLowerCase();
                            if (ext === 'jpg' || ext === 'jpeg') {
                                mediaType = 'image/jpeg';
                            } else if (ext === 'png') {
                                mediaType = 'image/png';
                            } else if (ext === 'gif') {
                                mediaType = 'image/gif';
                            } else if (ext === 'webp') {
                                mediaType = 'image/webp';
                            }
                        }

                        resolve({ data: base64, mediaType });
                    });

                    response.on('error', reject);
                })
                .on('error', reject);
        });
    }

    /**
     * 转换消息中的图片 URL 为 base64
     */
    private async convertImageUrlsToBase64(messages: any[]): Promise<any[]> {
        const convertedMessages = [];

        for (const message of messages) {
            if (!Array.isArray(message.content)) {
                convertedMessages.push(message);
                continue;
            }

            const convertedContent = [];

            for (const block of message.content) {
                if (block.type === 'image' && block.source?.type === 'url') {
                    try {
                        const { data, mediaType } = await this.downloadImageToBase64(block.source.url);
                        convertedContent.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: data,
                            },
                        });
                    } catch (error) {
                        console.error(`Failed to convert image URL to base64: ${block.source.url}`, error);
                        // 保留原始 URL 格式
                        convertedContent.push(block);
                    }
                } else {
                    convertedContent.push(block);
                }
            }

            convertedMessages.push({
                ...message,
                content: convertedContent,
            });
        }

        return convertedMessages;
    }

    /**
     * 创建流式响应（带超时检测）
     */
    async *createStream(config: StreamConfig): AsyncIterable<StreamChunk> {
        const modelId = config.model?.model || this.model.model;
        const maxTokens = config.maxTokens || config.model?.maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS;
        const temperature = config.temperature || 0;
        const taskId = config.taskId;
        const taskIdPrefix = taskId ? `Task ${taskId} - ` : '';

        // traceId 变量，从响应头中提取
        let traceId: string | null = null;

        // Watchdog 定时器变量
        let timeoutId: NodeJS.Timeout | null = null;
        let isTimeout = false;
        let chunkCount = 0;
        let lastChunkTime = Date.now();

        // 创建超时检测函数
        const resetTimeout = () => {
            if (timeoutId) clearTimeout(timeoutId);
            isTimeout = false;
            timeoutId = setTimeout(() => {
                isTimeout = true;
                const timeoutType = chunkCount === 0 ? 'first_token' : 'chunk_interval';
                if (config.logger) {
                    config.logger.error('AnthropicProvider_createStream_chunkTimeout', {
                        timeoutMs: CHUNK_TIMEOUT_MS,
                        timeoutType,
                        chunkCount,
                        lastChunkTime: new Date(lastChunkTime).toISOString(),
                        waitedMs: Date.now() - lastChunkTime,
                        traceId,
                        taskId,
                        requestContext: {
                            model: modelId,
                            messageCount: config.messages.length,
                            systemPromptLength: config.systemPrompt?.length || 0,
                            temperature,
                            maxTokens,
                        },
                    });
                    if (traceId) {
                        config.logger.info('AnthropicProvider_createStream_timeoutWithTraceId', {
                            traceId,
                            taskId,
                        });
                    }
                }
            }, CHUNK_TIMEOUT_MS);
        };

        try {
            // 记录 API 调用前的详细信息
            if (config.logger) {
                config.logger.info('AnthropicProvider_createStream_start', {
                    model: modelId,
                    messageCount: config.messages.length,
                    systemPromptLength: config.systemPrompt?.length || 0,
                    temperature,
                    maxTokens,
                    taskId,
                });
            }

            // 过滤空消息，但保留最后一个 assistant 消息（Anthropic API 允许）
            const filteredMessages = config.messages.filter((msg, index) => {
                // 如果是最后一条消息且是 assistant 角色，保留（Anthropic 允许）
                const isLastAssistant = index === config.messages.length - 1 && msg.role === 'assistant';

                // 检查 content 是否为空
                const isEmpty =
                    typeof msg.content === 'string'
                        ? msg.content.trim() === ''
                        : Array.isArray(msg.content) && msg.content.length === 0;

                return !isEmpty || isLastAssistant;
            });

            // 记录过滤信息
            if (filteredMessages.length < config.messages.length && config.logger) {
                const filteredCount = config.messages.length - filteredMessages.length;
                config.logger.warn('AnthropicProvider_createStream_emptyMessagesFiltered', {
                    originalCount: config.messages.length,
                    filteredCount: filteredMessages.length,
                    removedCount: filteredCount,
                    taskId,
                });
            }

            // 转换图片 URL 为 base64
            const messagesWithBase64Images = await this.convertImageUrlsToBase64(filteredMessages);

            // 获取缓存控制索引
            // 如果提供了 cacheControlIndex，使用它；否则使用最后一条消息的索引（向后兼容）
            const cacheControlIndex =
                config.cacheControlIndex !== undefined
                    ? config.cacheControlIndex
                    : messagesWithBase64Images.length - 1;


            const stream = await this.client.messages.create(
                {
                    model: modelId,
                    max_tokens: maxTokens,
                    temperature: 0,
                    // 为系统提示设置缓存断点
                    system: config.systemPrompt
                        ? [
                            {
                                text: config.systemPrompt,
                                type: 'text',
                                cache_control: cacheControl,
                            } as any,
                        ]
                        : undefined,
                    messages: messagesWithBase64Images.map((message, index) => {
                        // 为指定索引的消息设置缓存控制（无论角色）
                        // API 会自动向后检查并匹配之前缓存过的内容
                        if (index === cacheControlIndex) {
                            return {
                                ...message,
                                content:
                                    typeof message.content === 'string'
                                        ? [
                                            {
                                                type: 'text' as const,
                                                text: message.content,
                                                // 只在内容非空时设置 cache_control
                                                ...(message.content.trim() !== '' ? { cache_control: cacheControl } : {}),
                                            } as any,
                                        ]
                                        : (message.content as any[]).map((content: any, contentIndex: number) => {
                                            // 只在最后一个内容块且内容非空时设置 cache_control
                                            const isLastContent =
                                                contentIndex === (message.content as any[]).length - 1;
                                            const isTextContent = content.type === 'text' && content.text;
                                            const isEmptyText = isTextContent && content.text.trim() === '';

                                            return isLastContent && !isEmptyText
                                                ? { ...content, cache_control: cacheControl }
                                                : content;
                                        }),
                            };
                        }
                        return message;
                    }),
                    stream: true,
                }
            );

            // 启动首 token 超时检测
            resetTimeout();

            // 处理流式响应
            // 注意：Claude API 的 usage 是累积的完整值，不需要累加
            // message_start 中的 usage 是初始值，message_delta 中的 usage 是最终的累积值
            let lastUsage: ExtendedUsage | null = null;

            for await (const chunk of stream) {
                // 检查是否已超时
                if (isTimeout) {
                    const timeoutType = chunkCount === 0 ? '首个 token' : 'Token 间隔';
                    throw new Error(`${timeoutType}超时：超过 ${CHUNK_TIMEOUT_MS / 1000} 秒未收到新的 chunk`);
                }

                // 更新 chunk 计数和时间
                chunkCount++;
                lastChunkTime = Date.now();

                // 重置超时定时器
                resetTimeout();

                switch (chunk.type) {
                    case 'message_start': {
                        const usage = chunk.message.usage as ExtendedUsage;
                        lastUsage = usage;
                        const {
                            input_tokens = 0,
                            output_tokens = 0,
                            cache_creation_input_tokens,
                            cache_read_input_tokens,
                        } = usage;

                        yield {
                            type: 'usage',
                            usage: {
                                inputTokens: input_tokens,
                                outputTokens: output_tokens,
                                totalTokens: input_tokens + output_tokens,
                                cacheWriteTokens: cache_creation_input_tokens ?? undefined,
                                cacheReadTokens: cache_read_input_tokens ?? undefined,
                            },
                        };
                        break;
                    }
                    case 'message_delta':
                        // message_delta 中的 usage 是累积的完整值，包含 input_tokens 和 output_tokens
                        // 直接使用这个完整的累积值，不需要合并之前的值
                        if (chunk.usage) {
                            const usage = chunk.usage as ExtendedUsage;
                            lastUsage = usage;

                            const {
                                input_tokens = 0,
                                output_tokens = 0,
                                cache_creation_input_tokens,
                                cache_read_input_tokens,
                            } = usage;

                            yield {
                                type: 'usage',
                                usage: {
                                    inputTokens: input_tokens,
                                    outputTokens: output_tokens,
                                    totalTokens: input_tokens + output_tokens,
                                    cacheWriteTokens: cache_creation_input_tokens ?? undefined,
                                    cacheReadTokens: cache_read_input_tokens ?? undefined,
                                },
                            };
                        }
                        break;
                    case 'content_block_start': {
                        // 使用 any 类型因为 SDK 类型定义可能不包含 thinking 等扩展内容块
                        const blockStart = chunk as any;
                        if (blockStart.index > 0) {
                            yield { type: 'text', text: '\n' };
                        }

                        // 处理 thinking 或 text 内容块
                        if (blockStart.content_block.type === 'thinking') {
                            yield { type: 'text', text: blockStart.content_block.thinking };
                        } else if (blockStart.content_block.type === 'text') {
                            yield { type: 'text', text: blockStart.content_block.text };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        // 使用 any 类型因为 SDK 类型定义可能不包含 thinking_delta
                        const deltaEvent = chunk as any;
                        if (deltaEvent.delta.type === 'thinking_delta') {
                            yield { type: 'text', text: deltaEvent.delta.thinking };
                        } else if (deltaEvent.delta.type === 'text_delta') {
                            yield { type: 'text', text: deltaEvent.delta.text };
                        }
                        break;
                    }
                    case 'message_stop':
                        break;
                    case 'content_block_stop':
                        break;
                }
            }

            // 流式响应完成日志
            if (config.logger) {
                config.logger.info('AnthropicProvider_createStream_completed', {
                    model: modelId,
                    chunkCount,
                    finalUsage: lastUsage,
                    taskId,
                });
            }
        } catch (error) {
            // 错误日志
            if (config.logger) {
                config.logger.error('AnthropicProvider_createStream_error', {
                    model: modelId,
                    chunkCount,
                    traceId,
                    taskId,
                    error,
                    requestContext: {
                        maxTokens,
                        temperature,
                        messageCount: config.messages.length,
                        systemPromptLength: config.systemPrompt?.length || 0,
                    },
                });
                if (traceId) {
                    config.logger.error('AnthropicProvider_createStream_requestError', {
                        traceId,
                        taskId,
                        error,
                    });
                }
            }

            // 打印调用栈以便调试
            console.trace('[AnthropicProvider] Error:', {
                traceId,
                taskId,
                error: error instanceof Error ? error.message : String(error),
            });

            throw this.handleError(error);
        } finally {
            // 清理定时器
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * 处理错误
     */
    private handleError(error: any): Error {
        if (error instanceof Anthropic.APIError) {
            // 根据不同的错误类型返回详细错误信息
            if (error instanceof Anthropic.AuthenticationError) {
                return new Error(`Anthropic 认证错误 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.PermissionDeniedError) {
                return new Error(`Anthropic 权限被拒绝 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.NotFoundError) {
                return new Error(`Anthropic 资源未找到 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.ConflictError) {
                return new Error(`Anthropic 冲突错误 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.UnprocessableEntityError) {
                return new Error(`Anthropic 无法处理的实体 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.RateLimitError) {
                return new Error(`Anthropic 速率限制 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.InternalServerError) {
                return new Error(`Anthropic 服务器内部错误 (${error.status}): ${error.message}`);
            } else if (error instanceof Anthropic.BadRequestError) {
                return new Error(`Anthropic 请求错误 (${error.status}): ${error.message}`);
            } else {
                return new Error(`Anthropic API 错误 (${error.status}): ${error.message}`);
            }
        }

        if (error instanceof Error) {
            return error;
        }

        return new Error(`未知错误: ${String(error)}`);
    }
}