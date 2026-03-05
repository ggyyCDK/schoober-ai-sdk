/**
 * 回调管理器接口和实现
 * 负责管理任务的回调函数（onMessage, onTaskStateUpdate）
 */

import {
    TaskCallbacks,
    UserMessage,
    TaskState,
    ILogger,
} from '@/types';
import { MessageCoordinator } from './MessageCoordinator';

/**
 * 回调管理器配置
 */
export interface CallbackManagerConfig {
    /** 消息协调器（用于同步回调） */
    messageCoordinator: MessageCoordinator;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
}

/**
 * 回调管理器接口
 */
export interface ICallbackManager {
    getCallbacks(): TaskCallbacks | undefined;
    updateCallbacks(callbacks?: TaskCallbacks): void;
    notifyMessage(message: UserMessage): Promise<void>;
    notifyStateUpdate(state: TaskState): Promise<void>;
}

/**
 * 回调管理器实现
 */
export class CallbackManager implements ICallbackManager {
    private messageCoordinator: MessageCoordinator;
    private logger: ILogger;
    private taskId: string;

    // 回调函数
    private onMessage?: (message: UserMessage) => Promise<void>;
    private onTaskStateUpdate?: (state: TaskState) => Promise<void>;

    constructor(config: CallbackManagerConfig) {
        this.messageCoordinator = config.messageCoordinator;
        this.logger = config.logger;
        this.taskId = config.taskId;
    }

    /**
     * 获取回调函数
     */
    getCallbacks(): TaskCallbacks | undefined {
        return {
            onMessage: this.onMessage,
            onTaskStateUpdate: this.onTaskStateUpdate,
        };
    }

    /**
     * 更新回调函数
     */
    updateCallbacks(callbacks?: TaskCallbacks): void {
        this.onMessage = callbacks?.onMessage;
        this.onTaskStateUpdate = callbacks?.onTaskStateUpdate;

        // 同时更新 MessageCoordinator 的 onMessageSend
        // 注意：这里需要通过反射或公开方法更新 MessageCoordinator
        // 由于 MessageCoordinator 的 onMessageSend 是 private，我们需要通过配置或公开方法更新
        // 暂时通过类型断言访问（后续可以考虑重构 MessageCoordinator 提供更新方法）
        (this.messageCoordinator as any).onMessageSend = this.onMessage;

        this.logger.debug("CallbackManager_updateCallbacks_success", {
            taskId: this.taskId
        });
    }

    /**
     * 通知消息回调
     */
    async notifyMessage(message: UserMessage): Promise<void> {
        if (this.onMessage) {
            try {
                await this.onMessage(message);
            } catch (error) {
                this.logger.error("CallbackManager_notifyMessage_callbackError", {
                    taskId: this.taskId,
                    error
                });
            }
        }
    }

    /**
     * 通知状态更新回调
     */
    async notifyStateUpdate(state: TaskState): Promise<void> {
        if (this.onTaskStateUpdate) {
            try {
                await this.onTaskStateUpdate(state);
            } catch (error) {
                this.logger.error("CallbackManager_notifyStateUpdate_callbackError", {
                    taskId: this.taskId,
                    error
                });
            }
        }
    }
}

/**
 * 创建回调管理器
 */
export function createCallbackManager(config: CallbackManagerConfig): CallbackManager {
    return new CallbackManager(config);
}