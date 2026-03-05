/**
 * Task执行引擎 - 重构版
 *
 * 核心改进:
 * 1. 使用管理器模式拆分职责,从 1077 行减少到约 300 行
 * 2. 直接使用 ApiMessage,消除 TaskMessage 转换
 * 3. SystemPrompt 只传递一次
 * 4. 工具结果由工具内部完全控制
 */

import {
    Task,
    TaskStatus,
    StartTaskConfig,
    TaskContext,
    TaskInput,
    TaskResult,
    TaskState,
    TaskMessage,
    ToolUse,
    ApiMessage,
    UserMessage,
    AgentSDKError,
    Tool,
    ToolInfo,
    ToolStatus as ToolStatusEnum,
    Agent,
    TaskCallbacks,
    ILogger,
    TaskTokenUsage,
    SubTaskResult,
} from "@/types";
import { StateManager, createStateManager } from "./StateManager";
import { MessageManager, createMessageManager } from "./MessageManager";
import { ExecutionManager, createExecutionManager } from "./ExecutionManager";
import {
    ToolManager,
    createToolManager,
    TaskMessageHandler,
} from "./ToolManager";
import { ErrorTracker, createErrorTracker } from "./ErrorTracker";
import { ReActEngine, createReActEngine, ReActCallbacks } from "./ReActEngine";
import {
    MessageCoordinator,
    createMessageCoordinator,
} from "./MessageCoordinator";
import { AttemptCompletionTool } from "../tools/AttemptCompletionTool";
import {
    generateTaskId,
    generateApiMessageId,
    generateUserMessageId,
} from "../utils/idGenerator";
import { deepMerge } from "../utils/deepMerge";
import { NewTaskTool } from "../tools/NewTaskTool";
import { LifecycleManager, createLifecycleManager } from "./LifecycleManager";
import { SubTaskManager, createSubTaskManager } from "./SubTaskManager";
import { CallbackManager, createCallbackManager } from "./CallbackManager";
import {
    TokenUsageManager,
    createTokenUsageManager,
} from "./TokenUsageManager";
import {
    TaskRestoreManager,
    createTaskRestoreManager,
} from "./TaskRestoreManager";
import { ErrorHandler, createErrorHandler } from "./ErrorHandler";

/**
 * 错误代码枚举
 */
export enum ErrorCode {
    INVALID_STATE = "INVALID_STATE",
    LLM_ERROR = "LLM_ERROR",
    TOOL_EXECUTION_ERROR = "TOOL_EXECUTION_ERROR",
    VALIDATION_ERROR = "VALIDATION_ERROR",
    TIMEOUT_ERROR = "TIMEOUT_ERROR",
    NETWORK_ERROR = "NETWORK_ERROR",
}

/**
 * Task执行引擎实现 - 重构版（ReAct循环）
 * 使用管理器模式，职责清晰，代码量减少约50%
 */
export class TaskExecutor implements Task, TaskMessageHandler {
    // 基础属性
    public readonly id: string;
    public readonly parentId?: string;
    public context: TaskContext;

    // Agent 引用（公开以供工具访问）
    public readonly agent: Agent;

    // Logger
    private logger: ILogger;

    // 基础管理器（已存在）
    private stateManager: StateManager;
    private messageManager: MessageManager;
    private executionManager: ExecutionManager;
    private toolManager: ToolManager;
    private errorTracker: ErrorTracker;
    private reactEngine: ReActEngine;
    private messageCoordinator: MessageCoordinator;

    // 新增管理器
    private lifecycleManager: LifecycleManager;
    private subTaskManager: SubTaskManager;
    private callbackManager: CallbackManager;
    private tokenUsageManager: TokenUsageManager;
    private taskRestoreManager: TaskRestoreManager;
    private errorHandler: ErrorHandler;

    // 配置
    private config: StartTaskConfig;

    // 系统工具（强制添加，不可移除）
    private systemTools: Tool[];

    /**
     * 获取任务状态（从 stateManager）
     */
    public get status(): TaskStatus {
        return this.stateManager.getState().status;
    }

    /**
     * 设置任务状态（同时更新 stateManager）
     */
    private set status(value: TaskStatus) {
        this.stateManager.updateState({ status: value });
    }

