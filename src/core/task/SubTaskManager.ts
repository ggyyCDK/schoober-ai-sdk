/**
 * 子任务管理器接口和实现
 * 负责管理任务的子任务和父子任务关系
 * 
 * 重构后增强：
 * - 承担原 AgentOrchestrator 的子任务管理职责
 * - 支持创建子任务、路由操作到活跃子任务
 * - 支持从持久化层懒恢复子任务
 */

import {
    Task,
    SubTaskResult,
    TaskStatus,
    TaskContext,
    TaskCallbacks,
    StartTaskConfig,
    Agent,
    PersistenceManager,
    AgentSDKError,
    ErrorCode,
    ILogger,
} from '@/types';
import { StateManager } from './StateManager';
import { ReActEngine } from './ReActEngine';
import { ToolManager } from './ToolManager';
import { BaseTool } from '../tools/BaseTool';
import type { TaskExecutor } from './TaskExecutor';

/**
 * 子任务管理器配置
 */
export interface SubTaskManagerConfig {
    /** 状态管理器 */
    stateManager: StateManager;
    /** ReAct 引擎 */
    reactEngine: ReActEngine;
    /** 工具管理器 */
    toolManager: ToolManager;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
    /** 执行任务的回调 */
    executeTask: () => Promise<void>;
    /** 设置状态的回调 */
    setStatus: (status: TaskStatus) => Promise<void>;
    /** 任务执行器（用于设置工具的 taskExecutor） */
    taskExecutor: TaskExecutor;
    /** 父任务的 Agent 引用（用于获取子 Agent 和创建子任务） */
    agent: Agent;
    /** 持久化管理器（用于恢复子任务） */
    persistenceManager?: PersistenceManager;
    /** 任务上下文（用于构建子任务上下文） */
    context: TaskContext;
}

/**
 * 子任务管理器接口
 */
export interface ISubTaskManager {
    setParentTask(parentTask: Task): void;
    addSubTask(subTask: Task): void;
    removeSubTask(subTaskId: string): void;
    subTaskDone(subTaskId: string, result: SubTaskResult): Promise<void>;
    abortAllSubTasks(): void;
    getSubTasks(): Task[];
    updateSubtaskIds(subtaskIds: string[]): void;
    /** 创建子任务 */
    createSubTask(agentName: string, config: StartTaskConfig): Promise<Task>;
    /** 路由到活跃子任务（如果有） */
    routeToActiveSubTask(): Promise<Task | null>;
}

/**
 * 子任务管理器实现
 */
export class SubTaskManager implements ISubTaskManager {
    private stateManager: StateManager;
    private reactEngine: ReActEngine;
    private toolManager: ToolManager;
    private logger: ILogger;
    private taskId: string;
    private executeTask: () => Promise<void>;
    private setStatus: (status: TaskStatus) => Promise<void>;
    private taskExecutor: TaskExecutor;

    // 新增：Agent 引用和持久化管理器
    private agent: Agent;
    private persistenceManager?: PersistenceManager;
    private context: TaskContext;

    // 子任务 Map（同时作为缓存）
    private subtasks: Map<string, Task> = new Map();

    // 父子任务关系
    private parentTask?: Task;

    constructor(config: SubTaskManagerConfig) {
        this.stateManager = config.stateManager;
        this.reactEngine = config.reactEngine;
        this.toolManager = config.toolManager;
        this.logger = config.logger;
        this.taskId = config.taskId;
        this.executeTask = config.executeTask;
        this.setStatus = config.setStatus;
        this.taskExecutor = config.taskExecutor;
        // 新增配置
        this.agent = config.agent;
        this.persistenceManager = config.persistenceManager;
        this.context = config.context;
    }

    /**
     * 设置父任务引用
     */
    setParentTask(parentTask: Task): void {
        this.parentTask = parentTask;
        this.logger.debug("SubTaskManager_setParentTask_success", {
            taskId: this.taskId,
            parentTaskId: parentTask.id
        });
    }

    /**
     * 添加子任务
     */
    addSubTask(subTask: Task): void {
        this.subtasks.set(subTask.id, subTask);
        this.logger.debug("SubTaskManager_addSubTask_success", {
            taskId: this.taskId,
            subTaskId: subTask.id
        });
    }

    /**
     * 移除子任务
     */
    removeSubTask(subTaskId: string): void {
        this.subtasks.delete(subTaskId);
        this.logger.debug("SubTaskManager_removeSubTask_success", {
            taskId: this.taskId,
            subTaskId
        });
    }

