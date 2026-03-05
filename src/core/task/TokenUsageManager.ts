/**
 * Token 使用统计管理器接口和实现
 * 负责管理任务的 Token 使用统计
 */

import {
    TaskTokenUsage,
    ILogger,
} from '@/types';
import { StateManager } from './StateManager';

/**
 * Token 使用统计管理器配置
 */
export interface TokenUsageManagerConfig {
    /** 状态管理器 */
    stateManager: StateManager;
    /** 日志记录器 */
    logger: ILogger;
    /** 任务ID */
    taskId: string;
}

/**
 * Token 使用统计管理器接口
 */
export interface ITokenUsageManager {
    updateTokenUsage(inputTokens: number, outputTokens: number): Promise<void>;
    getTokenUsage(): TaskTokenUsage | undefined;
    resetTokenUsage(): void;
}

/**
 * Token 使用统计管理器实现
 */
export class TokenUsageManager implements ITokenUsageManager {
    private stateManager: StateManager;
    private logger: ILogger;
    private taskId: string;

    constructor(config: TokenUsageManagerConfig) {
        this.stateManager = config.stateManager;
        this.logger = config.logger;
        this.taskId = config.taskId;
    }

    /**
     * 更新 Token 使用情况
     */
    async updateTokenUsage(inputTokens: number, outputTokens: number): Promise<void> {
        const currentState = this.stateManager.getState();
        const currentUsage = currentState.context.tokenUsage || {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            lastRequestInputTokens: 0,
            requestCount: 0,
        };

        const updatedUsage: TaskTokenUsage = {
            totalInputTokens: currentUsage.totalInputTokens + inputTokens,
            totalOutputTokens: currentUsage.totalOutputTokens + outputTokens,
            totalTokens: currentUsage.totalTokens + inputTokens + outputTokens,
            lastRequestInputTokens: inputTokens,
            requestCount: (currentUsage.requestCount || 0) + 1,
        };

        this.logger.info("TokenUsageManager_updateTokenUsage_success", {
            taskId: this.taskId,
            requestCount: updatedUsage.requestCount,
            inputTokens,
            outputTokens,
            totalInputTokens: updatedUsage.totalInputTokens,
            totalOutputTokens: updatedUsage.totalOutputTokens,
            totalTokens: updatedUsage.totalTokens
        });

        this.stateManager.updateState({
            context: {
                ...currentState.context,
                tokenUsage: updatedUsage,
            },
        });
    }

    /**
     * 获取 Token 使用情况
     */
    getTokenUsage(): TaskTokenUsage | undefined {
        const currentState = this.stateManager.getState();
        return currentState.context.tokenUsage;
    }

    /**
     * 重置 Token 使用统计
     */
    resetTokenUsage(): void {
        const currentState = this.stateManager.getState();
        this.stateManager.updateState({
            context: {
                ...currentState.context,
                tokenUsage: {
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                    totalTokens: 0,
                    lastRequestInputTokens: 0,
                    requestCount: 0,
                },
            },
        });
        this.logger.debug("TokenUsageManager_resetTokenUsage_success", {
            taskId: this.taskId
        });
    }
}

/**
 * 创建 Token 使用统计管理器
 */
export function createTokenUsageManager(config: TokenUsageManagerConfig): TokenUsageManager {
    return new TokenUsageManager(config);
}