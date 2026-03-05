/**
 * 消息管理器 - 负责 ApiMessage 和 UserMessage 的管理和持久化
 * 
 * 核心改进:
 * - 管理两个队列：apiMessages（LLM对话历史）和 userMessages（UI展示消息）
 * - 保证消息 ID 的唯一性
 * - 支持消息的增删改查和持久化
 */

import { ApiMessage, UserMessage, PersistenceManager, AgentSDKError, ILogger, createDefaultLogger } from '@/types';
import { isContentEmpty } from '../utils/messageValidator';

/**
 * 消息管理器配置
 */
export interface MessageManagerConfig {
    /** 任务ID */
    taskId: string;
    /** 持久化管理器(可选) */
    persistenceManager?: PersistenceManager;
    /** 最大消息数量(超过后自动清理旧消息) */
    maxMessages?: number;
    /** 日志记录器（可选） */
    logger?: ILogger;
}

/**
 * 消息管理器接口（内部接口）
 * 定义 MessageCoordinator 需要的所有方法，用于收敛接口访问
 */
export interface IMessageManager {
    // API 消息管理
    addApiMessage(message: ApiMessage): void;
    updateApiMessage(id: string, updates: Partial<ApiMessage>): void;
    removeApiMessageById(messageId: string): boolean;
    getApiMessageById(id: string): ApiMessage | undefined;
    getApiMessages(): ApiMessage[];

    // User 消息管理
    addUserMessage(message: UserMessage): void;
    updateUserMessage(id: string, updates: Partial<UserMessage>): void;
    removeUserMessageById(messageId: string): boolean;
    getUserMessageById(id: string): UserMessage | undefined;
    getUserMessages(): UserMessage[];

    // 持久化操作
    saveApiMessagesNow(): Promise<void>;
    saveUserMessagesNow(): Promise<void>;
    saveAllMessagesNow(): Promise<void>;
    loadAllMessages(): Promise<void>;

    // 资源清理
    destroy(): void;
}

/**
 * 消息管理器实现
 * 实现 IMessageManager 接口，只对 MessageCoordinator 开放
 */
export class MessageManager implements IMessageManager {
    private taskId: string;
    private apiMessages: ApiMessage[] = [];
    private userMessages: UserMessage[] = [];
    private persistenceManager?: PersistenceManager;
    private maxMessages: number;
    private logger: ILogger;

    // 防抖控制 - API 消息（内置优化，始终开启）
    private readonly DEBOUNCE_MS = 1000; // 防抖延迟 1 秒
    private readonly MAX_WAIT_MS = 5000; // 最大等待 5 秒
    private apiSaveTimer?: NodeJS.Timeout;
    private firstPendingApiSaveTime?: number;
    private isSavingApi: boolean = false;
    private hasPendingApiChanges: boolean = false;
    // Promise 队列用于串行化保存操作，避免并发冲突
    private saveApiQueue: Promise<void> = Promise.resolve();

    // 防抖控制 - User 消息（内置优化，始终开启）
    private userSaveTimer?: NodeJS.Timeout;
    private firstPendingUserSaveTime?: number;
    private isSavingUser: boolean = false;
    private hasPendingUserChanges: boolean = false;
    // Promise 队列用于串行化保存操作，避免并发冲突
    private saveUserQueue: Promise<void> = Promise.resolve();

    constructor(config: MessageManagerConfig) {
        this.taskId = config.taskId;
        this.persistenceManager = config.persistenceManager;
        this.maxMessages = config.maxMessages ?? 1000;
        this.logger = config.logger || createDefaultLogger();
    }

    // ============= API 消息管理 =============