    /**
     * 处理子任务完成通知
     */
    async subTaskDone(subTaskId: string, result: SubTaskResult): Promise<void> {
        const currentStatus = this.stateManager.getState().status;

        this.logger.info("SubTaskManager_subTaskDone_notification", {
            taskId: this.taskId,
            subTaskId,
            success: result.success,
            currentStatus: currentStatus.getValue()
        });

        // 检查当前状态是否为 WAITING_FOR_SUBTASK
        if (!currentStatus.equals(TaskStatus.WAITING_FOR_SUBTASK)) {
            this.logger.warn("SubTaskManager_subTaskDone_invalidStatus", {
                taskId: this.taskId,
                currentStatus: currentStatus.getValue()
            });
            return;
        }

        // 通知NewTaskTool子任务完成（如果存在）
        try {
            const newTaskTool = this.toolManager.getTool('new_task');
            if (newTaskTool && typeof (newTaskTool as any).onSubTaskDone === 'function') {
                // 确保工具实例有正确的 taskExecutor
                if (newTaskTool instanceof BaseTool && this.taskExecutor) {
                    newTaskTool.setTaskExecutor(this.taskExecutor);
                }
                await (newTaskTool as any).onSubTaskDone(subTaskId, result);
                this.logger.debug("SubTaskManager_subTaskDone_newTaskToolNotified", {
                    taskId: this.taskId
                });
            }
        } catch (error) {
            this.logger.warn("SubTaskManager_subTaskDone_notifyNewTaskToolFailed", {
                taskId: this.taskId,
                error
            });
        }

        // 将状态恢复为 RUNNING
        await this.setStatus(TaskStatus.RUNNING);
        this.logger.info("SubTaskManager_subTaskDone_statusRestored", {
            taskId: this.taskId
        });

        // 如果父任务正在执行ReAct循环，继续执行
        if (!this.reactEngine.isExecuting()) {
            this.logger.debug("SubTaskManager_subTaskDone_startingExecution", {
                taskId: this.taskId
            });
            // 异步执行，不阻塞
            this.executeTask().catch(error => {
                this.logger.error("SubTaskManager_subTaskDone_executionFailed", {
                    taskId: this.taskId,
                    error
                });
            });
        }
    }

    /**
     * 中止所有子任务
     */
    abortAllSubTasks(): void {
        const subtaskCount = this.subtasks.size;
        if (subtaskCount > 0) {
            this.logger.debug("SubTaskManager_abortAllSubTasks_start", {
                taskId: this.taskId,
                subtaskCount
            });
            this.subtasks.forEach(subtask => {
                subtask.abort();
            });
        }
    }

    /**
     * 获取所有子任务
     */
    getSubTasks(): Task[] {
        return Array.from(this.subtasks.values());
    }

    /**
     * 更新子任务ID列表
     */
    updateSubtaskIds(subtaskIds: string[]): void {
        this.stateManager.updateState({ subtaskIds });
        this.logger.debug("SubTaskManager_updateSubtaskIds_success", {
            taskId: this.taskId,
            subtaskIds
        });
    }

    // ============= 新增方法：从 AgentOrchestrator 迁移 =============

    /**
     * 构建子任务上下文
     * 复用会话信息和 custom，但不复用 taskSummary 和 tokenUsage
     */
    private buildSubTaskContext(): TaskContext {
        const parentContext = this.context;
        return {
            userId: parentContext.userId,
            sessionId: parentContext.sessionId,
            custom: parentContext.custom,
            // taskSummary 和 tokenUsage 不传递，子任务独立管理
        };
    }

    /**
     * 构建子任务回调
     * 子任务完成时通知父任务
     */
    private buildSubTaskCallbacks(): TaskCallbacks {
        const parentCallbacks = this.taskExecutor.callbacks;

        return {
            onMessage: async (message) => {
                if (parentCallbacks?.onMessage) {
                    await parentCallbacks.onMessage(message);
                }
            },
            onTaskStateUpdate: async (state) => {
                // 转发父任务的 onTaskStateUpdate
                if (parentCallbacks?.onTaskStateUpdate) {
                    await parentCallbacks.onTaskStateUpdate(state);
                }

                // 子任务完成时通知父任务
                if (
                    state.status.equals(TaskStatus.COMPLETED) ||
                    state.status.equals(TaskStatus.FAILED) ||
                    state.status.equals(TaskStatus.ABORTED)
                ) {
                    const result: SubTaskResult = {
                        success: state.status.equals(TaskStatus.COMPLETED),
                        summary: state.context?.taskSummary || '',
                        subtaskId: state.id,
                        error: state.error?.message,
                    };

                    try {
                        await this.taskExecutor.subTaskDone(state.id, result);
                        this.logger.info("SubTaskManager_buildSubTaskCallbacks_subtaskCompletion", {
                            parentTaskId: this.taskId,
                            subTaskId: state.id,
                            success: result.success,
                        });
                    } catch (error) {
                        this.logger.error("SubTaskManager_buildSubTaskCallbacks_notifyParentFailed", {
                            parentTaskId: this.taskId,
                            subTaskId: state.id,
                            error: error instanceof Error ? error : new Error(String(error))
                        });
                    }
                }
            },
        };
    }

