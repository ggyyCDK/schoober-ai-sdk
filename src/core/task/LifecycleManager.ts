/**
 * 生命周期管理器接口和实现
 * 负责管理任务生命周期（start, pause, resume, abort, complete）
 * 以及完成 Promise 的管理
 */

import {
    TaskInput,
    TaskResult,
    TaskStatus,
    TaskState,
    AgentSDKError,
    ILogger,
} from '@/types';
import { StateManager } from './StateManager';
import { MessageCoordinator } from './MessageCoordinator';
import { ReActEngine } from './ReActEngine';
import { ExecutionManager } from './ExecutionManager';

/**
 * 生命周期管理器配置
 */
export interface LifecycleManagerConfig {
    /** 状态管理器 */
    stateManager: StateManager;
    /** 消息协调器 */
    messageCoordinator: MessageCoordinator;
    /** ReAct 引擎 */
    reactEngine: ReActEngine;
    /** 执行管理器 */
    executionManager: ExecutionManager;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
    /** 最大重试次数 */
    maxRetries?: number;
    /** 添加用户输入消息的回调 */
    addUserInputMessage: (message: string) => Promise<void>;
    /** 执行任务的回调 */
    executeTask: () => Promise<void>;
    /** 完成任务的回调 */
    onComplete?: (completionData?: any) => Promise<void>;
    /** 处理错误的回调 */
    onError?: (error: Error) => Promise<void>;
    /** 更新状态的回调 */
    onStateUpdate?: (state: TaskState) => Promise<void>;
}

/**
 * 生命周期管理器接口
 */
export interface ILifecycleManager {
    /**
     * 启动任务或继续对话
     * - PENDING: 首次启动，必须传入 input
     * - PAUSED: 恢复执行，input 可选（无则仅恢复，有则恢复并继续对话）
     * - RUNNING: 继续对话，必须传入 input
     * - COMPLETED/FAILED/ABORTED: 重新激活，必须传入 input
     */
    start(input?: TaskInput): Promise<void>;
    pause(): Promise<void>;
    abort(): void;
    complete(completionData?: any): Promise<void>;
    wait(): Promise<TaskResult>;
    setupCompletionPromise(): void;
}

/**
 * 生命周期管理器实现
 */
export class LifecycleManager implements ILifecycleManager {
    private stateManager: StateManager;
    private messageCoordinator: MessageCoordinator;
    private reactEngine: ReActEngine;
    private executionManager: ExecutionManager;
    private logger: ILogger;
    private taskId: string;
    private maxRetries: number;

    // 完成 Promise 管理
    private completionPromise?: Promise<TaskResult>;
    private completionResolve?: (result: TaskResult) => void;
    private completionReject?: (error: Error) => void;

    // 回调函数
    private addUserInputMessage: (message: string) => Promise<void>;
    private executeTask: () => Promise<void>;
    private onComplete?: (completionData?: any) => Promise<void>;
    private onError?: (error: Error) => Promise<void>;
    private onStateUpdate?: (state: TaskState) => Promise<void>;

    constructor(config: LifecycleManagerConfig) {
        this.stateManager = config.stateManager;
        this.messageCoordinator = config.messageCoordinator;
        this.reactEngine = config.reactEngine;
        this.executionManager = config.executionManager;
        this.logger = config.logger;
        this.taskId = config.taskId;
        this.maxRetries = config.maxRetries ?? 3;
        this.addUserInputMessage = config.addUserInputMessage;
        this.executeTask = config.executeTask;
        this.onComplete = config.onComplete;
        this.onError = config.onError;
        this.onStateUpdate = config.onStateUpdate;

        this.setupCompletionPromise();
    }

    /**
     * 设置完成Promise
     */
    setupCompletionPromise(): void {
        this.completionPromise = new Promise<TaskResult>((resolve, reject) => {
            this.completionResolve = resolve;
            this.completionReject = reject;
        });
    }

