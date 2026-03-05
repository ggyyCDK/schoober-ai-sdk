/**
 * Task 接口和相关类型定义
 */

import { TaskCallbacks } from './agent';

/**
 * 子任务结果
 */
export interface SubTaskResult {
    /** 是否成功 */
    success: boolean;
    /** 任务总结 */
    summary: string;
    /** 子任务ID */
    subtaskId: string;
    /** 错误信息（如果失败） */
    error?: string;
}

/**
 * 任务状态值对象
 *
 * 封装任务状态转换的业务规则，符合DDD值对象设计
 *
 * 状态转换规则：
 * - PENDING -> RUNNING (启动任务)
 * - RUNNING -> PAUSED (暂停任务)
 * - RUNNING -> COMPLETED (完成任务)
 * - RUNNING -> FAILED (任务失败)
 * - RUNNING -> ABORTED (中止任务)
 * - PAUSED -> RUNNING (恢复任务)
 * - COMPLETED/FAILED/ABORTED -> RUNNING (重新激活任务)
 * - WAITING_FOR_SUBTASK -> RUNNING (子任务完成)
 */
export class TaskStatus {
    private readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    /** 待启动 */
    static readonly PENDING = new TaskStatus('pending');
    /** 运行中 */
    static readonly RUNNING = new TaskStatus('running');
    /** 已暂停 */
    static readonly PAUSED = new TaskStatus('paused');
    /** 已完成 */
    static readonly COMPLETED = new TaskStatus('completed');
    /** 已失败 */
    static readonly FAILED = new TaskStatus('failed');
    /** 已中止 */
    static readonly ABORTED = new TaskStatus('aborted');
    /** 等待子任务 */
    static readonly WAITING_FOR_SUBTASK = new TaskStatus('waiting_for_subtask');

    /**
     * 获取状态值（字符串）
     */
    getValue(): string {
        return this.value;
    }

    /**
     * 转换为字符串（用于序列化和比较）
     */
    toString(): string {
        return this.value;
    }

    /**
     * 值对象相等性比较
     */
    equals(other: TaskStatus): boolean {
        return this.value === other.value;
    }

    /**
     * 检查是否为最终状态（不能再转换）
     */
    isFinal(): boolean {
        return (
            this === TaskStatus.COMPLETED ||
            this === TaskStatus.FAILED ||
            this === TaskStatus.ABORTED
        );
    }

    /**
     * 检查是否为可执行状态（可以继续执行）
     */
    isExecutable(): boolean {
        return this === TaskStatus.RUNNING || this === TaskStatus.WAITING_FOR_SUBTASK;
    }

    /**
     * 检查是否可以转换到目标状态
     * @param target 目标状态
     * @returns 是否可以转换
     */
    canTransitionTo(target: TaskStatus): boolean {
        if (this.equals(target)) return true;

        // 最终状态可以重新激活
        if (this.isFinal()) {
            return target === TaskStatus.RUNNING;
        }

        const allowedTransitions = new Map<TaskStatus, TaskStatus[]>([
            [TaskStatus.PENDING, [TaskStatus.RUNNING]],
            [
                TaskStatus.RUNNING,
                [
                    TaskStatus.PAUSED,
                    TaskStatus.COMPLETED,
                    TaskStatus.FAILED,
                    TaskStatus.ABORTED,
                    TaskStatus.WAITING_FOR_SUBTASK,
                ],
            ],
            [TaskStatus.PAUSED, [TaskStatus.RUNNING, TaskStatus.ABORTED]],
            [TaskStatus.WAITING_FOR_SUBTASK, [TaskStatus.RUNNING]],
        ]);

        const allowed = allowedTransitions.get(this);
        return allowed ? allowed.some((status) => status.equals(target)) : false;
    }

    /**
     * 尝试转换状态
     * @param target 目标状态
     * @throws 如果转换不被允许，抛出错误
     */
    transitionTo(target: TaskStatus): TaskStatus {
        if (!this.canTransitionTo(target)) {
            throw new Error(
                `Cannot transition from ${this.value} to ${target.value}. Allowed transitions: ${this
                    .getAllowedTransitions()
                    .map((s) => s.value)
                    .join(', ')}`
            );
        }
        return target;
    }

