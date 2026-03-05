/**
 * 任务状态恢复管理器接口和实现
 * 负责处理任务状态恢复和消息恢复
 */

import {
    TaskState,
    TaskStatus,
    ILogger,
} from '@/types';
import { StateManager } from './StateManager';
import { MessageCoordinator } from './MessageCoordinator';

/**
 * 任务状态恢复管理器配置
 */
export interface TaskRestoreManagerConfig {
    /** 状态管理器 */
    stateManager: StateManager;
    /** 消息协调器 */
    messageCoordinator: MessageCoordinator;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
    /** 设置完成 Promise 的回调 */
    setupCompletionPromise: () => void;
}

/**
 * 任务状态恢复管理器接口
 */
export interface ITaskRestoreManager {
    restoreFromState(state: TaskState): Promise<void>;
    restoreMessages(): Promise<void>;
    restoreCompletionPromise(): void;
}

/**
 * 任务状态恢复管理器实现
 */
export class TaskRestoreManager implements ITaskRestoreManager {
    private stateManager: StateManager;
    private messageCoordinator: MessageCoordinator;
    private logger: ILogger;
    private taskId: string;
    private setupCompletionPromise: () => void;

    constructor(config: TaskRestoreManagerConfig) {
        this.stateManager = config.stateManager;
        this.messageCoordinator = config.messageCoordinator;
        this.logger = config.logger;
        this.taskId = config.taskId;
        this.setupCompletionPromise = config.setupCompletionPromise;
    }

    /**
     * 从持久化层恢复任务状态
     */
    async restoreFromState(state: TaskState): Promise<void> {
        // 安全地获取状态值（处理字符串和 TaskStatus 对象两种情况）
        const statusValue = state.status instanceof TaskStatus
            ? state.status.getValue()
            : (typeof state.status === 'string' ? state.status : String(state.status));

        this.logger.info("TaskRestoreManager_restoreFromState_start", {
            taskId: this.taskId,
            status: statusValue
        });

        // 委托给 StateManager 恢复状态（处理日期转换等）
        this.stateManager.restoreState(state);

        // 恢复消息历史
        await this.restoreMessages();

        // 如果任务正在运行，需要重新设置完成 Promise
        if (this.stateManager.getState().status.equals(TaskStatus.RUNNING)) {
            this.restoreCompletionPromise();
        }

        this.logger.info("TaskRestoreManager_restoreFromState_success", {
            taskId: this.taskId
        });
    }

    /**
     * 恢复消息历史
     */
    async restoreMessages(): Promise<void> {
        await this.messageCoordinator.loadAllMessages();
        this.logger.debug("TaskRestoreManager_restoreMessages_success", {
            taskId: this.taskId
        });
    }

    /**
     * 恢复完成 Promise
     */
    restoreCompletionPromise(): void {
        this.setupCompletionPromise();
        this.logger.debug("TaskRestoreManager_restoreCompletionPromise_success", {
            taskId: this.taskId
        });
    }
}

/**
 * 创建任务状态恢复管理器
 */
export function createTaskRestoreManager(config: TaskRestoreManagerConfig): TaskRestoreManager {
    return new TaskRestoreManager(config);
}