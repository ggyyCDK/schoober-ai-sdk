/**
 * 完成任务工具
 * 系统级工具，用于标记任务完成并展示最终结果
 */

import { z } from 'zod';
import { BaseTool } from './BaseTool';
import type { ToolDescription, ToolContext, ToolResult } from '@/types';
import { ToolStatus } from '@/types';

/**
 * 任务完成参数
 */
const AttemptCompletionParams = z.object({
    /** 任务完成结果描述 */
    result: z.string().describe('任务的最终结果。请用清晰、完整的方式描述你完成的工作，不要以问题或提供进一步帮助结尾。'),
});

/**
 * 完成任务工具
 * 
 * 这是一个系统级工具，用于明确标记任务完成。
 * 只有当 LLM 调用此工具时，任务才会被标记为完成。
 */
export class AttemptCompletionTool extends BaseTool {
    name = 'attempt_completion';
    displayName = '完成任务';

    async getDescription(): Promise<ToolDescription> {
        return {
            displayName: '完成任务',
            description: '在完成任务后使用此工具来展示最终结果。你应该在确认任务已经完成后调用此工具，并提供一个清晰的结果描述。不要在结果中包含问题或提供进一步帮助的内容。注意，这个工具必须单独调用，不能和其他工具同时出现在你的返回中。这非常重要。',
            category: 'system',
            examples: [
                '<attempt_completion>\n<result>\n我已经完成了天气查询功能的开发，包括API集成和错误处理。\n</result>\n</attempt_completion>',
                '<attempt_completion>\n<result>\n已成功更新配置文件，添加了新的环境变量设置。\n</result>\n</attempt_completion>',
            ],
            isDangerous: false,
        };
    }

    async getParameters(): Promise<z.ZodSchema> {
        return AttemptCompletionParams;
    }

    async execute(
        params: z.infer<typeof AttemptCompletionParams>,
        context: ToolContext,
        isPartial: boolean
    ): Promise<void> {
        // 等待状态：参数正在解析
        if (isPartial) {
            await this.sendToolStatus(context.requestId, ToolStatus.WAIT, {
                showTip: '正在生成完成结果...',
                params: { result: params.result || '' },
            });
            // partial 时不需要设置 API 结果
            return;
        }

        // 执行中状态：准备完成任务
        await this.sendToolStatus(context.requestId, ToolStatus.DOING, {
            showTip: '正在完成任务...',
            params,
        });

        // 验证参数
        if (!params.result) {
            const errorMessage = '缺少必需参数：result';

            await this.sendToolStatus(context.requestId, ToolStatus.ERROR, {
                error: errorMessage,
            });

            // 必须：插入错误消息用于LLM
            await this.setToolResult(context.requestId, JSON.stringify({
                error: errorMessage,
                success: false,
            }));

            return;
        }

        try {
            // 发送成功状态
            await this.sendToolStatus(context.requestId, ToolStatus.SUCCESS, {
                result: { result: params.result },
                metadata: { isCompletion: true },
            });

            // 必须：将结果添加到 API 消息历史
            await this.setToolResult(context.requestId, `任务已完成`);

            this.log('info', 'execute_completionRequested', {
                result: params.result
            });

            // 主动调用 TaskExecutor 完成任务
            if (this.taskExecutor) {
                await this.taskExecutor.completeTask({ result: params.result });
            }

        } catch (error) {
            const errorMessage = `完成任务时发生错误：${error instanceof Error ? error.message : 'Unknown error'}`;

            await this.sendToolStatus(context.requestId, ToolStatus.ERROR, {
                error: errorMessage,
            });

            // 必须：插入错误消息用于LLM
            await this.setToolResult(context.requestId, JSON.stringify({
                error: errorMessage,
                success: false,
            }));

            this.log('error', 'execute_completionFailed', {
                error
            });
        }
    }
}