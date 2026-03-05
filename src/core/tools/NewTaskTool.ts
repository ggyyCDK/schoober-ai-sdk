/**
 * NewTask工具
 * 用于创建和执行子任务
 */

import { z } from 'zod';
import { BaseTool } from './BaseTool';
import {
    ToolDescription,
    ToolContext,
    TaskStatus,
    ToolStatus,
    AgentSDKError,
    ErrorCode,
    SubTaskResult,
} from '@/types';

/**
 * NewTask工具参数
 */
const NewTaskParamsSchema = z.object({
    agentName: z.string().describe('子Agent名称'),
    taskName: z.string().describe('子任务名称'),
    input: z.string().describe('子任务输入内容'),
});

type NewTaskParams = z.infer<typeof NewTaskParamsSchema>;

/**
 * NewTask工具实现
 * 
 * 功能：
 * 1. 创建子任务
 * 2. 修改父任务状态为 WAITING_FOR_SUBTASK
 * 3. 启动子任务（不阻塞等待）
 * 4. 子任务完成时通过回调更新工具状态和结果
 * 5. 返回子任务结果
 * 
 * requestId约定：使用 "new_task_${subTaskId}" 格式，便于从子任务ID反推requestId
 */
export class NewTaskTool extends BaseTool {
    name = 'new_task';
    displayName = '创建子任务';

    /**
     * 从子任务ID构建requestId
     * @param subTaskId 子任务ID
     * @returns requestId
     */
    private getRequestIdFromSubTaskId(subTaskId: string): string {
        return `sub_task_${subTaskId}`;
    }