    /**
     * 公开方法：设置任务状态
     * 供工具（如 NewTaskTool）调用
     * @param status 新的任务状态
     */
    public async setStatus(status: TaskStatus): Promise<void> {
        this.logger.info("TaskExecutor_setStatus_statusChanged", {
            taskId: this.id,
            oldStatus: this.status.getValue(),
            newStatus: status.getValue(),
        });
        this.status = status;

        // 触发状态更新回调
        await this.callbackManager.notifyStateUpdate(this.stateManager.getState());
    }

    /**
     * 获取 callbacks（供工具使用）- Task 接口实现
     */
    public get callbacks(): TaskCallbacks | undefined {
        return this.callbackManager.getCallbacks();
    }

    /**
     * 更新任务的 callbacks - Task 接口实现
     */
    public updateCallbacks(callbacks?: TaskCallbacks): void {
        this.callbackManager.updateCallbacks(callbacks);
    }

    constructor(
        agent: Agent,
        config: StartTaskConfig,
        context: TaskContext,
        callbacks?: TaskCallbacks,
        taskId?: string
    ) {
        // taskId 必须从外部传入，以确保持久化层的 taskId 一致性
        this.id = taskId || config.id || generateTaskId();
        this.parentId = config.parentId;
        this.agent = agent;
        this.config = config;
        this.context = context;

        // 获取 logger
        this.logger = agent.getLogger();

        // 初始化状态管理器（必须先初始化，因为 status getter/setter 依赖它）
        // 注意：onStatusChange 回调将在所有管理器初始化后设置
        this.stateManager = createStateManager({
            initialState: {
                id: this.id,
                status: TaskStatus.PENDING,
                config: this.config,
                context: this.context,
            },
            persistenceManager: agent.getPersistenceManager(),
            logger: this.logger,
        });

        // 初始化消息管理器
        this.messageManager = createMessageManager({
            taskId: this.id,
            persistenceManager: agent.getPersistenceManager(),
            logger: this.logger,
        });

        // 初始化执行管理器（不再传递 systemPrompt，改为在 ReActEngine 中动态生成）
        this.executionManager = createExecutionManager({
            llmProvider: agent.getLLMProvider(),
            messageParser: agent.getMessageParser(),
            temperature: config.metadata?.temperature,
            maxTokens: config.metadata?.maxTokens,
            logger: this.logger,
            taskId: this.id,
        });

        // 添加系统工具（强制添加，不可移除）
        this.systemTools = [new NewTaskTool(), new AttemptCompletionTool()];

        // 初始化工具管理器（传递 ToolRegistry 和系统工具）
        this.toolManager = createToolManager({
            toolRegistry: (agent as any).toolRegistry,
            systemTools: this.systemTools,
            logger: this.logger,
        });
        // 初始化错误追踪器
        this.errorTracker = createErrorTracker({
            maxSameErrorCount: 3, // 相同错误出现3次则暂停
            signatureAlgorithm: "simple",
            recordStack: true,
            logger: this.logger,
        });

        // 注册所有工具到解析器（需要临时实例来注册）
        const messageParser = agent.getMessageParser();
        // 先注册系统工具（同步）
        for (const tool of this.systemTools) {
            messageParser.registerTool(tool);
        }
        // 异步注册 Agent 注册的工具（延迟注册，不影响构造函数）
        agent
            .getTools()
            .then((registeredTools) => {
                for (const tool of registeredTools) {
                    messageParser.registerTool(tool);
                }
            })
            .catch((error) => {
                this.logger.warn("TaskExecutor_registerTools_failed", {
                    taskId: this.id,
                    error,
                });
            });

        // 初始化消息协调器
        this.messageCoordinator = createMessageCoordinator({
            taskId: this.id,
            messageManager: this.messageManager,
            onMessageSend: callbacks?.onMessage,
            logger: this.logger,
            agentName: this.agent.name,
        });

        // 初始化回调管理器
        this.callbackManager = createCallbackManager({
            messageCoordinator: this.messageCoordinator,
            logger: this.logger,
            taskId: this.id,
        });
        this.callbackManager.updateCallbacks(callbacks);

        // 初始化 Token 使用统计管理器（需要在 reactCallbacks 之前初始化）
        this.tokenUsageManager = createTokenUsageManager({
            stateManager: this.stateManager,
            logger: this.logger,
            taskId: this.id,
        });
        // 初始化 ReActEngine
        const reactCallbacks: ReActCallbacks = {
            getMessages: () => this.messageCoordinator.getApiMessages(),
            getStatus: () => this.status,
            getTaskState: () => this.stateManager.getState(),
            buildSystemPrompt: async (taskState: TaskState) => {
                return await this.agent.buildSystemPrompt(taskState, this.systemTools);
            },
            buildEnvironmentPrompt: async (taskState: TaskState) => {
                return await this.agent.buildEnvironmentPrompt(taskState);
            },
            insertReminderMessage: async (content: string) => {
                await this.messageCoordinator.insertApiMessage(content);
            },
            handleToolExecution: async (toolUse: ToolUse) => {
                await this.toolManager.executeTool(
                    toolUse,
                    {
                        taskId: this.id,
                        agentContext: {
                            userId: this.context.userId,
                            sessionId: this.context.sessionId,
                        },
                        requestId: toolUse.requestId!,
                        custom: this.context.custom,
                    },
                    this
                );
            },
            trackError: (error: Error) => {
                const shouldPause = this.errorTracker.trackError(error);
                if (shouldPause) {
                    const errorMessage = `检测到相同错误重复出现${this.errorTracker.getErrorCount(
                        error
                    )}次，任务已暂停。\n错误: ${error.message}`;
                    this.messageCoordinator.insertApiMessage(errorMessage);
                }
                return shouldPause;
            },
            pauseTask: async (needRollback = false) => await this.pause(needRollback),
            updateTokenUsage: (inputTokens: number, outputTokens: number) =>
                this.tokenUsageManager.updateTokenUsage(inputTokens, outputTokens),
            getLLMProvider: () => this.agent.getLLMProvider(),
        };

        this.reactEngine = createReActEngine({
            executionManager: this.executionManager,
            messageCoordinator: this.messageCoordinator,
            callbacks: reactCallbacks,
            logger: this.logger,
            taskId: this.id,
        });

        // 初始化子任务管理器（增强版，承担原 AgentOrchestrator 的子任务管理职责）
        this.subTaskManager = createSubTaskManager({
            stateManager: this.stateManager,
            reactEngine: this.reactEngine,
            toolManager: this.toolManager,
            logger: this.logger,
            taskId: this.id,
            executeTask: () => this.executeTask(),
            setStatus: (status: TaskStatus) => this.setStatus(status),
            taskExecutor: this,
            // 新增配置：用于创建和恢复子任务
            agent: this.agent,
            persistenceManager: agent.getPersistenceManager(),
            context: this.context,
        });

        // 初始化生命周期管理器
        this.lifecycleManager = createLifecycleManager({
            stateManager: this.stateManager,
            messageCoordinator: this.messageCoordinator,
            reactEngine: this.reactEngine,
            executionManager: this.executionManager,
            logger: this.logger,
            taskId: this.id,
            maxRetries: this.config.maxRetries,
            addUserInputMessage: (message: string) =>
                this.addUserInputMessage(message),
            executeTask: () => this.executeTask(),
            onComplete: async (completionData?: any) => {
                // 完成时的额外处理（如果需要）
            },
            onStateUpdate: async (state: TaskState) => {
                await this.callbackManager.notifyStateUpdate(state);
            },
        });

        // 初始化错误处理器
        this.errorHandler = createErrorHandler({
            stateManager: this.stateManager,
            messageCoordinator: this.messageCoordinator,
            errorTracker: this.errorTracker,
            logger: this.logger,
            taskId: this.id,
            maxRetries: this.config.maxRetries,
            executeTask: () => this.executeTask(),
            completionHandlers: this.lifecycleManager.getCompletionHandlers(),
        });

        // 初始化任务状态恢复管理器
        this.taskRestoreManager = createTaskRestoreManager({
            stateManager: this.stateManager,
            messageCoordinator: this.messageCoordinator,
            logger: this.logger,
            taskId: this.id,
            setupCompletionPromise: () =>
                this.lifecycleManager.setupCompletionPromise(),
        });

        // 设置状态管理器的状态变化回调（需要在所有管理器初始化后设置）
        // 通知 CallbackManager 状态变化，确保外部监听器收到通知
        this.stateManager.setOnStatusChange(async (change) => {
            // 通知 CallbackManager 状态变化（确保外部监听器收到通知）
            // 这包括 ErrorHandler 触发的状态变化
            const currentState = this.stateManager.getState();
            await this.callbackManager.notifyStateUpdate(currentState);
        });
    }