    /**
     * 启动任务或继续对话
     * - PENDING: 首次启动，必须传入 input
     * - PAUSED: 恢复执行，input 可选（无则仅恢复，有则恢复并继续对话）
     * - RUNNING: 继续对话，必须传入 input
     * - COMPLETED/FAILED/ABORTED: 重新激活，必须传入 input
     */
    async start(input?: TaskInput): Promise<void> {
        const currentStatus = this.stateManager.getState().status;

        // 场景1: 首次启动任务 (PENDING) - 必须有 input
        if (currentStatus.equals(TaskStatus.PENDING)) {
            await this.startNewTask(input);
            return;
        }

        // 场景2: 任务暂停 (PAUSED) - input 可选
        if (currentStatus.equals(TaskStatus.PAUSED)) {
            await this.resumeOrContinue(input);
            return;
        }

        // 场景3: 任务运行中 (RUNNING) - 继续对话，必须有 input
        if (currentStatus.equals(TaskStatus.RUNNING)) {
            await this.continueConversation(input);
            return;
        }

        // 场景4: 任务已结束 - 重新激活，必须有 input
        if (currentStatus.isFinal()) {
            await this.reactivateTask(input);
            return;
        }

        throw new AgentSDKError(
            'INVALID_STATE',
            `Unexpected task status: ${currentStatus.getValue()}`
        );
    }

    /**
     * 首次启动任务
     */
    private async startNewTask(input?: TaskInput): Promise<void> {
        const startTime = Date.now();
        this.logger.info("LifecycleManager_startNewTask_start", {
            taskId: this.taskId
        });

        if (!input) {
            this.logger.error("LifecycleManager_startNewTask_noInput", {
                taskId: this.taskId
            });
            throw new AgentSDKError(
                'VALIDATION_ERROR',
                'Task input is required. Either provide it when calling start() or set it in TaskConfig.input when creating the task.'
            );
        }

        const inputLength = input.message.length;
        this.logger.debug("LifecycleManager_startNewTask_inputReceived", {
            taskId: this.taskId,
            inputLength,
            preview: input.message.substring(0, 100)
        });

        // 设置开始时间和状态
        const taskStartTime = new Date();
        this.stateManager.setStartTime(taskStartTime);
        this.stateManager.updateState({ status: TaskStatus.RUNNING });
        this.logger.info("LifecycleManager_startNewTask_statusChanged", {
            taskId: this.taskId
        });

        // 发送状态更新
        if (this.onStateUpdate) {
            await this.onStateUpdate(this.stateManager.getState());
        }

        // 添加用户输入消息
        await this.addUserInputMessage(input.message);

        const initializationDuration = Date.now() - startTime;
        this.logger.info("LifecycleManager_startNewTask_initializationCompleted", {
            taskId: this.taskId,
            duration: initializationDuration
        });

        // 开始执行任务
        await this.executeTask();
    }

    /**
     * 重新激活已结束的任务
     */
    private async reactivateTask(input?: TaskInput): Promise<void> {
        this.logger.info("LifecycleManager_reactivateTask_start", {
            taskId: this.taskId
        });

        if (!input) {
            this.logger.error("LifecycleManager_reactivateTask_noInput", {
                taskId: this.taskId
            });
            throw new AgentSDKError(
                'VALIDATION_ERROR',
                'Task input is required to reactivate a completed/failed/aborted task.'
            );
        }

        // 重新设置完成 Promise
        this.setupCompletionPromise();

        // 重置状态（清除结束时间和错误信息）
        this.stateManager.updateState({
            status: TaskStatus.RUNNING,
            endTime: undefined,
            error: undefined,
        });

        // 发送状态更新
        if (this.onStateUpdate) {
            await this.onStateUpdate(this.stateManager.getState());
        }

        // 添加用户输入消息
        await this.addUserInputMessage(input.message);

        // 重新开始执行任务
        await this.executeTask();
    }

    /**
     * 恢复暂停的任务，或在恢复后继续对话
     * input 可选：无消息则仅恢复，有消息则恢复并继续对话
     */
    private async resumeOrContinue(input?: TaskInput): Promise<void> {
        this.logger.info("LifecycleManager_resumeOrContinue_start", {
            taskId: this.taskId,
            hasInput: !!input
        });

        // 更新状态为 RUNNING
        this.stateManager.updateState({ status: TaskStatus.RUNNING });

        // 发送状态更新
        if (this.onStateUpdate) {
            await this.onStateUpdate(this.stateManager.getState());
        }

        // 如果有消息，添加用户输入
        if (input?.message) {
            await this.addUserInputMessage(input.message);
        }

        // 继续执行任务
        if (!this.reactEngine.isExecuting()) {
            await this.executeTask();
        }
    }