    /**
     * 添加 API 消息
     */
    addApiMessage(message: ApiMessage): void {
        // 验证消息
        if (!message.id || !message.role) {
            throw new AgentSDKError(
                'Invalid API message: id, role, and content are required',
                'INVALID_MESSAGE'
            );
        }

        // 验证 content 不为空
        // 特殊情况：assistant role 允许空 content（占位消息，后续会通过 finalizeApiMessage 更新或删除）
        // 其他 role 严格验证 content 不为空
        if (message.role !== 'assistant' && isContentEmpty(message.content)) {
            const contentType = Array.isArray(message.content) ? 'array' : typeof message.content;
            const contentLength = typeof message.content === 'string'
                ? message.content.length
                : Array.isArray(message.content)
                    ? message.content.length
                    : 0;

            this.logger.warn("MessageManager_addApiMessage_emptyContentRejected", {
                taskId: this.taskId,
                messageId: message.id,
                role: message.role,
                source: message.source,
                contentType,
                contentLength
            });

            throw new AgentSDKError(
                `Invalid API message: content cannot be empty for role '${message.role}'`,
                'INVALID_MESSAGE'
            );
        }

        // 检查 ID 唯一性
        if (this.apiMessages.find(m => m.id === message.id)) {
            throw new AgentSDKError(
                `API message with id ${message.id} already exists`,
                'DUPLICATE_MESSAGE_ID'
            );
        }

        // 确保 taskId 一致
        if (message.taskId !== this.taskId) {
            message.taskId = this.taskId;
        }

        // 添加到列表
        this.apiMessages.push(message);

        // 检查是否超过最大数量
        if (this.apiMessages.length > this.maxMessages) {
            // 保留最新的消息,删除最旧的
            this.apiMessages = this.apiMessages.slice(-this.maxMessages);
        }

        // 触发防抖持久化（自动优化，内置开启）
        if (this.persistenceManager) {
            this.scheduleSaveApiMessages();
        }
    }

    /**
     * 更新 API 消息
     */
    updateApiMessage(id: string, updates: Partial<ApiMessage>): void {
        const message = this.apiMessages.find(m => m.id === id);
        if (!message) {
            throw new AgentSDKError(
                `API message with id ${id} not found`,
                'MESSAGE_NOT_FOUND'
            );
        }

        Object.assign(message, updates);

        // 触发防抖持久化（自动优化，内置开启）
        if (this.persistenceManager) {
            this.scheduleSaveApiMessages();
        }
    }

    /**
     * 根据ID获取 API 消息
     */
    getApiMessageById(id: string): ApiMessage | undefined {
        return this.apiMessages.find(msg => msg.id === id);
    }

    /**
     * 根据ID删除 API 消息
     */
    removeApiMessageById(messageId: string): boolean {
        const index = this.apiMessages.findIndex(m => m.id === messageId);
        if (index >= 0) {
            this.apiMessages.splice(index, 1);

            // 触发防抖持久化（自动优化，内置开启）
            if (this.persistenceManager) {
                this.scheduleSaveApiMessages();
            }
            return true;
        }
        return false;
    }
    /**
  * 获取所有 API 消息
  */
    getApiMessages(): ApiMessage[] {
        return [...this.apiMessages];
    }


    /**
     * 调度保存 API 消息 - 防抖逻辑（自动优化，内置开启）
     */
    private scheduleSaveApiMessages(): void {
        // 标记有待保存的变更
        this.hasPendingApiChanges = true;

        // 记录首次待保存时间（用于 MAX_WAIT_MS）
        if (!this.firstPendingApiSaveTime) {
            this.firstPendingApiSaveTime = Date.now();
        }

        // 清除之前的定时器
        if (this.apiSaveTimer) {
            clearTimeout(this.apiSaveTimer);
        }

        // 检查是否达到最大等待时间
        const now = Date.now();
        const waitedTime = now - (this.firstPendingApiSaveTime || now);

        if (waitedTime >= this.MAX_WAIT_MS) {
            // 达到最大等待时间，立即保存
            this.performSaveApiMessages();
        } else {
            // 设置新的防抖定时器
            const delay = Math.min(this.DEBOUNCE_MS, this.MAX_WAIT_MS - waitedTime);
            this.apiSaveTimer = setTimeout(() => {
                this.performSaveApiMessages();
            }, delay);
        }
    }

