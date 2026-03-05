/**
 * 执行管理器 - 负责 LLM 请求的执行和流式响应处理
 *
 * 核心改进:
 * - 直接使用 ApiMessage[] 与 LLM 交互
 * - systemPrompt 只传递一次,在这里统一处理
 * - 简化流式响应处理逻辑
 */

import {
    LLMProvider,
    StreamConfig,
    MessageParser,
    ParsedContent,
    ToolUse,
    TextContent,
    ApiMessage,
    StreamChunk,
    StreamUsage,
    AgentSDKError,
    ILogger,
    createDefaultLogger,
    serializeError,
} from '@/types';

/**
 * 执行回调接口
 */
export interface ExecutionCallbacks {
    /** 文本内容回调 */
    onTextContent?: (text: string) => Promise<void>;
    /** 工具使用回调(仅完整的工具使用) */
    onToolUse?: (toolUse: ToolUse) => Promise<void>;
    /** 原始chunk回调 */
    onChunk?: (chunk: string) => void;
    /** Token 使用情况回调 */
    onUsage?: (usage: StreamUsage) => Promise<void>;
    /** 流结束回调 */
    onStreamEnd?: () => Promise<void>;
    /** 错误回调 */
    onError?: (error: Error) => Promise<void>;
    /** API消息内容累积回调（用于记录大模型原始返回） */
    onApiMessageContent?: (content: string) => void;
    /** API消息完成回调（在流结束时调用，用于完成apiMessage记录） */
    onApiMessageFinalize?: (content: string) => Promise<void>;
}

/**
 * 执行管理器配置
 */
export interface ExecutionManagerConfig {
    /** LLM 提供者 */
    llmProvider: LLMProvider;
    /** 消息解析器 */
    messageParser: MessageParser;
    /** 默认温度 */
    temperature?: number;
    /** 默认最大 tokens */
    maxTokens?: number;
    /** 日志记录器（可选） */
    logger?: ILogger;
}

/**
 * 执行选项
 */
export interface ExecutionOptions {
    /** 覆盖系统提示词 */
    systemPrompt?: string;
    /** 覆盖温度 */
    temperature?: number;
    /** 覆盖最大 tokens */
    maxTokens?: number;
    /** 执行回调 */
    callbacks?: ExecutionCallbacks;
    /** 中止信号 */
    abortSignal?: AbortSignal;
    /** 缓存控制索引，指定哪条消息应该添加缓存控制标记。如果不提供，默认使用最后一条消息 */
    cacheControlIndex?: number;
}

/**
 * 执行管理器实现
 */
export class ExecutionManager {
    private llmProvider: LLMProvider;
    private messageParser: MessageParser;
    private config: ExecutionManagerConfig;
    private abortController?: AbortController;
    private logger: ILogger;
    private taskId?: string;

    constructor(config: ExecutionManagerConfig & { taskId?: string }) {
        this.config = config;
        this.llmProvider = config.llmProvider;
        this.messageParser = config.messageParser;
        this.logger = config.logger || createDefaultLogger();
        this.taskId = config.taskId;
    }

