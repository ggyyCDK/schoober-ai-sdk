/**
 * ReAct 引擎 - 负责执行 Reason-Act-Observe 循环
 *
 * 职责：
 * - 管理 ReAct 循环的执行
 * - 协调 ExecutionManager 和 MessageCoordinator
 * - 处理工具执行和错误追踪
 * - 控制循环的启动和停止
 */

import {
    ApiMessage,
    ToolUse,
    TaskStatus,
    TaskState,
    LLMProvider,
    AgentSDKError,
    ErrorContext,
    StreamUsage,
} from '@/types';
import { ExecutionManager } from './ExecutionManager';
import { MessageCoordinator } from './MessageCoordinator';
import { sleep } from '../utils/sleep';
import { isMessageContentEmpty } from '../utils/messageValidator';

/**
 * ReAct 执行回调
 */
export interface ReActCallbacks {
    /** 获取消息历史 */
    getMessages: () => ApiMessage[];
    /** 获取任务状态（用于控制循环） */
    getStatus: () => TaskStatus;
    /** 获取任务状态快照（用于构建 systemPrompt） */
    getTaskState: () => TaskState;
    /** 构建系统提示词 */
    buildSystemPrompt: (taskState: TaskState) => Promise<string>;
    /** 构建环境变量提示词 */
    buildEnvironmentPrompt: (taskState: TaskState) => Promise<string>;
    /** 插入提醒消息 */
    insertReminderMessage: (content: string) => Promise<void>;
    /** 处理工具执行 */
    handleToolExecution: (toolUse: ToolUse) => Promise<void>;
    /** 追踪错误 */
    trackError: (error: Error) => boolean; // 返回是否应该暂停
    /** 暂停任务 */
    pauseTask: (needRollback?: boolean) => Promise<void>;
    /** 更新 Token 使用情况 */
    updateTokenUsage: (inputTokens: number, outputTokens: number) => Promise<void>;
    /** 获取 LLM Provider */
    getLLMProvider: () => LLMProvider;
}

/**
 * ReAct 引擎配置
 */
export interface ReActEngineConfig {
    /** 执行管理器 */
    executionManager: ExecutionManager;
    /** 消息协调器 */
    messageCoordinator: MessageCoordinator;
    /** 回调 */
    callbacks: ReActCallbacks;
    /** 日志记录器（可选） */
    logger?: import('@/types').ILogger;
}

/**
 * ReAct 步骤执行结果
 */
export interface ReActStepResult {
    /** 是否执行了工具 */
    hasToolExecution: boolean;
    /** 是否执行了文本内容 */
    hasTextContent: boolean;
}

/**
 * ReAct 引擎
 * 负责执行 Reason-Act-Observe 循环
 */
export class ReActEngine {
    private executionManager: ExecutionManager;
    private messageCoordinator: MessageCoordinator;
    private callbacks: ReActCallbacks;
    private abortController?: AbortController;
    private logger?: import('@/types').ILogger;
    private taskId: string;

    constructor(config: ReActEngineConfig & { taskId: string }) {
        this.executionManager = config.executionManager;
        this.messageCoordinator = config.messageCoordinator;
        this.callbacks = config.callbacks;
        this.logger = config.logger;
        this.taskId = config.taskId;
    }