    /**
     * 执行保存 API 消息 - 真正的 IO 操作
     * 使用 Promise 队列机制，与 saveApiMessagesNow() 共享队列，避免并发冲突
     */
    private performSaveApiMessages(): void {
        // 避免重复保存
        if (this.isSavingApi || !this.hasPendingApiChanges) {
            return;
        }

        const startTime = Date.now();
        const messageCount = this.apiMessages.length;
        this.isSavingApi = true;

        // 捕获当前消息快照（避免保存过程中消息被修改）
        const messagesSnapshot = [...this.apiMessages];
        this.logger.debug("MessageManager_performSaveApiMessages_start", {
            taskId: this.taskId,
            messageCount
        });

        // 将保存操作加入 Promise 队列，与 saveApiMessagesNow() 共享，确保串行执行
        this.saveApiQueue = this.saveApiQueue.then(async () => {
            // 检查是否还有待保存的变更（可能已被 saveApiMessagesNow() 处理）
            // 如果 hasPendingApiChanges 已经被清除（被 saveApiMessagesNow() 处理），则跳过保存
            // 因为 saveApiMessagesNow() 已经保存了最新的状态
            if (!this.hasPendingApiChanges) {
                this.logger.debug("MessageManager_performSaveApiMessages_skipAlreadySaved", {
                    taskId: this.taskId
                });
                return;
            }

            // 清除待保存标志
            this.hasPendingApiChanges = false;
            this.firstPendingApiSaveTime = undefined;

            try {
                await this.saveApiMessagesInternal(messagesSnapshot);
                const duration = Date.now() - startTime;
                this.logger.debug("MessageManager_performSaveApiMessages_success", {
                    taskId: this.taskId,
                    messageCount,
                    duration
                });
            } catch (error) {
                const duration = Date.now() - startTime;
                // 保存失败处理（记录日志）
                this.logger.error("MessageManager_performSaveApiMessages_error", {
                    taskId: this.taskId,
                    messageCount,
                    duration,
                    error
                });
                // 标记为有待保存的变更，下次会重试
                this.hasPendingApiChanges = true;
                throw error;
            }
        }).catch(error => {
            // 队列中的错误已经在内部处理，这里只记录日志
            const duration = Date.now() - startTime;
            this.logger.error("MessageManager_performSaveApiMessages_queueError", {
                taskId: this.taskId,
                messageCount,
                duration,
                error
            });
        }).finally(() => {
            this.isSavingApi = false;

            // 如果在保存期间又有新的变更，继续调度
            if (this.hasPendingApiChanges) {
                this.scheduleSaveApiMessages();
            }
        });
    }

