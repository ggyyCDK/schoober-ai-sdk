/**
 * 状态管理器 - 负责任务状态的管理和持久化
 */

import { AgentSDKError, PersistenceManager, TaskState, TaskStatus, ILogger, createDefaultLogger } from '@/types';


/**
 * 自动持久化配置
 */
export interface AutoPersistConfig {
    /** 是否启用自动持久化 */
    enabled: boolean;
    /** 防抖延迟（毫秒） */
    debounceMs: number;
    /** 最大等待时间（毫秒），超过此时间强制保存 */
    maxWaitMs?: number;
}

/**
 * 状态变化回调
 */
export interface StatusChangeCallback {
    /** 旧状态 */
    oldStatus: TaskStatus;
    /** 新状态 */
    newStatus: TaskStatus;
}

/**
 * 状态管理器配置
 */
export interface StateManagerConfig {
    /** 初始状态 */
    initialState: TaskState;
    /** 持久化管理器（可选） */
    persistenceManager?: PersistenceManager;
    /** 自动持久化配置 */
    autoPersist?: AutoPersistConfig;
    /** 日志记录器（可选） */
    logger?: ILogger;
    /** 状态变化回调（当检测到状态变化时调用） */
    onStatusChange?: (change: StatusChangeCallback) => void;
}

/**
 * 状态管理器实现
 */
export class StateManager {
    private state: TaskState;
    private persistenceManager?: PersistenceManager;
    private logger: ILogger;

    // 防抖控制
    private autoPersist: boolean;
    private debounceMs: number;
    private maxWaitMs: number;
    private saveTimer?: NodeJS.Timeout;
    private firstPendingSaveTime?: number;
    private isSaving: boolean = false;
    private hasPendingChanges: boolean = false;

    // 状态变化回调
    private onStatusChange?: (change: StatusChangeCallback) => void;

    /**
     * 设置状态变化回调（允许延迟设置）
     */
    setOnStatusChange(callback?: (change: StatusChangeCallback) => void): void {
        this.onStatusChange = callback;
    }

    constructor(config: StateManagerConfig) {
        this.state = { ...config.initialState };
        this.persistenceManager = config.persistenceManager;
        this.logger = config.logger || createDefaultLogger();

        // 初始化防抖配置
        this.autoPersist = config.autoPersist?.enabled ?? true;
        this.debounceMs = config.autoPersist?.debounceMs ?? 1000;
        this.maxWaitMs = config.autoPersist?.maxWaitMs ?? 5000;

        // 初始化状态变化回调
        this.onStatusChange = config.onStatusChange;
    }

    /**
     * 获取当前状态
     */
    getState(): TaskState {
        return { ...this.state };
    }

    /**
     * 更新状态 - 自动触发防抖持久化
     */
    updateState(updates: Partial<TaskState>): void {
        // 记录旧状态（用于判断状态是否发生变化）
        const oldStatus = this.state.status;
        const hasStatusUpdate = updates.status !== undefined;

        // 1. 立即更新内存
        this.state = {
            ...this.state,
            ...updates,
        };

        // 2. 如果状态发生变化，触发状态变化回调
        if (hasStatusUpdate && this.onStatusChange && !oldStatus.equals(this.state.status)) {
            try {
                this.onStatusChange({
                    oldStatus,
                    newStatus: this.state.status,
                });
            } catch (error) {
                this.logger.error("StateManager_updateState_onStatusChangeError", {
                    taskId: this.state.id,
                    error
                });
            }
        }

        // 3. 触发防抖持久化
        if (this.autoPersist && this.persistenceManager) {
            this.scheduleSave();
        }
    }

    /**
     * 设置错误
     */
    setError(error: Error): void {
        this.updateState({
            error,
        });
    }

    /**
     * 获取开始时间
     */
    getStartTime(): Date | undefined {
        return this.state.startTime;
    }

    /**
     * 获取结束时间
     */
    getEndTime(): Date | undefined {
        return this.state.endTime;
    }

    /**
     * 设置开始时间
     */
    setStartTime(time: Date): void {
        this.updateState({ startTime: time });
    }

    /**
     * 设置结束时间
     */
    setEndTime(time: Date): void {
        this.updateState({ endTime: time });
    }

    /**
     * 设置任务总结
     */
    setTaskSummary(summary: string): void {
        this.updateState({
            context: {
                ...this.state.context,
                taskSummary: summary,
            },
        });
    }

    /**
     * 计算执行时长（毫秒）
     */
    calculateDuration(): number {
        if (!this.state.startTime) return 0;
        const end = this.state.endTime || new Date();
        return end.getTime() - this.state.startTime.getTime();
    }

    /**
     * 获取当前重试次数
     */
    getRetryCount(): number {
        return this.state.retryCount || 0;
    }

    /**
     * 增加重试次数
     */
    incrementRetryCount(): void {
        const currentCount = this.getRetryCount();
        this.updateState({ retryCount: currentCount + 1 });
    }
    /**
   * 重置重试次数
   */
    resetRetryCount(): void {
        this.updateState({ retryCount: 0 });
    }

