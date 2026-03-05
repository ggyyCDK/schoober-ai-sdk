/**
 * 消息协调器 - 负责协调 API 消息和用户消息的创建、更新、发送
 *
 * 职责：
 * - 追踪流式消息（currentUserTextMessageId、currentApiMessageId）
 * - 协调 API 消息和用户消息的同步
 * - 简化 TaskExecutor 的消息处理逻辑
 */

import {
    ApiMessage,
    UserMessage,
    ToolInfo,
    ErrorContext,
    AgentSDKError,
    sanitizeDetails,
} from '@/types';
import { IMessageManager } from './MessageManager';
import {
    generateApiMessageId,
    generateUserMessageId,
} from '../utils/idGenerator';
import { ImageTemplateParser, createImageTemplateParser } from '../utils/ImageTemplateParser';
import { isContentEmpty } from '../utils/messageValidator';

/**
 * 消息发送回调
 */
export interface MessageSendCallback {
    (message: UserMessage): Promise<void>;
}

/**
 * 消息协调器配置
 */
export interface MessageCoordinatorConfig {
    /** 任务 ID */
    taskId: string;
    /** 消息管理器（通过接口访问） */
    messageManager: IMessageManager;
    /** 消息发送回调（发送给外部 UI） */
    onMessageSend?: MessageSendCallback;
    /** 日志记录器（可选） */
    logger?: import('@/types').ILogger;
    /** Agent 名称（用于标识消息来源） */
    agentName?: string;
}

/**
 * 消息协调器
 * 负责协调 API 消息和用户消息的创建、更新、发送
 */
export class MessageCoordinator {
    private taskId: string;
    private messageManager: IMessageManager;
    private onMessageSend?: MessageSendCallback;
    private imageParser: ImageTemplateParser;
    private logger?: import('@/types').ILogger;
    private agentName?: string;

    // 当前流式消息追踪
    private currentUserTextMessageId?: string;
    private currentApiMessageId?: string;
    private currentApiMessageContent: string = '';

    // 轮次起点追踪（用于暂停/错误时回滚）
    private roundStartApiMessageCount: number = 0;
    private isRoundInProgress: boolean = false;

    constructor(config: MessageCoordinatorConfig) {
        this.taskId = config.taskId;
        this.messageManager = config.messageManager;
        this.onMessageSend = config.onMessageSend;
        this.imageParser = createImageTemplateParser();
        this.logger = config.logger;
        this.agentName = config.agentName;
    }

    /**
     * 开始追踪流式消息
     * 在每次 LLM 请求开始时调用
     */
    startStreamingMessage(): void {
        // 记录本轮开始时的消息数量（作为回滚点）
        this.roundStartApiMessageCount = this.messageManager.getApiMessages().length;
        this.isRoundInProgress = true;

        // 生成消息 ID
        this.currentUserTextMessageId = generateUserMessageId();
        this.currentApiMessageContent = '';

        // 插入占位 API 消息
        const placeholderApiMessage: ApiMessage = {
            id: generateApiMessageId(),
            taskId: this.taskId,
            role: 'assistant',
            content: '',
            ts: Date.now(),
            source: 'assistant',
        };
        this.currentApiMessageId = placeholderApiMessage.id;
        this.messageManager.addApiMessage(placeholderApiMessage);
    }

    /**
     * 追加 chunk 到当前内容
     */
    appendChunk(chunk: string): void {
        this.currentApiMessageContent += chunk;
    }

    /**
     * 更新用户消息内容
     * 用于流式更新用户可见的消息内容（UI展示）
     * @param text 累积的完整内容
     */
    async updateUserMessageContent(text: string): Promise<void> {
        if (!this.currentUserTextMessageId) {
            return;
        }

        // 检查是否已存在
        const existing = this.messageManager.getUserMessageById(this.currentUserTextMessageId);

        // 发送或更新用户消息（UI 展示）
        const userMessage: UserMessage = {
            id: this.currentUserTextMessageId,
            taskId: this.taskId,
            type: 'text',
            role: 'assistant',
            content: text,
            ts: Date.now(),
            metadata: {
                ...(existing?.metadata || {}),
                ...(this.agentName ? { agentName: this.agentName } : {}),
            },
        };

        if (existing) {
            this.messageManager.updateUserMessage(userMessage.id, userMessage);
        } else {
            this.messageManager.addUserMessage(userMessage);
        }

        // 调用回调发送给 UI（不持久化）
        if (this.onMessageSend) {
            await this.onMessageSend(userMessage);
        }
    }