    /**
     * 执行 LLM 请求
     *
     * @param messages - ApiMessage 数组(直接传递给 LLM)
     * @param options - 执行选项
     * @returns void (通过回调返回结果)
     */
    async execute(messages: ApiMessage[], options?: ExecutionOptions): Promise<void> {
        const taskIdPrefix = this.taskId ? `Task ${this.taskId} - ` : '';
        const startTime = Date.now();
        const messageCount = messages.length;
        const config = {
            temperature: options?.temperature ?? this.config.temperature,
            maxTokens: options?.maxTokens ?? this.config.maxTokens,
            systemPromptLength: options?.systemPrompt?.length || 0,
        };

        this.logger.info("ExecutionManager_execute_start", {
            taskId: this.taskId,
            messageCount,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            systemPromptLength: config.systemPromptLength
        });

        // 创建 abort controller
        this.abortController = new AbortController();

        // 如果提供了外部 abort signal,监听它
        if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
                this.abortController?.abort();
            });
        }

        try {
            // 构建流配置
            // systemPrompt 必须通过 options 传入
            const streamConfig: StreamConfig = {
                messages: messages as any, // ApiMessage[] 会被 Provider 转换
                systemPrompt: options?.systemPrompt,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                logger: this.logger,
                taskId: this.taskId,
                cacheControlIndex: options?.cacheControlIndex,
            };

            // 重置解析器
            this.messageParser.reset();

            // 获取流
            const streamStartTime = Date.now();
            const stream = this.llmProvider.createStream(streamConfig);
            const streamCreationDuration = Date.now() - streamStartTime;
            this.logger.debug("ExecutionManager_execute_streamCreated", {
                taskId: this.taskId,
                duration: streamCreationDuration
            });

            // 处理流式响应
            await this.handleStream(stream, options?.callbacks);

            const totalDuration = Date.now() - startTime;
            this.logger.info("ExecutionManager_execute_success", {
                taskId: this.taskId,
                duration: totalDuration
            });
        } catch (error) {
            const totalDuration = Date.now() - startTime;
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const errorCode = errorObj instanceof AgentSDKError ? errorObj.code : undefined;
            const errorDetails = errorObj instanceof AgentSDKError ? errorObj.details : undefined;

            this.logger.error("ExecutionManager_execute_error", {
                taskId: this.taskId,
                errorCode: errorCode || 'UNKNOWN',
                duration: totalDuration,
                message: errorObj.message,
                error: errorObj
            });

            if (errorDetails) {
                this.logger.debug("ExecutionManager_execute_errorDetails", {
                    taskId: this.taskId,
                    errorDetails
                });
            }
            // 调用错误回调
            if (options?.callbacks?.onError) {
                try {
                    await options.callbacks.onError(errorObj);
                } catch (callbackError) {
                    this.logger.error("ExecutionManager_execute_onErrorCallbackFailed", {
                        taskId: this.taskId,
                        error: callbackError
                    });
                }
            }

            if (this.abortController?.signal.aborted) {
                this.logger.warn("ExecutionManager_execute_aborted", {
                    taskId: this.taskId,
                    duration: totalDuration
                });
                throw new AgentSDKError('Execution aborted', 'EXECUTION_ABORTED');
            }

            throw new AgentSDKError(`Execution failed: ${errorObj.message}`, 'EXECUTION_ERROR', {
                error: serializeError(errorObj),
                originalError: serializeError(error),
                duration: totalDuration,
                messageCount,
                config,
            });
        } finally {
            this.abortController = undefined;
        }
    }

    /**
     * 处理流式响应
     * 核心改进:
     * 1. 实时处理parseChunk返回的完整内容块
     * 2. 工具调用并行执行,但确保在onStreamEnd前全部完成
     */
    private async handleStream(
        stream: AsyncIterable<StreamChunk>,
        callbacks?: ExecutionCallbacks
    ): Promise<void> {
        const streamStartTime = Date.now();
        this.logger.debug("ExecutionManager_handleStream_start", {
            taskId: this.taskId
        });

        let processContentIndex = 0;
        let chunkCount = 0;
        let textChunkCount = 0;
        let toolUseCount = 0;
        let totalUsage: StreamUsage | null = null;
        // 收集所有工具执行的 Promise,用于并行执行
        const toolExecutionPromises: Promise<void>[] = [];
        // 累积 API 消息内容（用于记录大模型原始返回）
        let apiMessageContent = '';

        try {
            for await (const chunk of stream) {
                chunkCount++;

                // 检查是否被中止
                if (this.abortController?.signal.aborted) {
                    this.logger.debug("ExecutionManager_handleStream_aborted", {
                        taskId: this.taskId,
                        chunkCount
                    });
                    break;
                }

                // 处理不同类型的块
                switch (chunk.type) {
                    case 'text':
                        if (chunk.text) {
                            textChunkCount++;
                            // 累积 API 消息内容
                            apiMessageContent += chunk.text;
                            // 调用 API 消息内容回调
                            if (callbacks?.onApiMessageContent) {
                                callbacks.onApiMessageContent(chunk.text);
                            }
                            // 调用原始chunk回调
                            if (callbacks?.onChunk) {
                                callbacks.onChunk(chunk.text);
                            }
                            // 解析内容块
                            const parsedContents = this.messageParser.parseChunk(chunk.text);
                            const content = parsedContents[processContentIndex];
                            if (content) {
                                // 不管是否 partial，都处理（实时显示）
                                if (content.type === 'text') {
                                    const textContent = content as TextContent;
                                    if (callbacks?.onTextContent) {
                                        // 文本内容保持 await,保证顺序输出
                                        await callbacks.onTextContent(textContent.text);
                                    }
                                } else if (content.type === 'tool_use') {
                                    const toolUse = content as ToolUse;
                                    toolUse.requestId = `tool_req_${toolUse.id}`;
                                    toolUseCount++;
                                    if (callbacks?.onToolUse) {
                                        // 不 await,收集 Promise,允许并行执行
                                        const promise = callbacks.onToolUse(toolUse);
                                        toolExecutionPromises.push(promise);
                                    }
                                }

                                // 如果这个块完成了，移动到下一个
                                if (content.partial === false) {
                                    processContentIndex++;
                                }
                            }
                        }
                        break;

                    case 'usage':
                        // 处理 Token 使用情况
                        totalUsage = chunk.usage;
                        this.logger.debug("ExecutionManager_handleStream_tokenUsage", {
                            taskId: this.taskId,
                            inputTokens: chunk.usage.inputTokens,
                            outputTokens: chunk.usage.outputTokens,
                            totalTokens: chunk.usage.totalTokens
                        });
                        if (callbacks?.onUsage) {
                            await callbacks.onUsage(chunk.usage);
                        }
                        break;

                    case 'error':
                        const streamError = new AgentSDKError(`Stream error: ${chunk.error}`, 'STREAM_ERROR', {
                            chunk,
                            chunkCount,
                            textChunkCount,
                            toolUseCount,
                        });
                        this.logger.error("ExecutionManager_handleStream_chunkError", {
                            taskId: this.taskId,
                            chunkCount,
                            error: streamError
                        });

                        // 调用错误回调
                        if (callbacks?.onError) {
                            try {
                                await callbacks.onError(streamError);
                            } catch (callbackError) {
                                this.logger.error("ExecutionManager_handleStream_onErrorCallbackFailed", {
                                    taskId: this.taskId,
                                    error: callbackError
                                });
                            }
                        }

                        throw streamError;

                    case 'end': {
                        // 流结束
                        this.logger.debug("ExecutionManager_handleStream_end", {
                            taskId: this.taskId,
                            chunkCount
                        });
                        break;
                    }

                    default:
                        // 忽略未知类型
                        this.logger.debug("ExecutionManager_handleStream_unknownChunkType", {
                            taskId: this.taskId,
                            chunkType: (chunk as any).type
                        });
                        break;
                }
            }

            // for await 结束后，检查是否有剩余的已完成 content
            // 这处理了同一个 chunk 中多个 content 完成的边缘情况
            const finalContents = this.messageParser.parseChunk('');

            this.logger.debug("ExecutionManager_handleStream_finalContentParsing", {
                taskId: this.taskId,
                contentCount: finalContents.length
            });
            while (processContentIndex < finalContents.length) {
                const content = finalContents[processContentIndex];

                if (content.type === 'text') {
                    const textContent = content as TextContent;
                    if (callbacks?.onTextContent) {
                        // 文本内容保持 await,保证顺序输出
                        await callbacks.onTextContent(textContent.text);
                    }
                } else if (content.type === 'tool_use') {
                    const toolUse = content as ToolUse;
                    toolUse.requestId = `tool_req_${toolUse.id}`;
                    if (callbacks?.onToolUse) {
                        // 不 await,收集 Promise,允许并行执行
                        const promise = callbacks.onToolUse(toolUse);
                        toolExecutionPromises.push(promise);
                    }
                }

                processContentIndex++;
            }

            const streamDuration = Date.now() - streamStartTime;
            this.logger.info("ExecutionManager_handleStream_finished", {
                taskId: this.taskId,
                chunkCount,
                textChunkCount,
                toolUseCount,
                duration: streamDuration
            });

            if (totalUsage) {
                this.logger.info("ExecutionManager_handleStream_finalTokenUsage", {
                    taskId: this.taskId,
                    inputTokens: totalUsage.inputTokens,
                    outputTokens: totalUsage.outputTokens,
                    totalTokens: totalUsage.totalTokens
                });
            }

            // 在工具执行之前，先完成 API 消息记录
            // 这样可以确保即使工具执行失败，apiMessage 也能被正确记录
            if (callbacks?.onApiMessageFinalize) {
                this.logger.debug("ExecutionManager_handleStream_finalizingApiMessage", {
                    taskId: this.taskId,
                    contentLength: apiMessageContent.length
                });
                await callbacks.onApiMessageFinalize(apiMessageContent);
            }

            // 等待所有工具执行完成(并行执行)
            // 使用 allSettled 确保某个工具失败不影响其他工具
            if (toolExecutionPromises.length > 0) {
                const toolExecutionStartTime = Date.now();
                this.logger.debug("ExecutionManager_handleStream_waitingForToolExecutions", {
                    taskId: this.taskId,
                    toolCount: toolExecutionPromises.length
                });
                const results = await Promise.allSettled(toolExecutionPromises);
                const toolExecutionDuration = Date.now() - toolExecutionStartTime;

                // 记录失败的工具执行
                let failedCount = 0;
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        failedCount++;
                        this.logger.error("ExecutionManager_handleStream_toolExecutionFailed", {
                            taskId: this.taskId,
                            toolIndex: index + 1,
                            error: result.reason
                        });
                    }
                });

                if (failedCount === 0) {
                    this.logger.debug("ExecutionManager_handleStream_allToolExecutionsCompleted", {
                        taskId: this.taskId,
                        toolCount: toolExecutionPromises.length,
                        duration: toolExecutionDuration
                    });
                } else {
                    this.logger.warn("ExecutionManager_handleStream_someToolExecutionsFailed", {
                        taskId: this.taskId,
                        failedCount,
                        totalCount: toolExecutionPromises.length,
                        duration: toolExecutionDuration
                    });
                }
            }

            // 所有工具完成后,才调用流结束回调
            if (callbacks?.onStreamEnd) {
                await callbacks.onStreamEnd();
            }
        } catch (error) {
            const streamDuration = Date.now() - streamStartTime;
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const errorCode = errorObj instanceof AgentSDKError ? errorObj.code : undefined;

            this.logger.error("ExecutionManager_handleStream_error", {
                taskId: this.taskId,
                errorCode: errorCode || 'UNKNOWN',
                duration: streamDuration,
                chunkCount,
                textChunkCount,
                toolUseCount,
                error: errorObj
            });

            // 调用错误回调
            if (callbacks?.onError) {
                try {
                    await callbacks.onError(errorObj);
                } catch (callbackError) {
                    this.logger.error("ExecutionManager_handleStream_onErrorCallbackFailed", {
                        taskId: this.taskId,
                        error: callbackError
                    });
                }
            }

            throw new AgentSDKError(
                `Stream processing failed: ${errorObj.message}`,
                'STREAM_PROCESSING_ERROR',
                {
                    error: serializeError(errorObj),
                    originalError: serializeError(error),
                    duration: streamDuration,
                    chunkCount,
                    textChunkCount,
                    toolUseCount,
                }
            );
        }
    }

    /**
     * 中止当前执行
     */
    abort(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    /**
     * 检查是否正在执行
     */
    isExecuting(): boolean {
        return this.abortController !== undefined;
    }
}

/**
 * 创建执行管理器
 */
export function createExecutionManager(
    config: ExecutionManagerConfig & { taskId?: string }
): ExecutionManager {
    return new ExecutionManager(config);
}