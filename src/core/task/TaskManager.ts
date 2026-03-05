/**
 * TaskManager - 任务管理器
 * 负责从持久化层查询和管理任务，不负责创建任务
 * 任务创建由 Agent 直接负责
 */

import {
    TaskState,
    TaskStatus,
    PersistenceManager,
    AgentSDKError,
} from '@/types';

/**
 * TaskManager 配置
 * 简化后只需要持久化管理器
 */
export interface TaskManagerConfig {
    /** 持久化管理器 */
    persistenceManager: PersistenceManager;
}

/**
 * TaskManager 实现
 * 任务管理器是无状态的，不在内存中维护任务列表
 * 所有任务状态都存储在持久化层
 *
 * 职责：
 * - 查询任务状态
 * - 列出任务
 * - 删除任务
 * - 清理已完成的任务
 *
 * 注意：任务的创建和执行由 Agent 负责
 */
export class TaskManager {
    private persistenceManager: PersistenceManager;

    constructor(config: TaskManagerConfig) {
        this.persistenceManager = config.persistenceManager;
    }

    /**
     * 从持久化层获取任务状态
     * @param taskId 任务ID
     * @returns 任务状态或 undefined
     */
    async getTaskState(taskId: string): Promise<TaskState | undefined> {
        const state = await this.persistenceManager.loadTaskState(taskId);
        return state ?? undefined;
    }

    /**
     * 从持久化层获取所有任务状态
     * @returns 任务状态列表
     */
    async getAllTaskStates(): Promise<TaskState[]> {
        // 使用 listTaskStates 方法
        if ('listTaskStates' in this.persistenceManager) {
            return (this.persistenceManager as any).listTaskStates();
        }

        throw new AgentSDKError(
            'PersistenceManager does not support listTaskStates',
            'UNSUPPORTED_OPERATION'
        );
    }

    /**
     * 从持久化层获取运行中的任务状态
     * @returns 运行中的任务状态列表
     */
    async getRunningTaskStates(): Promise<TaskState[]> {
        const allStates = await this.getAllTaskStates();
        return allStates.filter(state => state.status === TaskStatus.RUNNING);
    }

    /**
     * 删除任务（从持久化层）
     * @param taskId 任务ID
     */
    async removeTask(taskId: string): Promise<void> {
        await this.persistenceManager.deleteTaskState(taskId);
        // 也删除任务的消息历史
        if ('deleteTaskMessages' in this.persistenceManager) {
            await (this.persistenceManager as any).deleteTaskMessages(taskId);
        }
    }

    /**
     * 清理已完成的任务
     */
    async cleanupCompletedTasks(): Promise<void> {
        const allStates = await this.getAllTaskStates();
        const completedStates = allStates.filter(
            state =>
                state.status === TaskStatus.COMPLETED ||
                state.status === TaskStatus.FAILED ||
                state.status === TaskStatus.ABORTED
        );

        for (const state of completedStates) {
            await this.removeTask(state.id);
        }
    }
}

/**
 * 创建任务管理器
 */
export function createTaskManager(config: TaskManagerConfig): TaskManager {
    return new TaskManager(config);
}