    /**
     * 继续对话（任务运行中）
     */
    private async continueConversation(input?: TaskInput): Promise<void> {
        this.logger.info("LifecycleManager_continueConversation_start", {
            taskId: this.taskId
        });

        if (!input) {
            this.logger.error("LifecycleManager_continueConversation_noInput", {
                taskId: this.taskId
            });
            throw new AgentSDKError(
                'VALIDATION_ERROR',
                'Task input is required to continue conversation.'
            );
        }

        // 添加用户输入消息
        await this.addUserInputMessage(input.message);

        // 如果任务未在执行，继续执行
        if (!this.reactEngine.isExecuting()) {
            await this.executeTask();
        }
    }

    /**
     * 暂停任务
     */
    async pause(needRollback = false): Promise<void> {
        const currentStatus = this.stateManager.getState().status;

        if (!currentStatus.canTransitionTo(TaskStatus.PAUSED)) {
            throw new AgentSDKError(
                'INVALID_STATE',
                `Cannot pause task in status: ${currentStatus.getValue()}. ` +
                `Allowed transitions: ${currentStatus.getAllowedTransitions().map(s => s.getValue()).join(', ')}`
            );
        }

        this.logger.info("LifecycleManager_pause_start", {
            taskId: this.taskId,
            currentStatus: currentStatus.getValue()
        });

        if (needRollback) {
            await this.messageCoordinator.sendPauseNotification();
        }
        // 1. 更新状态为 PAUSED
        this.stateManager.updateState({ status: currentStatus.transitionTo(TaskStatus.PAUSED) });

        // 2. 中止 ReAct 循环和 LLM 请求
        this.reactEngine.abort();

        if (needRollback) {
            // 3. 回滚本轮 API 消息（避免不完整的对话历史影响后续推理）
            this.messageCoordinator.rollbackCurrentRoundApiMessages();
        }

        // 5. 关键时刻：立即保存状态和消息
        try {
            await this.stateManager.saveStateNow();
            await this.messageCoordinator.saveAllMessagesNow();
            this.logger.debug("LifecycleManager_pause_saveSuccess", {
                taskId: this.taskId
            });
        } catch (error) {
            this.logger.error("LifecycleManager_pause_saveFailed", {
                taskId: this.taskId,
                error
            });
            // 保存失败不影响暂停操作，继续执行
        }
        // 6. 发送状态更新通知（异步执行，不阻塞）
        if (this.onStateUpdate) {
            Promise.resolve(this.onStateUpdate(this.stateManager.getState())).catch(error => {
                this.logger.error("LifecycleManager_pause_onStateUpdateError", {
                    taskId: this.taskId,
                    error
                });
            });
        }
    }