    /**
     * 获取所有允许转换的目标状态
     */
    getAllowedTransitions(): TaskStatus[] {
        if (this.isFinal()) {
            return [TaskStatus.RUNNING];
        }

        const allowedTransitions = new Map<TaskStatus, TaskStatus[]>([
            [TaskStatus.PENDING, [TaskStatus.RUNNING]],
            [
                TaskStatus.RUNNING,
                [
                    TaskStatus.PAUSED,
                    TaskStatus.COMPLETED,
                    TaskStatus.FAILED,
                    TaskStatus.ABORTED,
                    TaskStatus.WAITING_FOR_SUBTASK,
                ],
            ],
            [TaskStatus.PAUSED, [TaskStatus.RUNNING, TaskStatus.ABORTED]],
            [TaskStatus.WAITING_FOR_SUBTASK, [TaskStatus.RUNNING]],
        ]);

        return allowedTransitions.get(this) || [];
    }

    /**
     * 从字符串创建TaskStatus（用于反序列化）
     * @param value 状态值字符串
     * @returns TaskStatus实例
     * @throws 如果状态值无效，抛出错误
     */
    static fromString(value: string): TaskStatus {
        const statusMap: Record<string, TaskStatus> = {
            pending: TaskStatus.PENDING,
            running: TaskStatus.RUNNING,
            paused: TaskStatus.PAUSED,
            completed: TaskStatus.COMPLETED,
            failed: TaskStatus.FAILED,
            aborted: TaskStatus.ABORTED,
            waiting_for_subtask: TaskStatus.WAITING_FOR_SUBTASK,
        };

        const status = statusMap[value];
        if (!status) {
            throw new Error(`Invalid TaskStatus value: ${value}`);
        }

        return status;
    }

    /**
     * 检查状态值是否有效
     * @param value 状态值字符串
     * @returns 是否有效
     */
    static isValid(value: string): boolean {
        const validValues = [
            'pending',
            'running',
            'paused',
            'completed',
            'failed',
            'aborted',
            'waiting_for_subtask',
        ];
        return validValues.includes(value);
    }

    /**
     * 获取所有可能的状态值
     */
    static getAll(): TaskStatus[] {
        return [
            TaskStatus.PENDING,
            TaskStatus.RUNNING,
            TaskStatus.PAUSED,
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.ABORTED,
            TaskStatus.WAITING_FOR_SUBTASK,
        ];
    }

    /**
     * JSON序列化支持（用于持久化）
     */
    toJSON(): string {
        return this.value;
    }

    /**
     * 值对象比较（用于排序等场景）
     */
    compareTo(other: TaskStatus): number {
        return this.value.localeCompare(other.value);
    }
}

/**
 * 向后兼容：导出枚举类型别名
 * @deprecated 使用TaskStatus类代替，保留此类型仅用于向后兼容
 */
export type TaskStatusEnum = TaskStatus;

/**
 * 任务配置
 */
export interface StartTaskConfig {
    /** 任务ID（可选，如果不提供会自动生成） */
    id?: string;
    /** 任务名称 */
    name: string;
    /** 任务描述 */
    description?: string;
    /** 父任务ID */
    parentId?: string;
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 最大重试次数 */
    maxRetries?: number;
    metadata?: Record<string, any>;
    /** 初始输入（可选，如果提供则start不需要传入） */
    input?: TaskInput;
    agentName?: string;
}
/**
 * Token 使用情况
 */
export interface TaskTokenUsage {
    /** 累计输入 token（所有请求的输入 token 相加） */
    totalInputTokens: number;
    /** 累计输出 token（所有请求的输出 token 相加） */
    totalOutputTokens: number;
    /** 累计总 token */
    totalTokens: number;
    /** 最新一次请求的输入 token（用于后续压缩） */
    lastRequestInputTokens: number;
    /** 请求次数（可选，用于统计） */
    requestCount?: number;
}

/**
 * 任务上下文
 */
export interface TaskContext {
    /** 用户ID */
    userId?: string;
    /** 会话ID */
    sessionId?: string;
    /** 自定义上下文数据 */
    custom?: Record<string, any>;
    /** 任务总结 */
    taskSummary?: string;
    /** Token 使用情况 */
    tokenUsage?: TaskTokenUsage;
}

/**
 * 任务输入
 */
export interface TaskInput {
    /** 用户消息 */
    message: string;
    /** 附件 */
    attachments?: TaskAttachment[];
    /** 输入参数 */
    params?: Record<string, any>;
    /** 是否流式响应 */
    stream?: boolean;
}

/**
 * 任务附件
 */