    /**
     * 创建子任务
     * 从 AgentOrchestrator.createSubTask 迁移
     */
    async createSubTask(agentName: string, config: StartTaskConfig): Promise<Task> {
        const subAgent = this.agent.getSubAgent(agentName);
        if (!subAgent) {
            throw new AgentSDKError(
                ErrorCode.VALIDATION_ERROR,
                `Sub agent '${agentName}' not found in parent agent '${this.agent.name}'`
            );
        }

        // 构建子任务上下文和回调
        const subTaskContext = this.buildSubTaskContext();
        const subTaskCallbacks = this.buildSubTaskCallbacks();

        // 创建子任务
        const subTask = await subAgent.createTask(config, subTaskContext, subTaskCallbacks);

        this.logger.info("SubTaskManager_createSubTask_success", {
            parentTaskId: this.taskId,
            subTaskId: subTask.id,
            subAgentName: agentName,
        });

        // 设置父子关系
        subTask.setParentTask(this.taskExecutor);
        this.subtasks.set(subTask.id, subTask);

        // 更新父任务的 subtaskIds
        await this.updateParentSubtaskIds(subTask.id, 'add');

        return subTask;
    }

    /**
     * 路由到活跃子任务
     * 用于 start/pause/abort 操作的路由判断
     * 如果任务处于 WAITING_FOR_SUBTASK 状态，返回活跃子任务；否则返回 null
     */
    async routeToActiveSubTask(): Promise<Task | null> {
        const state = this.stateManager.getState();
        if (!state.status.equals(TaskStatus.WAITING_FOR_SUBTASK)) {
            return null;
        }
        return (await this.getActiveSubTask()) || null;
    }

    /**
     * 获取活跃子任务（带懒恢复）
     * 先查缓存，缓存未命中再从持久化层恢复
     */
    private async getActiveSubTask(): Promise<Task | undefined> {
        const subtaskIds = this.stateManager.getState().subtaskIds || [];

        // 从后往前遍历，找到第一个非终态的子任务
        for (let i = subtaskIds.length - 1; i >= 0; i--) {
            const subTaskId = subtaskIds[i];

            // 1. 先查缓存
            let subTask = this.subtasks.get(subTaskId);

            // 2. 缓存未命中，懒恢复
            if (!subTask) {
                subTask = await this.restoreSubTask(subTaskId);
                if (subTask) {
                    this.subtasks.set(subTaskId, subTask);
                }
            }

            // 3. 检查是否为活跃状态
            if (subTask && !subTask.status.isFinal()) {
                return subTask;
            }
        }

        return undefined;
    }

    /**
     * 从持久化层恢复子任务
     */
    private async restoreSubTask(subTaskId: string): Promise<Task | undefined> {
        if (!this.persistenceManager) {
            return undefined;
        }

        // 1. 加载子任务状态，获取 agentName
        const subTaskState = await this.persistenceManager.loadTaskState(subTaskId);
        if (!subTaskState || !subTaskState.config.agentName) {
            this.logger.warn("SubTaskManager_restoreSubTask_stateNotFound", {
                parentTaskId: this.taskId,
                subTaskId,
            });
            return undefined;
        }

        // 2. 获取子 Agent
        const subAgent = this.agent.getSubAgent(subTaskState.config.agentName);
        if (!subAgent) {
            this.logger.warn("SubTaskManager_restoreSubTask_subAgentNotFound", {
                parentTaskId: this.taskId,
                subTaskId,
                agentName: subTaskState.config.agentName,
            });
            return undefined;
        }

        // 3. 构建子任务上下文和回调
        const subTaskContext = this.buildSubTaskContext();
        const subTaskCallbacks = this.buildSubTaskCallbacks();

        // 4. 使用子 Agent 恢复子任务
        const subTask = await subAgent.loadTask(subTaskId, subTaskContext, subTaskCallbacks);
        if (!subTask) {
            return undefined;
        }

        // 5. 恢复父子关系
        subTask.setParentTask(this.taskExecutor);

        this.logger.info("SubTaskManager_restoreSubTask_success", {
            parentTaskId: this.taskId,
            subTaskId,
            agentName: subTaskState.config.agentName,
        });

        return subTask;
    }

    /**
     * 更新父任务的 subtaskIds
     */
    private async updateParentSubtaskIds(
        subTaskId: string,
        operation: 'add' | 'remove'
    ): Promise<void> {
        const currentState = this.stateManager.getState();
        const currentSubtaskIds = currentState.subtaskIds || [];
        let updatedSubtaskIds: string[];

        if (operation === 'add') {
            if (!currentSubtaskIds.includes(subTaskId)) {
                updatedSubtaskIds = [...currentSubtaskIds, subTaskId];
            } else {
                return; // 已存在，无需更新
            }
        } else {
            updatedSubtaskIds = currentSubtaskIds.filter((id) => id !== subTaskId);
        }

        // 更新内存状态，StateManager 会自动处理持久化
        this.updateSubtaskIds(updatedSubtaskIds);

        this.logger.debug("SubTaskManager_updateParentSubtaskIds_success", {
            parentTaskId: this.taskId,
            operation,
            subTaskId,
            subtaskIds: updatedSubtaskIds,
        });
    }
}

/**
 * 创建子任务管理器
 */
export function createSubTaskManager(config: SubTaskManagerConfig): SubTaskManager {
    return new SubTaskManager(config);
}