    /**
     * 内部保存方法 - 真正的异步 IO
     */
    private async saveApiMessagesInternal(messages: ApiMessage[]): Promise<void> {
        if (!this.persistenceManager) {
            return;
        }

        try {
            await this.persistenceManager.saveApiMessages(this.taskId, messages);
        } catch (error) {
            throw new AgentSDKError(
                `Failed to save API messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }


    /**
     * 手动保存 API 消息（立即执行，不防抖）
     * 用于关键时刻：任务完成、中止等
     * 
     * 注意：总是保存当前的消息状态，不依赖 hasPendingApiChanges
     * 这是关键时刻，必须确保保存最新状态，避免消息丢失
     * 使用 Promise 队列机制确保保存操作的串行化，避免并发冲突
     */
    async saveApiMessagesNow(): Promise<void> {
        const startTime = Date.now();
        const messageCount = this.apiMessages.length;
        this.logger.debug("MessageManager_saveApiMessagesNow_start", {
            taskId: this.taskId,
            messageCount
        });

        // 取消待定的定时器
        if (this.apiSaveTimer) {
            clearTimeout(this.apiSaveTimer);
            this.apiSaveTimer = undefined;
            this.logger.debug("MessageManager_saveApiMessagesNow_cancelledTimer", {
                taskId: this.taskId
            });
        }

        // 将保存操作加入队列，等待之前的操作完成
        // 使用 Promise 队列机制，自动排队，无需轮询等待
        this.saveApiQueue = this.saveApiQueue.then(async () => {
            // 总是保存当前的消息状态（不依赖 hasPendingApiChanges）
            // 这是关键时刻，必须确保保存最新状态
            try {
                await this.saveApiMessagesInternal([...this.apiMessages]);
                this.hasPendingApiChanges = false;
                this.firstPendingApiSaveTime = undefined;
                const duration = Date.now() - startTime;
                this.logger.debug("MessageManager_saveApiMessagesNow_success", {
                    taskId: this.taskId,
                    messageCount,
                    duration
                });
            } catch (error) {
                const duration = Date.now() - startTime;
                this.logger.error("MessageManager_saveApiMessagesNow_error", {
                    taskId: this.taskId,
                    messageCount,
                    duration,
                    error
                });
                throw error;
            }
        }).catch(error => {
            // 如果队列中的某个操作失败，记录错误但不阻塞后续操作
            const duration = Date.now() - startTime;
            this.logger.error("MessageManager_saveApiMessagesNow_queueError", {
                taskId: this.taskId,
                messageCount,
                duration,
                error
            });
            throw error;
        });
        try {
            const loadedMessages = await this.persistenceManager.loadApiMessages(this.taskId);
            this.apiMessages = loadedMessages;
        } catch (error) {
            throw new AgentSDKError(
                `Failed to load API messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }

    /**
     * 删除 API 消息
     */
    async deleteApiMessages(): Promise<void> {
        if (!this.persistenceManager) {
            this.apiMessages = [];
            return;
        }

        try {
            await this.persistenceManager.deleteApiMessages(this.taskId);
            this.apiMessages = [];
        } catch (error) {
            throw new AgentSDKError(
                `Failed to delete API messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }

    // ============= 用户消息管理 =============

    /**
     * 添加用户消息
     */
    addUserMessage(message: UserMessage): void {
        // 验证消息
        if (!message.id || !message.taskId || !message.type || !message.role) {
            throw new AgentSDKError(
                'Invalid user message: id, taskId, type, and role are required',
                'INVALID_MESSAGE'
            );
        }

        // 检查 ID 唯一性
        if (this.userMessages.find(m => m.id === message.id)) {
            throw new AgentSDKError(
                `User message with id ${message.id} already exists`,
                'DUPLICATE_MESSAGE_ID'
            );
        }

        // 确保 taskId 一致
        if (message.taskId !== this.taskId) {
            message.taskId = this.taskId;
        }

        // 添加到列表
        this.userMessages.push(message);

        // 检查是否超过最大数量
        if (this.userMessages.length > this.maxMessages) {
            // 保留最新的消息,删除最旧的
            this.userMessages = this.userMessages.slice(-this.maxMessages);
        }

        // 触发防抖持久化（自动优化，内置开启）
        if (this.persistenceManager) {
            this.scheduleSaveUserMessages();
        }
    }

    /**
     * 更新用户消息
     */
    updateUserMessage(id: string, updates: Partial<UserMessage>): void {
        const message = this.userMessages.find(m => m.id === id);
        if (!message) {
            throw new AgentSDKError(
                `User message with id ${id} not found`,
                'MESSAGE_NOT_FOUND'
            );
        }

        Object.assign(message, updates);

        // 触发防抖持久化（自动优化，内置开启）
        if (this.persistenceManager) {
            this.scheduleSaveUserMessages();
        }
    }

    /**
     * 根据ID获取用户消息
     */
    getUserMessageById(id: string): UserMessage | undefined {
        return this.userMessages.find(msg => msg.id === id);
    }

    /**
     * 根据ID删除用户消息
     */
    removeUserMessageById(messageId: string): boolean {
        const index = this.userMessages.findIndex(m => m.id === messageId);
        if (index >= 0) {
            this.userMessages.splice(index, 1);

            // 触发防抖持久化（自动优化，内置开启）
            if (this.persistenceManager) {
                this.scheduleSaveUserMessages();
            }
            return true;
        }
        return false;
    }

    /**
     * 获取所有用户消息
     */
    getUserMessages(): UserMessage[] {
        return [...this.userMessages];
    }

    /**
     * 调度保存用户消息 - 防抖逻辑（自动优化，内置开启）
     */
    private scheduleSaveUserMessages(): void {
        // 标记有待保存的变更
        this.hasPendingUserChanges = true;

        // 记录首次待保存时间（用于 MAX_WAIT_MS）
        if (!this.firstPendingUserSaveTime) {
            this.firstPendingUserSaveTime = Date.now();
        }

        // 清除之前的定时器
        if (this.userSaveTimer) {
            clearTimeout(this.userSaveTimer);
        }

        // 检查是否达到最大等待时间
        const now = Date.now();
        const waitedTime = now - (this.firstPendingUserSaveTime || now);

        if (waitedTime >= this.MAX_WAIT_MS) {
            // 达到最大等待时间，立即保存
            this.performSaveUserMessages();
        } else {
            // 设置新的防抖定时器
            const delay = Math.min(this.DEBOUNCE_MS, this.MAX_WAIT_MS - waitedTime);
            this.userSaveTimer = setTimeout(() => {
                this.performSaveUserMessages();
            }, delay);
        }
    }

    /**
     * 执行保存用户消息 - 真正的 IO 操作
     * 使用 Promise 队列机制，与 saveUserMessagesNow() 共享队列，避免并发冲突
     */
    private performSaveUserMessages(): void {
        // 避免重复保存
        if (this.isSavingUser || !this.hasPendingUserChanges) {
            return;
        }

        const startTime = Date.now();
        const messageCount = this.userMessages.length;
        this.isSavingUser = true;

        // 捕获当前消息快照（避免保存过程中消息被修改）
        const messagesSnapshot = [...this.userMessages];
        this.logger.debug("MessageManager_performSaveUserMessages_start", {
            taskId: this.taskId,
            messageCount
        });

        // 将保存操作加入 Promise 队列，与 saveUserMessagesNow() 共享，确保串行执行
        this.saveUserQueue = this.saveUserQueue.then(async () => {
            // 检查是否还有待保存的变更（可能已被 saveUserMessagesNow() 处理）
            // 如果 hasPendingUserChanges 已经被清除（被 saveUserMessagesNow() 处理），则跳过保存
            // 因为 saveUserMessagesNow() 已经保存了最新的状态
            if (!this.hasPendingUserChanges) {
                this.logger.debug("MessageManager_performSaveUserMessages_skipAlreadySaved", {
                    taskId: this.taskId
                });
                return;
            }
            // 清除待保存标志
            this.hasPendingUserChanges = false;
            this.firstPendingUserSaveTime = undefined;

            try {
                await this.saveUserMessagesInternal(messagesSnapshot);
                const duration = Date.now() - startTime;
                this.logger.debug("MessageManager_performSaveUserMessages_success", {
                    taskId: this.taskId,
                    messageCount,
                    duration
                });
            } catch (error) {
                const duration = Date.now() - startTime;
                // 保存失败处理（记录日志）
                this.logger.error("MessageManager_performSaveUserMessages_error", {
                    taskId: this.taskId,
                    messageCount,
                    duration,
                    error
                });
                // 标记为有待保存的变更，下次会重试
                this.hasPendingUserChanges = true;
                throw error;
            }
        }).catch(error => {
            // 队列中的错误已经在内部处理，这里只记录日志
            const duration = Date.now() - startTime;
            this.logger.error("MessageManager_performSaveUserMessages_queueError", {
                taskId: this.taskId,
                messageCount,
                duration,
                error
            });
        }).finally(() => {
            this.isSavingUser = false;

            // 如果在保存期间又有新的变更，继续调度
            if (this.hasPendingUserChanges) {
                this.scheduleSaveUserMessages();
            }
        });
    }

    /**
     * 内部保存方法 - 真正的异步 IO
     */
    private async saveUserMessagesInternal(messages: UserMessage[]): Promise<void> {
        if (!this.persistenceManager) {
            return;
        }

        try {
            await this.persistenceManager.saveUserMessages(this.taskId, messages);
        } catch (error) {
            throw new AgentSDKError(
                `Failed to save user messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }


    /**
     * 手动保存用户消息（立即执行，不防抖）
     * 用于关键时刻：任务完成、中止等
     * 使用 Promise 队列机制确保保存操作的串行化，避免并发冲突
     */
    async saveUserMessagesNow(): Promise<void> {
        // 取消待定的定时器
        if (this.userSaveTimer) {
            clearTimeout(this.userSaveTimer);
            this.userSaveTimer = undefined;
        }

        // 将保存操作加入队列，等待之前的操作完成
        // 使用 Promise 队列机制，自动排队，无需轮询等待
        this.saveUserQueue = this.saveUserQueue.then(async () => {
            // 总是保存当前的消息状态（不依赖 hasPendingUserChanges）
            // 这是关键时刻，必须确保保存最新状态
            try {
                await this.saveUserMessagesInternal([...this.userMessages]);
                this.hasPendingUserChanges = false;
                this.firstPendingUserSaveTime = undefined;
            } catch (error) {
                this.logger.error("MessageManager_saveUserMessagesNow_error", {
                    taskId: this.taskId,
                    error
                });
                throw error;
            }
        }).catch(error => {
            // 如果队列中的某个操作失败，记录错误但不阻塞后续操作
            this.logger.error("MessageManager_saveUserMessagesNow_queueError", {
                taskId: this.taskId,
                error
            });
            throw error;
        });

        return this.saveUserQueue;
    }

    /**
     * 从持久化存储加载用户消息
     */
    async loadUserMessages(): Promise<void> {
        if (!this.persistenceManager) {
            return;
        }

        try {
            const loadedMessages = await this.persistenceManager.loadUserMessages(this.taskId);
            this.userMessages = loadedMessages;
        } catch (error) {
            throw new AgentSDKError(
                `Failed to load user messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }

    /**
     * 删除用户消息
     */
    async deleteUserMessages(): Promise<void> {
        if (!this.persistenceManager) {
            this.userMessages = [];
            return;
        }

        try {
            await this.persistenceManager.deleteUserMessages(this.taskId);
            this.userMessages = [];
        } catch (error) {
            throw new AgentSDKError(
                `Failed to delete user messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.taskId, error }
            );
        }
    }

    // ============= 资源清理 =============

    /**
     * 析构时清理
     */
    destroy(): void {
        if (this.apiSaveTimer) {
            clearTimeout(this.apiSaveTimer);
        }
        if (this.userSaveTimer) {
            clearTimeout(this.userSaveTimer);
        }
    }

    /**
     * 立即保存所有消息（关键时刻使用）
     */
    async saveAllMessagesNow(): Promise<void> {
        await Promise.all([
            this.saveApiMessagesNow(),
            this.saveUserMessagesNow(),
        ]);
    }

    /**
     * 从持久化存储加载所有消息
     */
    async loadAllMessages(): Promise<void> {
        await Promise.all([
            this.loadApiMessages(),
            this.loadUserMessages(),
        ]);
    }

}

/**
 * 创建消息管理器
 */
export function createMessageManager(config: MessageManagerConfig): MessageManager {
    return new MessageManager(config);
}