export interface TaskAttachment {
    /** 附件类型 */
    type: 'file' | 'image' | 'url' | 'text';
    /** 附件名称 */
    name?: string;
    /** 附件内容或URL */
    content: string;
    /** MIME类型 */
    mimeType?: string;
    /** 附件大小（字节） */
    size?: number;
}

/**
 * 任务结果
 */
export interface TaskResult {
    /** 结果状态 */
    status: 'success' | 'error' | 'partial';
    /** 结果数据 */
    data?: any;
    /** 错误信息 */
    error?: Error;
    /** 执行的工具列表 */
    toolsExecuted?: string[];
    /** 执行时长（毫秒） */
    duration?: number;
    /** 元数据 */
    metadata?: Record<string, any>;
}

/**
 * 任务状态快照
 */
export interface TaskState {
    /** 任务ID */
    id: string;
    /** 任务状态 */
    status: TaskStatus;
    /** 任务配置 */
    config: StartTaskConfig;
    /** 任务上下文 */
    context: TaskContext;
    /** 开始时间 */
    startTime?: Date;
    /** 结束时间 */
    endTime?: Date;
    /** 当前重试次数 */
    retryCount?: number;
    /** 子任务ID列表 */
    subtaskIds?: string[];
    /** 错误信息 */
    error?: Error;
}

/**
 * 任务接口
 */
export interface Task {
    /** 任务唯一标识 */
    id: string;
    /** 父任务ID */
    parentId?: string;
    /** 任务状态 */
    status: TaskStatus;
    /** 任务上下文 */
    context: TaskContext;

    /**
     * 启动任务
     *
     * 根据当前任务状态执行相应操作：
     * - PENDING: 初始化并开始执行任务
     * - PAUSED: 恢复任务执行（如果传入 input.message 则添加用户消息）
     * - RUNNING: 继续对话（添加用户消息并重新执行）
     * - 终态(COMPLETED/FAILED/ABORTED): 重新激活任务
     *
     * @param input 任务输入（可选，如果创建时已提供input则不需要传入）
     */
    start(input?: TaskInput): Promise<void>;

    /**
     * 暂停任务
     */
    pause(needRollback?: boolean): void;

    /**
     * 中止任务
     */
    abort(): void;

    /**
     * 等待任务完成
     * @returns 任务结果
     */
    wait(): Promise<TaskResult>;

    /**
     * 发送消息给任务
     * @param message 消息内容
     */
    sendMessage(message: string): Promise<void>;

    /**
     * 获取任务消息历史
     * @returns 消息列表
     */
    getMessages(): TaskMessage[];

    getState(): TaskState;

    /** 更新回调函数 */
    updateCallbacks(callbacks?: TaskCallbacks): void;

    /** 获取回调函数 */
    get callbacks(): TaskCallbacks | undefined;

    /** 子任务完成通知 */
    subTaskDone(subTaskId: string, result: SubTaskResult): Promise<void>;

    /** 设置父任务 */
    setParentTask(parentTask: Task): void;

    /** 更新子任务ID列表 */
    updateSubtaskIds(subtaskIds: string[]): void;

    /** 添加子任务到 Map（供 AgentOrchestrator 使用） */
    addSubTask(subTask: Task): void;
}

/**
 * 任务消息
 */
export interface TaskMessage {
    /** 消息ID */
    id: string;
    /** 任务ID */
    taskId: string;
    /** 消息角色 */
    role: 'user' | 'assistant' | 'system' | 'tool';
    /** 消息内容 */
    content: string;
    /** 工具调用信息 */
    toolCall?: {
        name: string;
        params: any;
        result?: any;
    };
    /** 时间戳 */
    timestamp: Date;
    /** 元数据 */
    metadata?: Record<string, any>;
}

/**
 * 任务管理器接口
 */
export interface TaskManager {
    /**
     * 创建任务
     * @param config 任务配置
     * @returns 任务实例
     */
    createTask(config: StartTaskConfig): Promise<Task>;

    /**
     * 获取任务
     * @param taskId 任务ID
     * @returns 任务实例或undefined
     */
    getTask(taskId: string): Task | undefined;

    /**
     * 获取所有任务
     * @returns 任务列表
     */
    getAllTasks(): Task[];

    /**
     * 获取运行中的任务
     * @returns 运行中的任务列表
     */
    getRunningTasks(): Task[];

    /**
     * 移除任务
     * @param taskId 任务ID
     */
    removeTask(taskId: string): void;

    /**
     * 清理已完成的任务
     */
    cleanupCompletedTasks(): void;
}