    // ============= 执行控制 =============

    /**
     * 启动任务或继续对话
     * - 如果任务处于 WAITING_FOR_SUBTASK 状态，自动路由到活跃子任务
     * - 否则委托给 LifecycleManager
     */
    async start(input?: TaskInput): Promise<void> {
        try {
            // 尝试路由到子任务
            const activeSubTask = await this.subTaskManager.routeToActiveSubTask();
            if (activeSubTask) {
                this.logger.info("TaskExecutor_start_routeToSubTask", {
                    taskId: this.id,
                    subTaskId: activeSubTask.id,
                });
                await activeSubTask.start(input);
                return;
            }

            // 如果没有传入input,从持久化层读取
            let taskInput: TaskInput | undefined = input;
            if (!taskInput) {
                const persistenceManager = this.agent.getPersistenceManager();
                if (persistenceManager) {
                    const loadedInput = await persistenceManager.loadTaskInput(this.id);
                    taskInput = loadedInput || undefined;
                }
            }

            await this.lifecycleManager.start(taskInput);
        } catch (error) {
            await this.errorHandler.handleError(error as Error);
            throw error;
        }
    }

    /**
     * 添加用户输入消息（委托给 MessageCoordinator）
     */
    private async addUserInputMessage(message: string): Promise<void> {
        await this.messageCoordinator.addUserInput(message);
    }

