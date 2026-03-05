import {

    Agent as IAgent,

    AgentConfig,

    CompressionConfig,

    Task,

    StartTaskConfig,

    TaskState,

    TaskContext,

    Tool,

    ToolRegistry,

    ToolConstructor,

    ToolRegistration,

    ToolFactory,

    LLMProvider,

    PersistenceManager,

    MessageParser,

    ValidationError,

    TaskCallbacks,

    RolePromptBuilder,

    EnvironmentPromptBuilder,

    ILogger,

    createDefaultLogger,

} from '@/types';

import { TaskExecutor } from '../task/TaskExecutor';

import { DefaultToolRegistry } from '../tools/ToolRegistry';

import { buildSystemPrompt, generateToolsPrompt, generateSubAgentsPrompt } from '../../prompts';

import { generateTaskId } from '../utils/idGenerator';

import { deepMerge } from '../utils/deepMerge';

import { SDKMessageParser } from '../parser/MessageParser';



/**

* Agent 实现

* 提供完整的Agent功能，包括任务管理、工具管理等

*/

export class Agent implements IAgent {

    public readonly name: string;

    public readonly description?: string;



    private config: AgentConfig;

    public readonly toolRegistry: ToolRegistry;

    private baseSystemPrompt: string;

    private rolePromptBuilder?: RolePromptBuilder;

    private environmentPromptBuilder?: EnvironmentPromptBuilder;

    private metadata: Record<string, any> = {};

    private messageParser?: MessageParser;

    private logger: ILogger;

    // 子Agent管理

    private subAgents: Map<string, IAgent> = new Map();



    constructor(config: AgentConfig) {

        this.name = config.name;

        this.description = config.description;

        this.config = config;



        // 构建基础系统提示词，使用 Agent 的 description 作为角色定义

        // 如果提供了 coreSystemPrompt，则使用它覆盖默认的核心提示词

        this.baseSystemPrompt = buildSystemPrompt(config.description, config.coreSystemPrompt);



        // 角色提示词构建函数（用于动态生成额外的角色相关提示词）

        this.rolePromptBuilder = config.rolePromptBuilder;



        // 环境变量提示词构建函数（用于动态生成环境变量提示词）

        this.environmentPromptBuilder = config.environmentPromptBuilder;



        this.metadata = config.metadata || {};

        // 使用配置中的 messageParser 或默认的 SDKMessageParser

        this.messageParser = config.messageParser || new SDKMessageParser();



        // 初始化日志记录器，使用配置中的 logger 或默认的 console logger

        this.logger = config.logger || createDefaultLogger();



        // 初始化工具注册表

        this.toolRegistry = new DefaultToolRegistry();



        // 初始化子Agent

        if (config.subAgents) {

            for (const [name, agent] of Object.entries(config.subAgents)) {

                this.subAgents.set(name, agent);

            }

            this.logger.info("Agent_init_subAgentsRegistered", {

                agentName: this.name,

                subAgentCount: this.subAgents.size

            });

        }

    }



    // ============= 任务管理 =============



    /**
    
    * 创建新任务
    
    * Agent 只负责创建任务，不管理任务的生命周期
    
    * 任务的状态由持久化层管理
    
    * @param config 任务配置
    
    * @param context 任务上下文
    
    * @param callbacks 可选的回调配置
    
    */

    async createTask(config: StartTaskConfig, context: TaskContext, callbacks?: TaskCallbacks): Promise<Task> {



        if (!this.messageParser) {

            throw new ValidationError('Message parser is required to create tasks');

        }



        // 生成或使用提供的 taskId

        const taskId = config.id || generateTaskId();



        // 合并配置，确保包含必需的 name 字段和 id

        const fullConfig: StartTaskConfig = {

            ...config,

            id: taskId,

            name: config.name || 'Unnamed Task',

            agentName: this.name,

        };



        // 创建任务执行器，传入 Agent 对象、context 和 logger

        const taskExecutor = new TaskExecutor(this, fullConfig, context, callbacks, taskId);



        // 如果配置中有input，保存到持久化层

        if (fullConfig.input && this.config.persistence) {

            await this.config.persistence.saveTaskInput(taskExecutor.id, fullConfig.input);

        }



        // 保存初始状态到持久化层

        if (this.config.persistence) {

            await this.config.persistence.saveTaskState(taskExecutor.id, taskExecutor.getState());

        }



        return taskExecutor;

    }