    /**
     * 启动 ReAct 循环
     * 循环条件直接基于任务状态，不维护内部状态标志
     */
    async run(): Promise<void> {
        const loopStartTime = Date.now();
        this.logger?.info("ReActEngine_run_start", {
            taskId: this.taskId
        });

        // 创建 AbortController 用于中止执行
        this.abortController = new AbortController();

        try {
            let loopCount = 0;
            let consecutiveNoToolExecutionCount = 0; // 追踪连续无工具执行次数
            // 循环条件：直接检查任务状态
            while (this.callbacks.getStatus() === TaskStatus.RUNNING) {
                loopCount++;
                const iterationStartTime = Date.now();
                this.logger?.debug("ReActEngine_run_iteration", {
                    taskId: this.taskId,
                    loopCount
                });

                // 检查是否被中止
                if (this.abortController.signal.aborted) {
                    this.logger?.info("ReActEngine_run_aborted", {
                        taskId: this.taskId,
                        loopCount
                    });
                    break;
                }

                try {
                    // 执行单步 ReAct
                    const result = await this.executeStep();
                    const iterationDuration = Date.now() - iterationStartTime;
                    this.logger?.debug("ReActEngine_run_iterationCompleted", {
                        taskId: this.taskId,
                        loopCount,
                        duration: iterationDuration,
                        hasToolExecution: result.hasToolExecution
                    });

                    if (!result.hasTextContent && !result.hasToolExecution) {
                        await sleep(100)
                        this.logger?.error("ReActEngine_run_noTextContent", {
                            taskId: this.taskId,
                            loopCount
                        });
                        continue;
                    }
                    // 如果没有工具执行，插入提醒消息
                    if (!result.hasToolExecution) {
                        consecutiveNoToolExecutionCount++; // 递增计数器

                        this.logger?.warn("ReActEngine_run_noToolExecution", {
                            taskId: this.taskId,
                            loopCount,
                            consecutiveCount: consecutiveNoToolExecutionCount
                        });

                        // 检查是否达到阈值（3次）
                        if (consecutiveNoToolExecutionCount >= 3) {
                            this.logger?.warn("ReActEngine_run_tooManyNoToolExecution", {
                                taskId: this.taskId,
                                consecutiveCount: consecutiveNoToolExecutionCount
                            });
                            await this.callbacks.pauseTask();
                            break;
                        }

                        await this.callbacks.insertReminderMessage(
                            'You must call a tool. Please select an appropriate tool based on the current task progress, or use the attempt_completion tool to complete or abort the task.'
                        );
                        continue;
                    }

                    // 如果有工具执行，重置连续无工具执行计数器
                    consecutiveNoToolExecutionCount = 0;
                } catch (error) {
                    const iterationDuration = Date.now() - iterationStartTime;
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    this.logger?.error("ReActEngine_run_iterationFailed", {
                        taskId: this.taskId,
                        loopCount,
                        duration: iterationDuration,
                        error: errorObj
                    });
                    // 追踪错误
                    const shouldPause = this.callbacks.trackError(errorObj);
                    if (shouldPause) {
                        this.logger?.warn("ReActEngine_run_tooManyErrors", {
                            taskId: this.taskId
                        });
                        await this.callbacks.pauseTask();
                        break;
                    }

                    // 继续下一轮循环，尝试恢复
                    continue;
                }
                // 继续下一轮循环
                // 注意：如果工具调用了 completeTask()，状态会变为 COMPLETED，循环自然停止
            }

            const totalDuration = Date.now() - loopStartTime;
            const finalStatus = this.callbacks.getStatus();
            this.logger?.info("ReActEngine_run_completed", {
                taskId: this.taskId,
                iterations: loopCount,
                duration: totalDuration,
                finalStatus: finalStatus.getValue()
            });
        } finally {
            this.abortController = undefined;
        }
    }