    /**
     * 暂停任务
     * - 如果任务处于 WAITING_FOR_SUBTASK 状态，自动路由到活跃子任务
     * - 否则委托给 LifecycleManager
     */
    async pause(needRollback = false): Promise<void> {
        const activeSubTask = await this.subTaskManager.routeToActiveSubTask();
        if (activeSubTask) {
            this.logger.info("TaskExecutor_pause_routeToSubTask", {
                taskId: this.id,
                subTaskId: activeSubTask.id,
            });
            await activeSubTask.pause(needRollback);
            return;
        }
        await this.lifecycleManager.pause(needRollback);
    }

    /**
     * 恢复任务
     * @deprecated 请使用 start() 代替。此方法仅为向后兼容保留。
     */
    resume(): void {
        // 内部调用 start()，但不等待
        this.start().catch((error) => {
            this.logger.error("TaskExecutor_resume_failed", {
                taskId: this.id,
                error,
            });
        });
    }

    /**
     * 中止任务 - 委托给 LifecycleManager
     */
    abort(): void {
        // 中止所有子任务
        this.subTaskManager.abortAllSubTasks();
        this.lifecycleManager.abort();
    }

    /**
     * 等待任务完成 - 委托给 LifecycleManager
     */
    async wait(): Promise<TaskResult> {
        return this.lifecycleManager.wait();
    }

    /**
     * 执行任务 - 委托给 ReActEngine
     */
    private async executeTask(): Promise<void> {
        try {
            // 启动 ReAct 循环
            await this.reactEngine.run();
        } catch (error) {
            if (this.status.equals(TaskStatus.PAUSED)) {
                // 暂停导致的中断,不算错误
                return;
            }

            // 处理错误 - 委托给 ErrorHandler
            await this.errorHandler.handleExecutionError(error as Error);
        }
    }

    /**
     * 完成任务 - 委托给 LifecycleManager
     * @param completionData 完成时的额外数据（由工具提供）
     */
    public async completeTask(completionData?: any): Promise<void> {
        const taskState = this.stateManager.getState();
        const tokenUsage = taskState.context?.tokenUsage;

        if (tokenUsage) {
            this.logger.info("TaskExecutor_completeTask_tokenUsage", {
                taskId: this.id,
                totalInputTokens: tokenUsage.totalInputTokens,
                totalOutputTokens: tokenUsage.totalOutputTokens,
                totalTokens: tokenUsage.totalTokens,
                requestCount: tokenUsage.requestCount || 0,
            });
        }
        await this.lifecycleManager.complete(completionData);
    }

    // ============= 消息处理接口实现 (BaseToolMessageHandler) =============

    /**
     * 发送用户消息
     * 支持新增和更新
     * 统一通过 MessageCoordinator 访问
     */
    async sendUserMessage(
        message: UserMessage,
        needPersist: boolean = true
    ): Promise<void> {
        await this.messageCoordinator.sendUserMessage(message, needPersist);
    }

    /**
     * 插入 API 消息
     * 统一通过 MessageCoordinator 访问
     */
    async insertApiMessage(message: ApiMessage): Promise<void> {
        await this.messageCoordinator.insertApiMessage(message);
    }

    // ============= 状态查询 =============

    /**
     * 获取任务状态
     */
    getState(): TaskState {
        return this.stateManager.getState();
    }