    /**
     * 中止任务
     */
    abort(): void {
        const currentStatus = this.stateManager.getState().status;

        // 如果已经是最终状态，直接返回
        if (currentStatus.isFinal()) {
            this.logger.debug("LifecycleManager_abort_alreadyFinal", {
                taskId: this.taskId,
                status: currentStatus.getValue()
            });
            return;
        }

        if (!currentStatus.canTransitionTo(TaskStatus.ABORTED)) {
            throw new AgentSDKError(
                'INVALID_STATE',
                `Cannot abort task in status: ${currentStatus.getValue()}. ` +
                `Allowed transitions: ${currentStatus.getAllowedTransitions().map(s => s.getValue()).join(', ')}`
            );
        }

        const duration = this.stateManager.calculateDuration();
        this.logger.info("LifecycleManager_abort_start", {
            taskId: this.taskId,
            currentStatus: currentStatus.getValue(),
            duration
        });

        // 设置结束时间和状态
        const endTime = new Date();
        this.stateManager.setEndTime(endTime);
        this.stateManager.updateState({ status: currentStatus.transitionTo(TaskStatus.ABORTED) });
        this.logger.info("LifecycleManager_abort_statusChanged", {
            taskId: this.taskId,
            oldStatus: currentStatus.getValue()
        });

        // 中止 ReAct 循环和 LLM 请求
        this.reactEngine.abort();
        this.executionManager.abort();

        // 发送状态更新（异步执行，不阻塞）
        if (this.onStateUpdate) {
            Promise.resolve(this.onStateUpdate(this.stateManager.getState())).catch(error => {
                this.logger.error("LifecycleManager_pause_onStateUpdateError", {
                    taskId: this.taskId,
                    error
                });
            });
        }

        // 完成Promise
        if (this.completionResolve) {
            this.completionResolve({
                status: 'error',
                error: new Error('Task aborted'),
                duration,
            });
        }

        // 关键时刻：立即保存状态和所有消息（异步执行，不阻塞）
        this.stateManager.saveStateNow().catch(error => {
            this.logger.error("LifecycleManager_abort_saveStateFailed", {
                taskId: this.taskId,
                error
            });
        });
        this.messageCoordinator.saveAllMessagesNow().catch(error => {
            this.logger.error("LifecycleManager_abort_saveMessagesFailed", {
                taskId: this.taskId,
                error
            });
        });
    }

    /**
     * 完成任务
     */
    async complete(completionData?: any): Promise<void> {
        const duration = this.stateManager.calculateDuration();
        const taskState = this.stateManager.getState();
        const currentStatus = taskState.status;

        if (!currentStatus.canTransitionTo(TaskStatus.COMPLETED)) {
            this.logger.warn("LifecycleManager_complete_statusTransitionWarning", {
                taskId: this.taskId,
                currentStatus: currentStatus.getValue()
            });
        }

        this.logger.info("LifecycleManager_complete_success", {
            taskId: this.taskId,
            duration,
            currentStatus: currentStatus.getValue()
        });

        // 保存任务总结到 context
        if (completionData?.result) {
            this.stateManager.setTaskSummary(completionData.result);
        }

        // 设置结束时间和状态
        const endTime = new Date();
        this.stateManager.setEndTime(endTime);
        this.stateManager.updateState({
            status: currentStatus.canTransitionTo(TaskStatus.COMPLETED)
                ? currentStatus.transitionTo(TaskStatus.COMPLETED)
                : TaskStatus.COMPLETED,
        });
        this.logger.info("LifecycleManager_complete_statusChanged", {
            taskId: this.taskId,
            oldStatus: currentStatus.getValue()
        });

        // 中止 ReAct 循环和 LLM 请求
        this.reactEngine.abort();

        const result: TaskResult = {
            status: 'success',
            duration,
            data: completionData,
        };

        // 完成Promise
        if (this.completionResolve) {
            this.completionResolve(result);
        }

        // 调用完成回调
        if (this.onComplete) {
            await this.onComplete(completionData);
        }

        // 关键时刻：立即保存最终状态和所有消息
        try {
            await this.stateManager.saveStateNow();
            await this.messageCoordinator.saveAllMessagesNow();
            this.logger.debug("LifecycleManager_complete_saveSuccess", {
                taskId: this.taskId
            });
        } catch (error) {
            this.logger.error("LifecycleManager_complete_saveFailed", {
                taskId: this.taskId,
                error
            });
        }
    }

    /**
     * 等待任务完成
     */
    async wait(): Promise<TaskResult> {
        if (!this.completionPromise) {
            throw new AgentSDKError(
                'INVALID_STATE',
                'Task has not been started'
            );
        }
        return this.completionPromise;
    }

    /**
     * 获取完成 Promise 的 resolve/reject 函数（供错误处理器使用）
     */
    getCompletionHandlers(): {
        resolve?: (result: TaskResult) => void;
        reject?: (error: Error) => void;
    } {
        return {
            resolve: this.completionResolve,
            reject: this.completionReject,
        };
    }
}

/**
 * 创建生命周期管理器
 */
export function createLifecycleManager(config: LifecycleManagerConfig): LifecycleManager {
    return new LifecycleManager(config);
}