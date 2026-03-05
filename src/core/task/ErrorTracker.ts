/**
 * 错误追踪器
 * 用于追踪和统计任务执行过程中的错误
 * 支持检测相同错误的重复出现
 */

/**
 * 错误记录
 */
interface ErrorRecord {
    /** 错误签名 */
    signature: string;
    /** 出现次数 */
    count: number;
    /** 首次出现时间 */
    firstOccurrence: Date;
    /** 最后出现时间 */
    lastOccurrence: Date;
    /** 错误消息 */
    message: string;
    /** 错误堆栈 */
    stack?: string;
}

/**
 * 错误追踪器配置
 */
export interface ErrorTrackerConfig {
    /** 相同错误的最大重复次数 */
    maxSameErrorCount?: number;
    /** 错误签名算法 */
    signatureAlgorithm?: 'simple' | 'detailed';
    /** 是否记录错误堆栈 */
    recordStack?: boolean;
    /** 日志记录器（可选） */
    logger?: import('@/types').ILogger;
}

/**
 * 错误追踪器
 */
export class ErrorTracker {
    private errorHistory: Map<string, ErrorRecord> = new Map();
    private maxSameErrorCount: number;
    private signatureAlgorithm: 'simple' | 'detailed';
    private recordStack: boolean;
    private logger?: import('@/types').ILogger;

    constructor(config: ErrorTrackerConfig = {}) {
        this.maxSameErrorCount = config.maxSameErrorCount ?? 3;
        this.signatureAlgorithm = config.signatureAlgorithm ?? 'simple';
        this.recordStack = config.recordStack ?? true;
        this.logger = config.logger;
    }

    /**
     * 追踪错误
     * @param error 错误对象
     * @returns 是否应该暂停任务（相同错误出现次数达到上限）
     */
    trackError(error: Error): boolean {
        const signature = this.getErrorSignature(error);
        const record = this.errorHistory.get(signature);

        if (record) {
            // 更新已有记录
            record.count++;
            record.lastOccurrence = new Date();
            this.errorHistory.set(signature, record);

            // 检查是否达到上限
            return record.count >= this.maxSameErrorCount;
        } else {
            // 创建新记录
            const now = new Date();
            this.errorHistory.set(signature, {
                signature,
                count: 1,
                firstOccurrence: now,
                lastOccurrence: now,
                message: error.message,
                stack: this.recordStack ? error.stack : undefined,
            });

            return false;
        }
    }

    /**
     * 获取错误签名
     * @param error 错误对象
     * @returns 错误签名字符串
     */
    private getErrorSignature(error: Error): string {
        if (this.signatureAlgorithm === 'simple') {
            // 简单算法：使用错误名称和消息
            return `${error.name}:${error.message}`;
        } else {
            // 详细算法：使用错误名称、消息和部分堆栈
            const stackLines = error.stack?.split('\n').slice(0, 3).join('\n') || '';
            return `${error.name}:${error.message}:${stackLines}`;
        }
    }

    /**
     * 获取错误记录
     * @param signature 错误签名
     * @returns 错误记录或undefined
     */
    getErrorRecord(signature: string): ErrorRecord | undefined {
        return this.errorHistory.get(signature);
    }

    /**
     * 获取错误出现次数
     * @param error 错误对象
     * @returns 出现次数
     */
    getErrorCount(error: Error): number {
        const signature = this.getErrorSignature(error);
        return this.errorHistory.get(signature)?.count || 0;
    }

    /**
     * 获取所有错误记录
     * @returns 错误记录数组
     */
    getAllErrorRecords(): ErrorRecord[] {
        return Array.from(this.errorHistory.values());
    }

    /**
     * 获取最频繁的错误
     * @param limit 返回的最大数量
     * @returns 错误记录数组（按出现次数降序）
     */
    getMostFrequentErrors(limit: number = 10): ErrorRecord[] {
        return Array.from(this.errorHistory.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    /**
     * 重置所有错误记录
     */
    reset(): void {
        this.errorHistory.clear();
    }

    /**
     * 重置特定错误的记录
     * @param error 错误对象
     */
    resetError(error: Error): void {
        const signature = this.getErrorSignature(error);
        this.errorHistory.delete(signature);
    }

    /**
     * 获取错误统计
     * @returns 错误统计信息
     */
    getStatistics(): {
        totalErrors: number;
        uniqueErrors: number;
        maxErrorCount: number;
        averageErrorCount: number;
    } {
        const records = Array.from(this.errorHistory.values());
        const totalErrors = records.reduce((sum, record) => sum + record.count, 0);
        const uniqueErrors = records.length;
        const maxErrorCount = Math.max(...records.map(r => r.count), 0);
        const averageErrorCount = uniqueErrors > 0 ? totalErrors / uniqueErrors : 0;

        return {
            totalErrors,
            uniqueErrors,
            maxErrorCount,
            averageErrorCount,
        };
    }

    /**
     * 导出错误历史
     * @returns 错误历史的JSON表示
     */
    export(): string {
        return JSON.stringify(
            Array.from(this.errorHistory.entries()),
            null,
            2
        );
    }

    /**
     * 导入错误历史
     * @param json 错误历史的JSON字符串
     */
    import(json: string): void {
        try {
            const entries = JSON.parse(json);
            this.errorHistory = new Map(entries);
        } catch (error) {
            throw new Error(`Failed to import error history: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}

/**
 * 创建错误追踪器
 * @param config 配置选项
 * @returns 错误追踪器实例
 */
export function createErrorTracker(config?: ErrorTrackerConfig): ErrorTracker {
    return new ErrorTracker(config);
}