    /**
     * 更新子任务ID列表 - Task 接口实现
     * @param subtaskIds 子任务ID列表
     */
    updateSubtaskIds(subtaskIds: string[]): void {
        this.subTaskManager.updateSubtaskIds(subtaskIds);
    }

    /**
     * 从持久化层恢复任务状态 - 委托给 TaskRestoreManager
     * 在恢复状态前，合并 this.context 和恢复的 state.context，确保新传入的字段（如 sandbox、workspace）不被覆盖
     * @param state 要恢复的任务状态
     */
    async restoreFromState(state: TaskState): Promise<void> {
        // 合并 this.context 和恢复的 state.context，确保 this.context.custom 中的字段（如 sandbox、workspace）被保留
        // 使用 deepMerge 进行深度合并，避免嵌套对象被覆盖
        const mergedContext = deepMerge(state.context, this.context);

        // 创建合并后的 state
        const mergedState: TaskState = {
            ...state,
            context: mergedContext,
        };

        // 使用合并后的 state 进行恢复
        await this.taskRestoreManager.restoreFromState(mergedState);
    }

    /**
     * 获取消息历史
     * 将 ApiMessage 转换为 TaskMessage 以符合接口
     * 统一通过 MessageCoordinator 访问
     */
    getMessages(): TaskMessage[] {
        const apiMessages = this.messageCoordinator.getApiMessages();
        return apiMessages.map((msg) => ({
            id: msg.id,
            taskId: msg.taskId,
            role: msg.role as "user" | "assistant" | "system" | "tool",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
            timestamp: new Date(msg.ts || 0),
            metadata: {},
        }));
    }

    // ============= 父子任务关系管理 =============

    /**
     * 设置父任务引用 - Task 接口实现
     * @param parentTask 父任务实例
     */
    setParentTask(parentTask: Task): void {
        this.subTaskManager.setParentTask(parentTask);
    }

    /**
     * 添加子任务 - Task 接口实现
     * @param subTask 子任务实例
     */
    addSubTask(subTask: Task): void {
        this.subTaskManager.addSubTask(subTask);
    }

    /**
     * 创建子任务 - Task 接口实现
     * 委托给 SubTaskManager
     * @param agentName 子Agent名称
     * @param config 子任务配置
     * @returns 创建的子任务实例
     */
    async createSubTask(
        agentName: string,
        config: StartTaskConfig
    ): Promise<Task> {
        return this.subTaskManager.createSubTask(agentName, config);
    }

    /**
     * 处理子任务完成通知 - Task 接口实现
     * @param subTaskId 子任务ID
     * @param result 子任务结果
     */
    async subTaskDone(subTaskId: string, result: SubTaskResult): Promise<void> {
        await this.subTaskManager.subTaskDone(subTaskId, result);
    }

    // ============= Task 接口的其他必需方法 =============

    /**
     * 发送消息给任务
     */
    async sendMessage(message: string): Promise<void> {
        // 添加 API 消息（已自动触发防抖持久化）
        const apiMessage: ApiMessage = {
            id: generateApiMessageId(),
            taskId: this.id,
            role: "user",
            content: message,
            ts: Date.now(),
            source: "user",
        };

        // 统一通过 MessageCoordinator 访问
        await this.messageCoordinator.insertApiMessage(apiMessage);

        // 添加用户消息（UI 展示）
        const userMessage: UserMessage = {
            id: generateUserMessageId(),
            taskId: this.id,
            type: "text",
            role: "user",
            content: message,
            ts: Date.now(),
            metadata: {
                agentName: this.agent.name,
            },
        };

        // 使用防抖持久化（非关键时刻）
        await this.sendUserMessage(userMessage, false);

        // 如果任务正在运行且未在执行,继续执行
        if (this.status === TaskStatus.RUNNING && !this.reactEngine.isExecuting()) {
            await this.executeTask();
        }
    }

    /**
     * 发送工具消息（ToolMessageHandler 接口实现）
     * 使用统一的 ToolInfo 结构
     */
    async sendUserMessageFromTool(toolInfo: ToolInfo): Promise<void> {
        await this.messageCoordinator.sendToolMessage(toolInfo, toolInfo.requestId);
    }

    async insertApiMessageFromTool(message: ApiMessage): Promise<void> {
        await this.insertApiMessage(message);
    }
    /**
     * 清理资源（析构时调用）
     */
    destroy(): void {
        // 清理工具实例
        this.toolManager.cleanup();
        // 清理定时器（统一通过 MessageCoordinator 访问）
        this.messageCoordinator.destroy();
        this.stateManager.destroy();
    }
}