    /**
     * 中止 ReAct 循环
     * 通过 AbortController 中止正在进行的 LLM 请求
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

    /**
     * 执行单步 ReAct
     */
    private async executeStep(): Promise<ReActStepResult> {
        const stepStartTime = Date.now();
        this.logger?.debug("ReActEngine_executeStep_start", {
            taskId: this.taskId
        });

        // 获取消息历史
        const messages = this.callbacks.getMessages();
        this.logger?.debug("ReActEngine_executeStep_messagesRetrieved", {
            taskId: this.taskId,
            messageCount: messages.length
        });

        // 获取当前任务状态
        const taskState = this.callbacks.getTaskState();

        // 动态生成系统提示词
        const systemPromptStartTime = Date.now();
        const systemPrompt = await this.callbacks.buildSystemPrompt(taskState);
        const systemPromptDuration = Date.now() - systemPromptStartTime;

        this.logger?.info("ReActEngine_executeStep_systemPromptBuilt", {
            taskId: this.taskId,
            length: systemPrompt.length,
            duration: systemPromptDuration
        });

        // 动态生成环境变量提示词
        const envPromptStartTime = Date.now();
        const envPrompt = await this.callbacks.buildEnvironmentPrompt(taskState);
        const envPromptDuration = Date.now() - envPromptStartTime;

        // 构建最终的消息数组和缓存控制索引
        let finalMessages = messages;
        let cacheControlIndex: number | undefined = undefined;

        if (envPrompt && envPrompt.trim().length > 0) {
            // 将环境变量提示词追加到消息队列尾部（作为 user 消息）
            const envMessage: ApiMessage = {
                id: `env-${Date.now()}`,
                taskId: this.taskId,
                role: 'user',
                content: envPrompt,
                ts: Date.now(),
                source: 'system',
            };
            finalMessages = [...messages, envMessage];
            // 缓存控制索引设置为环境变量提示词之前的索引（倒数第二条）
            cacheControlIndex = messages.length - 1;

            this.logger?.info("ReActEngine_executeStep_envPromptBuilt", {
                taskId: this.taskId,
                length: envPrompt.length,
                duration: envPromptDuration,
                cacheControlIndex
            });
        }

        // 兜底手段：过滤掉所有 content 为空的消息，避免传递给 LLM 导致错误
        const originalMessageCount = finalMessages.length;
        finalMessages = finalMessages.filter(message => {
            const isEmpty = isMessageContentEmpty(message);
            if (isEmpty) {
                this.logger?.warn("ReActEngine_executeStep_filteredEmptyMessage", {
                    taskId: this.taskId,
                    messageId: message.id,
                    role: message.role,
                    source: message.source,
                    contentType: Array.isArray(message.content) ? 'array' : typeof message.content,
                    contentLength: typeof message.content === 'string'
                        ? message.content.length
                        : Array.isArray(message.content)
                            ? message.content.length
                            : 0
                });
            }
            return !isEmpty;
        });

        if (originalMessageCount !== finalMessages.length) {
            this.logger?.warn("ReActEngine_executeStep_filteredEmptyMessages", {
                taskId: this.taskId,
                originalCount: originalMessageCount,
                filteredCount: finalMessages.length,
                removedCount: originalMessageCount - finalMessages.length
            });
        }

        let hasToolExecution = false;

        let hasTextContent = false;
        // 注意：usage 是累积的完整值，不需要累加，直接使用最后一次的值
        let lastUsage: StreamUsage | null = null;
        let toolExecutionCount = 0;

        const toolExecutionTimes: number[] = [];

        // 开始流式消息追踪
        this.messageCoordinator.startStreamingMessage();

        try {
            // 执行 LLM 请求，传入动态生成的 systemPrompt 和扩展的消息数组
            await this.executionManager.execute(finalMessages, {
                systemPrompt, // 每次 Loop 都使用最新生成的 systemPrompt
                cacheControlIndex, // 缓存控制索引（如果存在环境变量提示词）
                abortSignal: this.abortController?.signal,
                callbacks: {
                    // 处理文本内容 (Thought)
                    onTextContent: async (text: string) => {
                        if (text) {
                            hasTextContent = true;
                            await this.messageCoordinator.updateUserMessageContent(text);
                        }
                    },

                    // 处理工具使用 (Action)
                    onToolUse: async (toolUse: ToolUse) => {
                        if (!toolUse.requestId) return;
                        hasToolExecution = true;
                        toolExecutionCount++;
                        const toolStartTime = Date.now();
                        try {
                            // 委托给外部处理工具执行
                            await this.callbacks.handleToolExecution(toolUse);
                            const toolDuration = Date.now() - toolStartTime;
                            toolExecutionTimes.push(toolDuration);
                        } catch (error) {
                            const toolDuration = Date.now() - toolStartTime;
                            const errorObj = error instanceof Error ? error : new Error(String(error));
                            this.logger?.error("ReActEngine_executeStep_toolExecutionFailed", {
                                taskId: this.taskId,
                                toolName: toolUse.name,
                                duration: toolDuration,
                                error: errorObj
                            });


                            // 追踪错误
                            const shouldPause = this.callbacks.trackError(errorObj);
                            if (shouldPause) {
                                this.logger?.warn("ReActEngine_executeStep_tooManyErrors", {
                                    taskId: this.taskId
                                });
                                // 暂停任务
                                await this.callbacks.pauseTask();
                                return;
                            }
                            // 将错误信息添加到消息历史（供 LLM 参考）
                            await this.callbacks.insertReminderMessage(
                                `工具执行失败: ${toolUse.name}\n错误: ${errorObj.message}`
                            );


                        }
                    },

                    // 处理 Token 使用情况
                    // 注意：usage 是累积的完整值，不需要累加，直接使用最后一次的值
                    onUsage: async (usage: StreamUsage) => {
                        lastUsage = usage;
                        this.logger?.debug("ReActEngine_executeStep_usageUpdate", {
                            taskId: this.taskId,
                            inputTokens: usage.inputTokens,
                            outputTokens: usage.outputTokens,
                            totalTokens: usage.totalTokens
                        });
                    },

                    // API 消息内容累积回调（不再需要，由 ExecutionManager 处理）
                    onApiMessageContent: (content: string) => {
                        // 不需要做任何事，ExecutionManager 会自动累积
                    },

                    // API 消息完成回调（在流结束时由 ExecutionManager 调用）
                    onApiMessageFinalize: async (content: string) => {
                        this.logger?.debug("ReActEngine_executeStep_finalizingApiMessage", {
                            taskId: this.taskId,
                            contentLength: content.length
                        });
                        await this.messageCoordinator.finalizeApiMessage(content);
                    },

                    // 错误回调
                    onError: async (error: Error) => {
                        this.logger?.error("ReActEngine_executeStep_llmError", {
                            taskId: this.taskId,
                            error
                        });
                        // 错误消息由 ErrorHandler 统一发送，这里不再重复发送
                    },
                },
            });

            // 请求完成后，更新 token 使用情况
            // usage 是累积的完整值，直接使用最后一次的值
            const inputTokens = (lastUsage as StreamUsage | null)?.inputTokens ?? 0;
            const outputTokens = (lastUsage as StreamUsage | null)?.outputTokens ?? 0;
            await this.callbacks.updateTokenUsage(inputTokens, outputTokens);

            const stepDuration = Date.now() - stepStartTime;
            const avgToolDuration = toolExecutionTimes.length > 0
                ? toolExecutionTimes.reduce((a, b) => a + b, 0) / toolExecutionTimes.length
                : 0;

            this.logger?.info("ReActEngine_executeStep_completed", {
                taskId: this.taskId,
                duration: stepDuration,
                hasToolExecution,
                toolCount: toolExecutionCount,
                avgToolDuration: avgToolDuration.toFixed(2),
                inputTokens,
                outputTokens
            });
        } catch (error) {
            const stepDuration = Date.now() - stepStartTime;
            const errorObj = error instanceof Error ? error : new Error(String(error));
            this.logger?.error("ReActEngine_executeStep_failed", {
                taskId: this.taskId,
                duration: stepDuration,
                error: errorObj
            });

            // 错误消息由 ErrorHandler 统一发送，这里不再重复发送

            // 重新抛出错误，让上层处理
            throw errorObj;
        } finally {
            this.logger?.debug("ReActEngine_executeStep_finally", {
                taskId: this.taskId
            });
        }

        return { hasToolExecution, hasTextContent };
    }
}

/**
 * 创建 ReActEngine
 */
export function createReActEngine(config: ReActEngineConfig & { taskId: string }): ReActEngine {
    return new ReActEngine(config);
}