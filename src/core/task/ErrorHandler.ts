/**
 * 错误处理器接口和实现
 * 负责处理任务执行过程中的错误和重试逻辑
 */

import {
    ErrorCode,
    AgentSDKError,
    TaskStatus,
    TaskResult,
    ILogger,
} from '@/types';
import { StateManager } from './StateManager';
import { MessageCoordinator } from './MessageCoordinator';
import { ErrorTracker } from './ErrorTracker';

/**
 * 错误处理器配置
 */
export interface ErrorHandlerConfig {
    /** 状态管理器 */
    stateManager: StateManager;
    /** 消息协调器 */
    messageCoordinator: MessageCoordinator;
    /** 错误追踪器 */
    errorTracker: ErrorTracker;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
    /** 最大重试次数 */
    maxRetries?: number;
    /** 执行任务的回调 */
    executeTask: () => Promise<void>;
    /** 完成 Promise 的 resolve/reject 函数 */
    completionHandlers: {
        resolve?: (result: TaskResult) => void;
        reject?: (error: Error) => void;
    };
}

/**
 * 错误处理器接口
 */
export interface IErrorHandler {
    handleError(error: Error): Promise<void>;
    handleExecutionError(error: Error): Promise<void>;
}

/**
 * 错误处理器实现
 */
export class ErrorHandler implements IErrorHandler {
    private stateManager: StateManager;
    private messageCoordinator: MessageCoordinator;
    private errorTracker: ErrorTracker;
    private logger: ILogger;
    private taskId: string;
    private maxRetries: number;
    private executeTask: () => Promise<void>;
    private completionHandlers: {
        resolve?: (result: TaskResult) => void;
        reject?: (error: Error) => void;
    };

    constructor(config: ErrorHandlerConfig) {
        this.stateManager = config.stateManager;
        this.messageCoordinator = config.messageCoordinator;
        this.errorTracker = config.errorTracker;
        this.logger = config.logger;
        this.taskId = config.taskId;
        this.maxRetries = config.maxRetries ?? 3;
        this.executeTask = config.executeTask;
        this.completionHandlers = config.completionHandlers;
    }

    /**
     * 处理错误
     */
    async handleError(error: Error): Promise<void> {
        const errorCode = error instanceof AgentSDKError ? error.code : undefined;
        const duration = this.stateManager.calculateDuration();
        const taskState = this.stateManager.getState();
        const currentStatus = taskState.status;
        const retryCount = this.stateManager.getRetryCount();

        this.logger.error("ErrorHandler_handleError_taskFailed", {
            taskId: this.taskId,
            errorCode: errorCode || 'UNKNOWN',
            duration,
            status: currentStatus.getValue(),
            retryCount,
            error
        });

        // 使用值对象的状态转换验证（失败状态可以从任何非最终状态转换）
        const targetStatus = TaskStatus.FAILED;
        if (!currentStatus.canTransitionTo(targetStatus) && !currentStatus.isFinal()) {
            this.logger.warn("ErrorHandler_handleError_statusTransitionWarning", {
                taskId: this.taskId,
                currentStatus: currentStatus.getValue()
            });
        }

        // 设置结束时间、状态和错误
        const endTime = new Date();
        this.stateManager.setEndTime(endTime);
        this.stateManager.setError(error);
        this.stateManager.updateState({
            status: currentStatus.canTransitionTo(targetStatus)
                ? currentStatus.transitionTo(targetStatus)
                : targetStatus,
        });

        // 透出错误给用户
        await this.messageCoordinator.sendErrorMessage(error, {
            errorType: 'execution',
            errorCode,
            source: 'ErrorHandler',
            retryCount,
        });

        const result: TaskResult = {
            status: 'error',
            error,
            duration,
        };

        // 发送状态更新（通过 StateManager 的回调机制）
        // 注意：这里需要确保状态更新回调被触发

        // 完成Promise
        if (this.completionHandlers.reject) {
            this.completionHandlers.reject(error);
        }

        // 关键时刻：立即保存最终状态和所有消息
        await this.stateManager.saveStateNow();
        await this.messageCoordinator.saveAllMessagesNow();

        this.logger.info("ErrorHandler_handleError_completed", {
            taskId: this.taskId,
            duration
        });
    }

    /**
     * 处理执行错误(带重试)
     */
    async handleExecutionError(error: Error): Promise<void> {
        const currentRetryCount = this.stateManager.getRetryCount();
        const errorCode = error instanceof AgentSDKError ? error.code : undefined;

        if (currentRetryCount < this.maxRetries) {
            const nextRetryCount = currentRetryCount + 1;
            const delay = 1000 * nextRetryCount; // 每次递增延迟

            this.logger.warn("ErrorHandler_handleExecutionError_retrying", {
                taskId: this.taskId,
                attempt: nextRetryCount,
                maxRetries: this.maxRetries,
                errorCode: errorCode || 'UNKNOWN',
                delay,
                message: error.message
            });

            // 透出重试错误给用户
            await this.messageCoordinator.sendErrorMessage(error, {
                errorType: 'execution',
                errorCode,
                source: 'ErrorHandler',
                retryCount: nextRetryCount,
                additionalInfo: {
                    maxRetries: this.maxRetries,
                    willRetry: true,
                    retryDelay: delay,
                },
            });

            // 增加重试次数
            this.stateManager.incrementRetryCount();

            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, delay));

            this.logger.info("ErrorHandler_handleExecutionError_retryStarted", {
                taskId: this.taskId,
                attempt: nextRetryCount,
                maxRetries: this.maxRetries
            });
            // 重试
            await this.executeTask();
        } else {
            this.logger.error("ErrorHandler_handleExecutionError_maxRetriesExceeded", {
                taskId: this.taskId,
                maxRetries: this.maxRetries,
                errorCode: errorCode || 'UNKNOWN'
            });
            // 超过最大重试次数,任务失败
            await this.handleError(error);
        }
    }
}

/**
 * 创建错误处理器
 */
export function createErrorHandler(config: ErrorHandlerConfig): ErrorHandler {
    return new ErrorHandler(config);
}