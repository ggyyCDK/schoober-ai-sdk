import OpenAI from 'openai';
import { LLMProviderConfig, StreamConfig, BaseLLMProvider, StreamChunk } from '@/types';
import { OpenAIError } from './utils/OpenAIError';
import { MessageConverter } from './MessageConverter';

/**
 * OpenAI LLM Provider 实现
 * 使用基础的 openai 库（6.15.0），移除对 Vercel AI SDK 的依赖
 * 简化实现：只处理文本流输出
 */
export class OpenAIProvider extends BaseLLMProvider {
    private messageConverter: MessageConverter;
    private client: OpenAI;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.messageConverter = new MessageConverter();

        // 初始化 OpenAI 客户端
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl || undefined,
            defaultHeaders: config.headers,
        });
    }

    /**
     * 创建流式响应
     * 使用基础的 openai 库进行流式处理，只输出 text 和 end 类型的 StreamChunk
     */
    async *createStream(config: StreamConfig): AsyncIterable<StreamChunk> {
        const modelId = config.model?.model || this.model.model;
        const temperature = config.temperature || this.model.temperature || 0;
        const maxTokens = config.maxTokens;

        try {
            // 记录 API 调用前的详细信息
            if (config.logger) {
                config.logger.info("OpenAIProvider_createStream_start", {
                    model: modelId,
                    messageCount: config.messages.length,
                    systemPromptLength: config.systemPrompt?.length || 0,
                    temperature,
                    maxTokens,
                });
            }

            // 转换消息格式（包含缓存控制标签）
            const messages = this.messageConverter.convert(
                config.messages,
                config.systemPrompt,
                config.cacheControlIndex
            );

            // 调用 OpenAI API 创建流式响应
            const stream = await this.client.chat.completions.create({
                model: modelId,
                messages,
                temperature,
                max_tokens: maxTokens,
                stream: true,
                stream_options: { include_usage: true }, // 启用 usage 统计
                ...(this.getConfig().extraBody || {})
            });

            if (config.logger) {
                config.logger.debug("OpenAIProvider_createStream_streamCreated", {});
            }

            // 迭代流式响应，提取文本内容和 usage 统计
            let chunkCount = 0;
            let totalInputTokens = 0;
            let totalOutputTokens = 0;

            for await (const chunk of stream) {
                chunkCount++;

                // 调试：打印前5个chunk的完整内容
                if (chunkCount <= 5 && config.logger) {
                    config.logger.debug("OpenAIProvider_createStream_chunkReceived", {
                        chunkIndex: chunkCount,
                        chunk: JSON.stringify(chunk),
                    });
                }

                // 处理文本内容
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    yield {
                        type: 'text',
                        text: content,
                    };
                }

                // 处理 usage 统计 (OpenAI 在流式响应的最后一个 chunk 中返回 usage)
                if (chunk.usage) {
                    totalInputTokens = chunk.usage.prompt_tokens || 0;
                    totalOutputTokens = chunk.usage.completion_tokens || 0;

                    if (config.logger) {
                        config.logger.debug("OpenAIProvider_createStream_usageReceived", {
                            inputTokens: totalInputTokens,
                            outputTokens: totalOutputTokens,
                            totalTokens: chunk.usage.total_tokens,
                        });
                    }

                    yield {
                        type: 'usage',
                        usage: {
                            inputTokens: totalInputTokens,
                            outputTokens: totalOutputTokens,
                            totalTokens: totalInputTokens + totalOutputTokens,
                        },
                    };
                }
            }

            if (config.logger) {
                config.logger.info("OpenAIProvider_createStream_totalChunks", {
                    totalChunks: chunkCount,
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                });
            }

            // 流结束后发送结束标记
            yield { type: 'end' };
        } catch (error) {
            // 错误日志
            if (config.logger) {
                config.logger.error("OpenAIProvider_createStream_error", {
                    model: modelId,
                    error,
                    requestContext: {
                        messageCount: config.messages.length,
                        systemPromptLength: config.systemPrompt?.length || 0,
                        temperature,
                        maxTokens,
                    },
                });
            }
            throw OpenAIError.fromError(error);
        }
    }
}