    /**
     * 完成 API 消息记录
     * 在 ExecutionManager 流式处理结束时调用
     * @param content 大模型返回的完整内容
     */
    async finalizeApiMessage(content: string): Promise<void> {
        if (!this.currentApiMessageId) {
            this.logger?.warn("MessageCoordinator_finalizeApiMessage_noCurrentMessage", {
                taskId: this.taskId
            });
            return;
        }

        // 保存消息ID，因为后面会重置状态
        const messageId = this.currentApiMessageId;

        // 检查消息是否存在
        const existingMessage = this.messageManager.getApiMessageById(messageId);
        if (!existingMessage) {
            // 消息不存在，可能是被意外删除或从未创建
            // 如果内容不为空，创建新消息；如果为空，则忽略
            if (content) {
                this.logger?.warn("MessageCoordinator_finalizeApiMessage_messageNotFound", {
                    taskId: this.taskId,
                    messageId
                });
                const newMessage: ApiMessage = {
                    id: messageId,
                    taskId: this.taskId,
                    role: 'assistant',
                    content: content,
                    ts: Date.now(),
                    source: 'assistant',
                };
                this.messageManager.addApiMessage(newMessage);
                this.logger?.debug("MessageCoordinator_finalizeApiMessage_messageCreated", {
                    taskId: this.taskId,
                    messageId,
                    contentLength: content.length
                });
            } else {
                this.logger?.debug("MessageCoordinator_finalizeApiMessage_skipped", {
                    taskId: this.taskId,
                    messageId
                });
            }
        } else if (content) {
            // 消息存在且有内容，更新消息（已自动触发防抖持久化）
            this.messageManager.updateApiMessage(messageId, {
                content,
            });
            this.logger?.debug("MessageCoordinator_finalizeApiMessage_success", {
                taskId: this.taskId,
                messageId,
                contentLength: content.length
            });
        } else {
            // 消息存在但无内容，删除占位消息（已自动触发防抖持久化）
            this.messageManager.removeApiMessageById(messageId);
            this.logger?.debug("MessageCoordinator_finalizeApiMessage_emptyRemoved", {
                taskId: this.taskId,
                messageId
            });
        }
        // 重置 API 消息追踪状态
        this.currentApiMessageId = undefined;
        this.currentApiMessageContent = '';

        // 异步保存，不阻塞主流程
        // 这是流结束的关键时刻，必须确保消息被保存，避免丢失
        // 使用 catch 处理错误，避免影响主流程
        this.messageManager.saveApiMessagesNow().then(() => {
            this.logger?.debug("MessageCoordinator_finalizeApiMessage_saved", {
                taskId: this.taskId
            });
        }).catch(error => {
            this.logger?.error("MessageCoordinator_finalizeApiMessage_saveFailed", {
                taskId: this.taskId,
                error
            });
        });
    }


    /**
     * 添加用户输入消息
     * 支持图片模板解析
     */
    async addUserInput(message: string): Promise<void> {
        // 解析图片模板
        const parseResult = this.imageParser.parse(message);

        // 创建 API 消息（LLM 对话历史）
        // 如果包含图片，使用解析后的 ContentBlock[]，否则保持字符串格式
        const apiMessage: ApiMessage = {
            id: generateApiMessageId(),
            taskId: this.taskId,
            role: 'user',
            content: parseResult.hasImages ? parseResult.blocks : message,
            ts: Date.now(),
            source: 'user',
        };

        // 添加消息（已自动触发防抖持久化）
        this.messageManager.addApiMessage(apiMessage);

        // 创建用户消息（UI 展示）
        // 保留原始模板字符串，方便 UI 展示和编辑
        const userMessage: UserMessage = {
            id: generateUserMessageId(),
            taskId: this.taskId,
            type: 'text',
            role: 'user',
            content: message, // 保留原始模板
            ts: Date.now(),
            metadata: {
                ...(this.agentName ? { agentName: this.agentName } : {}),
            },
        };

        // 添加消息（已自动触发防抖持久化）
        this.messageManager.addUserMessage(userMessage);

        // 发送给 UI
        if (this.onMessageSend) {
            await this.onMessageSend(userMessage);
        }
    }