    /**
    
    * 从持久化层恢复任务实例
    
    * @param taskId 任务ID
    
    * @param context 可选的任务上下文（如果提供，会覆盖持久化层的 context）
    
    * @param callbacks 可选的回调配置
    
    * @returns 任务实例或 undefined
    
    */

    async loadTask(taskId: string, context?: TaskContext, callbacks?: TaskCallbacks): Promise<Task | undefined> {



        if (!this.config.persistence) {

            throw new ValidationError('Persistence manager is required to restore tasks');

        }



        if (!this.messageParser) {

            throw new ValidationError('Message parser is required to restore tasks');

        }



        // 从持久化层加载任务状态

        const taskState = await this.config.persistence.loadTaskState(taskId);

        if (!taskState) {

            return undefined;

        }



        // 加载任务输入

        const taskInput = await this.config.persistence.loadTaskInput(taskId);



        // 重建任务配置，确保包含 taskId

        const taskConfig: StartTaskConfig = {

            ...taskState.config,

            id: taskId, // 确保使用正确的 taskId

            input: taskInput || undefined,

        };



        // 获取任务上下文（优先使用传入的 context，否则使用持久化的 context）

        // 使用深度合并，避免嵌套对象被覆盖

        const taskContext: TaskContext = deepMerge(taskState.context, context);



        this.logger.info("Agent_getTask_taskContext", {

            agentName: this.name,

            taskId,

            taskConfig,

            taskContext,

            preContext: context

        });

        // 创建新的任务执行器实例，传入 Agent 对象和 context

        const taskExecutor = new TaskExecutor(this, taskConfig, taskContext, callbacks, taskId);



        // 从持久化层恢复状态

        await taskExecutor.restoreFromState(taskState);



        return taskExecutor;

    }



    // ============= 工具管理 =============



    /**
    
    * 注册工具
    
    * 支持两种方式：
    
    * 1. 直接传入工具类：registerTool(ToolClass) - 默认使用 new ToolClass() 实例化
    
    * 2. 传入配置对象：registerTool({ name, factory }) - 使用自定义工厂函数
    
    */

    registerTool(tool: ToolConstructor | ToolRegistration): void {

        if (typeof tool === 'function') {

            // 方式1：直接传入工具类

            const ToolClass = tool;

            // 创建临时实例以获取工具名称

            const tempInstance = new ToolClass();

            const name = tempInstance.name;

            if (!name) {

                throw new ValidationError('Tool class must have a name property');

            }



            // 创建默认工厂函数

            const factory: ToolFactory = async (context) => {

                return new ToolClass();

            };



            this.toolRegistry.registerFactory(name, factory);

        } else {

            // 方式2：传入配置对象

            const config = tool as ToolRegistration;

            if (!config.name || !config.factory) {

                throw new ValidationError('ToolRegistration must have name and factory');

            }

            this.toolRegistry.registerFactory(config.name, config.factory);

        }

    }



    /**
    
    * 批量注册工具
    
    */

    registerTools(tools: (ToolConstructor | ToolRegistration)[]): void {

        for (const tool of tools) {

            this.registerTool(tool);

        }

    }



    /**
    
    * 注销工具
    
    */

    unregisterTool(name: string): void {

        this.toolRegistry.unregister(name);

    }



    /**
    
    * 获取所有已注册的工具（用于生成prompt）
    
    */

    async getTools(): Promise<Tool[]> {

        return await this.toolRegistry.list();

    }



    /**
    
    * 根据名称获取工具（用于生成prompt）
    
    */

    async getTool(name: string): Promise<Tool | undefined> {

        return await this.toolRegistry.get(name);

    }



    /**
    
    * 检查工具是否已注册
    
    */

    hasTool(name: string): boolean {

        return this.toolRegistry.has(name);

    }




    /**
    
    * 销毁Agent，清理资源
    
    */

    dispose(): void {

        // 清理工具注册表

        this.toolRegistry.clear();



    }



    // ============= 配置访问 =============



    /**
    
    * 获取LLM提供者
    
    */

    getLLMProvider(): LLMProvider {

        return this.config.llmProvider;

    }



    /**
    
    * 获取消息解析器
    
    */