    /**
     * 调度保存 - 防抖逻辑
     */
    private scheduleSave(): void {
        // 标记有待保存的变更
        this.hasPendingChanges = true;

        // 记录首次待保存时间（用于 maxWait）
        if (!this.firstPendingSaveTime) {
            this.firstPendingSaveTime = Date.now();
        }

        // 清除之前的定时器
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        // 检查是否达到最大等待时间
        const now = Date.now();
        const waitedTime = now - (this.firstPendingSaveTime || now);

        if (waitedTime >= this.maxWaitMs) {
            // 达到最大等待时间，立即保存
            this.performSave();
        } else {
            // 设置新的防抖定时器
            const delay = Math.min(this.debounceMs, this.maxWaitMs - waitedTime);
            this.saveTimer = setTimeout(() => {
                this.performSave();
            }, delay);
        }
    }

    /**
     * 执行保存 - 真正的 IO 操作
     */
    private performSave(): void {
        // 避免重复保存
        if (this.isSaving || !this.hasPendingChanges) {
            return;
        }

        this.isSaving = true;
        this.hasPendingChanges = false;
        this.firstPendingSaveTime = undefined;

        // 捕获当前状态快照（避免保存过程中状态被修改）
        const stateSnapshot = { ...this.state };

        // 异步执行保存，不阻塞主流程
        this.saveStateInternal(stateSnapshot)
            .catch(error => {
                // 保存失败处理（记录日志）
                this.logger.error("StateManager_performSave_persistFailed", {
                    taskId: this.state.id,
                    error
                });
                // 标记为有待保存的变更，下次 updateState 时会重试
                this.hasPendingChanges = true;
            })
            .finally(() => {
                this.isSaving = false;

                // 如果在保存期间又有新的变更，继续调度
                if (this.hasPendingChanges) {
                    this.scheduleSave();
                }
            });
    }

    /**
     * 内部保存方法 - 真正的异步 IO
     */
    private async saveStateInternal(state: TaskState): Promise<void> {
        if (!this.persistenceManager) {
            return;
        }

        try {
            await this.persistenceManager.saveTaskState(state.id, state);
        } catch (error) {
            throw new AgentSDKError(
                `Failed to save task state: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: state.id, error }
            );
        }
    }

    /**
     * 手动保存（立即执行，不防抖）
     * 用于关键时刻：任务完成、中止等
     */
    async saveStateNow(): Promise<void> {
        // 取消待定的定时器
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        // 等待当前保存完成
        while (this.isSaving) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 如果有待保存的变更，立即保存
        if (this.hasPendingChanges || this.firstPendingSaveTime) {
            await this.saveStateInternal({ ...this.state });
            this.hasPendingChanges = false;
            this.firstPendingSaveTime = undefined;
        }
    }

    /**
     * 从持久化存储加载状态
     */
    async loadState(taskId: string): Promise<TaskState | null> {
        if (!this.persistenceManager) {
            return null;
        }

        try {
            const loadedState = await this.persistenceManager.loadTaskState(taskId);
            if (loadedState) {
                this.state = loadedState;
            }
            return loadedState;
        } catch (error) {
            throw new AgentSDKError(
                `Failed to load task state: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId, error }
            );
        }
    }

    /**
     * 规范化状态（处理反序列化）
     */
    private normalizeState(state: TaskState): TaskState {
        // 处理TaskStatus反序列化
        let normalizedStatus: TaskStatus;
        if (typeof state.status === 'string') {
            normalizedStatus = TaskStatus.fromString(state.status);
        } else if (state.status instanceof TaskStatus) {
            normalizedStatus = state.status;
        } else {
            normalizedStatus = state.status as TaskStatus;
        }

        return {
            ...state,
            status: normalizedStatus,
            startTime: state.startTime
                ? state.startTime instanceof Date
                    ? state.startTime
                    : new Date(state.startTime as any)
                : undefined,
            endTime: state.endTime
                ? state.endTime instanceof Date
                    ? state.endTime
                    : new Date(state.endTime as any)
                : undefined,
        };
    }


    /**
     * 恢复状态（从持久化层恢复时使用）
     * 处理日期字段和TaskStatus的反序列化（JSON 中可能是字符串）
     */
    restoreState(state: TaskState): void {
        // 处理TaskStatus反序列化：如果status是字符串，转换为TaskStatus值对象
        let normalizedStatus: TaskStatus;
        if (typeof state.status === 'string') {
            normalizedStatus = TaskStatus.fromString(state.status);
        } else if (state.status instanceof TaskStatus) {
            normalizedStatus = state.status;
        } else {
            // 兼容旧代码：如果status已经是TaskStatus实例，直接使用
            normalizedStatus = state.status as TaskStatus;
        }

        const normalizedState: TaskState = {
            ...state,
            status: normalizedStatus,
            startTime: state.startTime ?
                (state.startTime instanceof Date ? state.startTime : new Date(state.startTime as any)) :
                undefined,
            endTime: state.endTime ?
                (state.endTime instanceof Date ? state.endTime : new Date(state.endTime as any)) :
                undefined,
        };

        this.state = normalizedState;
    }

    /**
     * 删除状态
     */
    async deleteState(): Promise<void> {
        if (!this.persistenceManager) {
            return;
        }

        try {
            await this.persistenceManager.deleteTaskState(this.state.id);
        } catch (error) {
            throw new AgentSDKError(
                `Failed to delete task state: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'PERSISTENCE_ERROR',
                { taskId: this.state.id, error }
            );
        }
    }

    /**
     * 析构时清理
     */
    destroy(): void {
        // 清理保存定时器
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
    }

}

/**
 * 创建状态管理器
 */
export function createStateManager(config: StateManagerConfig): StateManager {
    return new StateManager(config);
}