    async insertApiMessage(contentOrMessage: string | ApiMessage): Promise<void> {
        // 如果传入的是字符串，创建系统消息
        if (typeof contentOrMessage === 'string') {
            // 验证 content 不为空
            if (isContentEmpty(contentOrMessage)) {
                this.logger?.warn("MessageCoordinator_insertApiMessage_emptyContentRejected", {
                    taskId: this.taskId,
                    contentType: 'string',
                    contentLength: contentOrMessage.length
                });
                return;
            }

            const apiMessage: ApiMessage = {
                id: generateApiMessageId(),
                taskId: this.taskId,
                role: 'user',
                content: contentOrMessage,
                ts: Date.now(),
                source: 'system',
            };
            this.messageManager.addApiMessage(apiMessage);
        } else {
            // 如果传入的是 ApiMessage，验证 content 不为空
            if (isContentEmpty(contentOrMessage.content)) {
                this.logger?.warn("MessageCoordinator_insertApiMessage_emptyContentRejected", {
                    taskId: this.taskId,
                    messageId: contentOrMessage.id,
                    role: contentOrMessage.role,
                    source: contentOrMessage.source,
                    contentType: Array.isArray(contentOrMessage.content) ? 'array' : typeof contentOrMessage.content,
                    contentLength: typeof contentOrMessage.content === 'string'
                        ? contentOrMessage.content.length
                        : Array.isArray(contentOrMessage.content)
                            ? contentOrMessage.content.length
                            : 0
                });
                return;
            }

            // 如果传入的是 ApiMessage，直接添加
            this.messageManager.addApiMessage(contentOrMessage);
        }
    }

    /**
     * 发送工具消息
     */
    async sendToolMessage(
        toolInfo: ToolInfo,
        requestId: string
    ): Promise<void> {
        // 检查是否已存在
        const existing = this.messageManager.getUserMessageById(requestId);

        const userMessage: UserMessage = {
            id: requestId,
            taskId: this.taskId,
            type: 'tool',
            role: 'assistant',
            toolInfo,
            ts: Date.now(),
            metadata: {
                ...(existing?.metadata || {}),
                ...(this.agentName ? { agentName: this.agentName } : {}),
            },
        };

        if (existing) {
            // 更新消息（已自动触发防抖持久化）
            this.messageManager.updateUserMessage(userMessage.id, userMessage);
        } else {
            // 添加消息（已自动触发防抖持久化）
            this.messageManager.addUserMessage(userMessage);
        }

        // 发送给 UI
        try {
            if (this.onMessageSend) {
                await this.onMessageSend(userMessage);
            }
        } catch (error) {
            this.logger?.error("MessageCoordinator_sendToolMessage_failed", {
                taskId: this.taskId,
                requestId,
                error
            });
            // 不抛出错误，避免影响主流程
        }
    }

    /**
     * 发送错误消息
     * @param error 错误对象
     * @param context 错误上下文（可选）
     */
    async sendErrorMessage(error: Error, context?: ErrorContext): Promise<void> {
        const startTime = Date.now();
        const errorId = generateUserMessageId();
        const errorType = context?.errorType || this.inferErrorType(error);
        const errorCode = context?.errorCode || (error instanceof AgentSDKError ? error.code : undefined);
        const source = context?.source || 'Unknown';

        this.logger?.error("MessageCoordinator_sendErrorMessage_creating", {
            taskId: this.taskId,
            errorType,
            errorCode,
            source,
            error
        });

        // 生成友好的错误消息
        const friendlyMessage = this.formatErrorMessage(error, errorType, errorCode);
        // 构建错误元数据
        const errorMetadata: Record<string, any> = {
            errorType,
            errorCode,
            source,
            errorMessage: error.message,
            errorStack: error.stack,
            ...context,
        };

        // 如果是 AgentSDKError，添加 details（序列化以避免循环引用）
        if (error instanceof AgentSDKError && error.details) {
            errorMetadata.details = sanitizeDetails(error.details);
        }

        const userMessage: UserMessage = {
            id: errorId,
            taskId: this.taskId,
            type: 'error',
            role: 'system',
            content: friendlyMessage,
            ts: Date.now(),
            visible: true,
            metadata: {
                ...(this.agentName ? { agentName: this.agentName } : {}),
                ...errorMetadata,
            },
        };

        // 添加消息（已自动触发防抖持久化）
        this.messageManager.addUserMessage(userMessage);
        this.logger?.info("MessageCoordinator_sendErrorMessage_added", {
            taskId: this.taskId,
            errorId,
            errorType
        });

        // 发送给 UI
        try {
            if (this.onMessageSend) {
                await this.onMessageSend(userMessage);
                const duration = Date.now() - startTime;
                this.logger?.debug("MessageCoordinator_sendErrorMessage_sent", {
                    taskId: this.taskId,
                    errorId,
                    duration
                });
            }
        } catch (sendError) {
            this.logger?.error("MessageCoordinator_sendErrorMessage_sendFailed", {
                taskId: this.taskId,
                errorId,
                error: sendError
            });
            // 不抛出错误，避免影响主流程
        }
    }