    /**
     * 子任务完成回调
     * 由TaskExecutor.subTaskDone调用
     * @param subTaskId 子任务ID
     * @param result 子任务结果
     */
    async onSubTaskDone(subTaskId: string, result: SubTaskResult): Promise<void> {
        // 从子任务ID构建requestId（使用约定格式）
        const requestId = this.getRequestIdFromSubTaskId(subTaskId);

        this.log('info', 'onSubTaskDone_completed', {
            subTaskId,
            success: result.success,
            summary: result.summary,
            requestId,
        });

        try {
            // 使用子任务结果中的 subtaskId 来显示任务名称
            // 由于子任务实例可能已经不在缓存中，我们直接使用传入的 subTaskId
            const taskName = '子任务';

            // 更新工具状态：成功或失败
            await this.sendToolStatus(
                requestId,
                result.success ? ToolStatus.SUCCESS : ToolStatus.ERROR,
                {
                    showTip: result.success
                        ? `子任务「${taskName}」执行成功`
                        : `子任务「${taskName}」执行失败`,
                    result: {
                        success: result.success,
                        summary: result.summary,
                        subtaskId: result.subtaskId,
                        error: result.error,
                    },
                    error: result.error,
                }
            );

            // 将子任务结果作为工具结果返回（供LLM使用）
            await this.setToolResult(requestId, JSON.stringify(result));
        } catch (error) {
            this.log('error', 'onSubTaskDone_updateToolStatusFailed', {
                subTaskId,
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async getDescription(): Promise<ToolDescription> {
        return {
            displayName: this.displayName,
            description: '创建并执行一个子任务。子任务将由指定的子Agent执行，父任务会等待子任务完成后继续执行。',
            category: 'task_management',
            tags: ['subtask', 'delegation', 'agent'],
            examples: [
                '<new_task>\n<agentName>codeAgent</agentName>\n<taskName>实现用户登录功能</taskName>\n<input>请实现一个用户登录功能，包括用户名密码验证和JWT token生成</input>\n</new_task>',
                '<new_task>\n<agentName>dataAgent</agentName>\n<taskName>查询用户统计数据</taskName>\n<input>查询最近30天的用户注册数量和活跃用户数</input>\n</new_task>',
            ],
        };
    }

    async getParameters(): Promise<z.ZodSchema> {
        return NewTaskParamsSchema;
    }

    async execute(
        params: NewTaskParams,
        context: ToolContext,
        isPartial: boolean
    ): Promise<void> {

        const subTaskRequestId = this.getRequestIdFromSubTaskId(context.requestId);

        // 处理部分参数（参数解析中）
        if (isPartial) {
            await this.sendToolStatus(subTaskRequestId, ToolStatus.WAIT, {
                showTip: '正在创建子任务...',
                params,
            });
            return;
        }

        try {
            // 1. 获取父任务
            const parentTask = this.taskExecutor;
            if (!parentTask) {
                throw new AgentSDKError(
                    ErrorCode.VALIDATION_ERROR,
                    'NewTask tool must be executed within a task context'
                );
            }

            this.log('info', 'execute_creatingSubtask', {
                parentTaskId: parentTask.id,
                subAgentName: params.agentName,
                subTaskId: subTaskRequestId,
                taskName: params.taskName,
            });

            // 2. 发送工具状态：准备中（使用统一的 requestId）
            await this.sendToolStatus(subTaskRequestId, ToolStatus.DOING, {
                showTip: `正在创建子任务「${params.taskName}」...`,
                params: {
                    agentName: params.agentName,
                    taskName: params.taskName,
                },
            });

            // 3. 修改父任务状态为 WAITING_FOR_SUBTASK
            await parentTask.setStatus(TaskStatus.WAITING_FOR_SUBTASK);
            this.log('info', 'execute_statusChanged', {
                parentTaskId: parentTask.id,
                newStatus: 'WAITING_FOR_SUBTASK'
            });

            // 4. 通过 TaskExecutor.createSubTask 创建子任务（委托给 SubTaskManager）
            const subTask = await parentTask.createSubTask(
                params.agentName,
                {
                    id: subTaskRequestId,  // 传入预生成的ID
                    name: params.taskName,
                    input: { message: params.input },
                    parentId: parentTask.id,
                }
            );

            this.log('info', 'execute_subtaskCreated', {
                parentTaskId: parentTask.id,
                subTaskId: subTask.id,
            });

            // 5. 更新工具状态：子任务已创建，等待执行（使用统一的 requestId）
            await this.sendToolStatus(subTaskRequestId, ToolStatus.DOING, {
                showTip: `子任务「${params.taskName}」已创建，正在执行...`,
                metadata: {
                    subTaskId: subTask.id,
                    status: 'executing',
                },
            });

            // 8. 启动子任务（异步启动，不阻塞等待）
            // 注意：即使创建时传递了input，start时也需要再传一次以确保子任务能正确接收
            subTask.start({ message: params.input }).catch(error => {
                this.log('error', 'execute_startSubtaskFailed', {
                    error: error instanceof Error ? error.message : String(error),
                    subTaskId: subTask.id,
                });
            });
            this.log('info', 'execute_subtaskStarted', {
                subTaskId: subTask.id
            });

            // 注意：子任务已异步启动，工具执行在这里返回，不阻塞等待子任务完成
            // 子任务完成时，会通过父任务的subTaskDone方法触发状态恢复
            // 然后通过onSubTaskDone回调通知NewTaskTool更新工具结果
            // requestId使用约定的格式（new_task_${subTaskId}），便于从子任务ID反推

        } catch (error) {
            const errorMessage = `子任务执行失败：${error instanceof Error ? error.message : 'Unknown error'}`;

            this.log('error', 'execute_error', {
                error: error instanceof Error ? error.stack : error,
                errorMessage,
                params,
            });

            // 尝试恢复父任务状态
            try {
                if (this.taskExecutor) {
                    await this.taskExecutor.setStatus(TaskStatus.RUNNING);
                }
            } catch (restoreError) {
                this.log('error', 'execute_restoreStatusFailed', {
                    error: restoreError,
                });
            }

            // 发送工具状态：失败（使用统一的 requestId）
            await this.sendToolStatus(subTaskRequestId, ToolStatus.ERROR, {
                showTip: errorMessage,
                error: errorMessage,
            });

            // 设置API消息结果（使用统一的 requestId）
            await this.setToolResult(
                subTaskRequestId,
                JSON.stringify({
                    success: false,
                    summary: '',
                    subtaskId: '',
                    error: errorMessage,
                })
            );
        }
    }
}