    getMessageParser(): MessageParser {

        if (!this.messageParser) {

            throw new ValidationError('Message parser is not initialized');

        }

        return this.messageParser;

    }



    /**
    
    * 获取持久化管理器
    
    */

    getPersistenceManager(): PersistenceManager | undefined {

        return this.config.persistence;

    }



    /**
    
    * 构建系统提示词（根据任务状态动态生成）
    
    * 组合顺序：baseSystemPrompt -> rolePromptBuilder 输出 -> 工具定义 -> 子Agent信息
    
    * @param taskState 任务状态
    
    * @param additionalTools 额外的工具列表（如系统工具），将与 Agent 注册的工具合并
    
    * @returns 系统提示词
    
    */

    async buildSystemPrompt(taskState: TaskState, additionalTools?: Tool[]): Promise<string> {

        // 1. 从基础系统提示词开始（包含角色定义）

        let composedPrompt = this.baseSystemPrompt;



        // 2. 追加角色提示词构建函数的输出（如果有）

        if (this.rolePromptBuilder) {

            const rolePrompt = await this.rolePromptBuilder(taskState);

            if (rolePrompt && rolePrompt.trim().length > 0) {

                composedPrompt = `${composedPrompt}\n\n${rolePrompt}`;

            }

        }



        // 3. 追加工具定义（合并 Agent 注册的工具和系统工具）

        // 用户注册的工具会覆盖同名的系统工具（提示词和执行都使用用户工具）

        const registeredTools = await this.toolRegistry.list();

        const registeredToolNames = new Set(registeredTools.map((t: Tool) => t.name));

        // 过滤掉被用户覆盖的系统工具

        const filteredAdditionalTools = additionalTools

            ? additionalTools.filter(t => !registeredToolNames.has(t.name))

            : [];

        // 合并：过滤后的系统工具 + 用户注册的工具

        const allTools = [...filteredAdditionalTools, ...registeredTools];

        if (allTools.length > 0) {

            const toolsPrompt = await generateToolsPrompt(allTools);

            if (toolsPrompt && toolsPrompt.trim().length > 0) {

                composedPrompt = `${composedPrompt}\n\n${toolsPrompt}`;

            }

        }



        // 4. 追加子Agent信息（如果有子Agent）

        if (this.subAgents.size > 0) {

            const subAgentsPrompt = await generateSubAgentsPrompt(this.subAgents);

            if (subAgentsPrompt && subAgentsPrompt.trim().length > 0) {

                composedPrompt = `${composedPrompt}\n\n${subAgentsPrompt}`;

            }

        }



        return composedPrompt;

    }



    /**
    
    * 构建环境变量提示词（根据任务状态动态生成）
    
    * @param taskState 任务状态
    
    * @returns 环境变量提示词
    
    */

    async buildEnvironmentPrompt(taskState: TaskState): Promise<string> {

        if (this.environmentPromptBuilder) {

            const envPrompt = await this.environmentPromptBuilder(taskState);

            return envPrompt || '';

        }

        return '';

    }



    /**
    
    * 设置消息解析器
    
    */

    setMessageParser(parser: MessageParser): void {

        this.messageParser = parser;

    }



    /**
    
    * 获取元数据
    
    */

    getMetadata(): Record<string, any> {

        return { ...this.metadata };

    }



    /**
    
    * 更新元数据
    
    */

    updateMetadata(metadata: Record<string, any>): void {

        this.metadata = { ...this.metadata, ...metadata };

    }



    /**
    
    * 获取日志记录器
    
    */

    getLogger(): ILogger {

        return this.logger;

    }



    /**
    
    * 获取压缩配置
    
    */

    getCompressionConfig(): CompressionConfig | undefined {

        return this.config.compressionConfig;

    }



    // ============= 子Agent管理 =============



    /**
    
    * 获取子Agent
    
    * @param name 子Agent名称
    
    * @returns 子Agent实例或undefined
    
    */

    getSubAgent(name: string): IAgent | undefined {

        return this.subAgents.get(name);

    }



    // ============= 静态工厂方法 =============



    /**
    
    * 创建Agent实例
    
    */

    static async create(config: AgentConfig): Promise<Agent> {

        const agent = new Agent(config);

        return agent;

    }



}




// 导出别名以保持向后兼容

export type { Agent as SDKAgent };