    /**
     * 推断错误类型
     */
    private inferErrorType(error: Error): ErrorContext['errorType'] {
        if (error instanceof AgentSDKError) {
            const code = error.code?.toUpperCase() || '';
            if (code.includes('NETWORK') || code.includes('CONNECTION')) {
                return 'network';
            }
            if (code.includes('TIMEOUT')) {
                return 'timeout';
            }
            if (code.includes('VALIDATION')) {
                return 'validation';
            }
            if (code.includes('TOOL')) {
                return 'tool';
            }
            if (code.includes('EXECUTION') || code.includes('STREAM')) {
                return 'execution';
            }
        }

        const message = error.message.toLowerCase();
        if (message.includes('network') || message.includes('connection') || message.includes('econnrefused')) {
            return 'network';
        }
        if (message.includes('timeout') || message.includes('timed out')) {
            return 'timeout';
        }
        if (message.includes('validation') || message.includes('invalid')) {
            return 'validation';
        }

        return 'unknown';
    }

    /**
     * 格式化错误消息为友好的用户提示
     */
    private formatErrorMessage(error: Error, errorType: ErrorContext['errorType'], errorCode?: string): string {
        const baseMessage = error.message;

        switch (errorType) {
            case 'llm':
                if (errorCode === 'TIMEOUT_ERROR' || baseMessage.includes('timeout')) {
                    return `大模型请求失败：网络连接超时。请检查网络连接后重试。`;
                }
                if (errorCode === 'NETWORK_ERROR' || baseMessage.includes('network') || baseMessage.includes('connection')) {
                    return `大模型请求失败：网络连接错误。请检查网络连接后重试。`;
                }
                if (errorCode === 'RATE_LIMIT_ERROR' || baseMessage.includes('rate limit')) {
                    return `大模型请求失败：请求频率过高，请稍后重试。`;
                }
                if (errorCode === 'QUOTA_ERROR' || baseMessage.includes('quota') || baseMessage.includes('insufficient')) {
                    return `大模型请求失败：配额不足，请检查账户余额。`;
                }
                if (errorCode === 'AUTH_ERROR' || baseMessage.includes('api key') || baseMessage.includes('authentication')) {
                    return `大模型请求失败：认证失败，请检查 API 密钥配置。`;
                }
                return `大模型请求失败：${baseMessage}`;

            case 'tool':
                return `工具执行失败：${baseMessage}`;

            case 'execution':
                if (baseMessage.includes('aborted')) {
                    return `任务执行已中止。`;
                }
                return `任务执行失败：${baseMessage}`;

            case 'network':
                return `网络连接失败：${baseMessage}。请检查网络连接后重试。`;

            case 'timeout':
                return `请求超时：${baseMessage}。请稍后重试。`;

            case 'validation':
                return `参数验证失败：${baseMessage}`;

            default:
                return `发生错误：${baseMessage}`;
        }
    }

    // ============= 查询方法（供 TaskExecutor 使用）=============

    /**
     * 获取所有 API 消息
     * 供 TaskExecutor 使用，统一通过 MessageCoordinator 访问
     */
    getApiMessages(): ApiMessage[] {
        return this.messageManager.getApiMessages();
    }

    /**
     * 获取所有用户消息
     * 供 TaskExecutor 使用，统一通过 MessageCoordinator 访问
     */
    getUserMessages(): UserMessage[] {
        return this.messageManager.getUserMessages();
    }

    /**
     * 发送用户消息（供 TaskExecutor 使用）
     * 统一的消息发送入口，处理新增和更新逻辑
     */
    async sendUserMessage(message: UserMessage, needPersist: boolean = true): Promise<void> {
        // 检查 ID 是否存在
        const existing = this.messageManager.getUserMessageById(message.id);
        if (existing) {
            // 存在则更新（已自动触发防抖持久化）
            this.messageManager.updateUserMessage(message.id, message);
        } else {
            // 不存在则添加（已自动触发防抖持久化）
            this.messageManager.addUserMessage(message);
        }

        // needPersist 参数控制是否立即保存（关键时刻使用）
        if (needPersist) {
            await this.messageManager.saveUserMessagesNow();
        }

        // 调用回调发送给用户
        if (this.onMessageSend) {
            await this.onMessageSend(message);
        }
    }


    /**
     * 立即保存所有消息（供 TaskExecutor 使用）
     * 用于关键时刻：任务完成、失败、中止等
     */
    async saveAllMessagesNow(): Promise<void> {
        await this.messageManager.saveAllMessagesNow();
    }

    /**
     * 从持久化存储加载所有消息（供 TaskExecutor 使用）
     * 用于任务恢复场景
     */
    async loadAllMessages(): Promise<void> {
        await this.messageManager.loadAllMessages();
    }

    // ============= 轮次管理方法 =============

    /**
     * 回滚本轮 API 消息
     * 仅回滚 API 消息（LLM 对话历史），保留 UserMessage（UI展示）
     * 用于暂停/错误时清理不完整的对话历史
     */
    rollbackCurrentRoundApiMessages(): void {
        // 如果没有进行中的轮次，不执行回滚
        if (!this.isRoundInProgress) {
            this.logger?.debug("MessageCoordinator_rollbackCurrentRoundApiMessages_noRoundInProgress", {
                taskId: this.taskId
            });
            return;
        }

        const currentApiMessages = this.messageManager.getApiMessages();
        const rollbackCount = currentApiMessages.length - this.roundStartApiMessageCount;

        if (rollbackCount <= 0) {
            this.logger?.debug("MessageCoordinator_rollbackCurrentRoundApiMessages_noRollback", {
                taskId: this.taskId,
                currentCount: currentApiMessages.length,
                roundStartCount: this.roundStartApiMessageCount
            });
            // 重置追踪状态
            this.resetStreamingState();
            return;
        }

        // 从后向前删除本轮新增的 API 消息
        for (let i = currentApiMessages.length - 1; i >= this.roundStartApiMessageCount; i--) {
            this.messageManager.removeApiMessageById(currentApiMessages[i].id);
        }

        this.logger?.info("MessageCoordinator_rollbackCurrentRoundApiMessages", {
            taskId: this.taskId,
            rolledBackCount: rollbackCount,
            remainingCount: this.roundStartApiMessageCount
        });

        // 重置追踪状态
        this.resetStreamingState();
    }

    /**
     * 重置流式消息追踪状态
     * 内部方法，用于回滚后清理状态
     */
    private resetStreamingState(): void {
        this.currentApiMessageId = undefined;
        this.currentApiMessageContent = '';
        this.currentUserTextMessageId = undefined;
        this.isRoundInProgress = false;
    }

    /**
     * 发送暂停通知消息
     * 作为系统消息发送给用户，标记任务已暂停
     */
    async sendPauseNotification(): Promise<void> {
        const userMessage: UserMessage = {
            id: generateUserMessageId(),
            taskId: this.taskId,
            type: 'system',
            role: 'system',
            content: '任务已暂停',
            ts: Date.now(),
            visible: true,
            metadata: {
                ...(this.agentName ? { agentName: this.agentName } : {}),
                pausedAt: new Date().toISOString(),
                reason: 'user_requested',
            },
        };

        this.messageManager.addUserMessage(userMessage);

        if (this.onMessageSend) {
            await this.onMessageSend(userMessage);
        }

        this.logger?.info("MessageCoordinator_sendPauseNotification", {
            taskId: this.taskId,
            messageId: userMessage.id
        });
    }

    /**
     * 清理资源（供 TaskExecutor 使用）
     * 用于析构时清理定时器等资源
     */
    destroy(): void {
        this.messageManager.destroy();
    }
}

/**
 * 创建消息协调器
 */
export function createMessageCoordinator(
    config: MessageCoordinatorConfig
): MessageCoordinator {
    return new MessageCoordinator(config);
}