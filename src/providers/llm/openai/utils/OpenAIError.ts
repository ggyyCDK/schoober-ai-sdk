import { AgentSDKError } from '@/types';

/**
 * OpenAI 错误类
 */
export class OpenAIError extends AgentSDKError {
    constructor(
        message: string,
        public code: string,
        public statusCode?: number,
        public details?: any
    ) {
        super(message, code, details);
        this.name = 'OpenAIError';
    }

    /**
     * 从原始错误创建 OpenAIError
     * @param error 原始错误
     * @returns OpenAIError 实例
     */
    static fromError(error: any): OpenAIError {
        // 如果已经是 OpenAIError，直接返回
        if (error instanceof OpenAIError) {
            return error;
        }

        // 处理 OpenAI 库的 APIError（openai 6.15.0）
        // OpenAI.APIError 有 status, code, message 等属性
        if (error?.status && typeof error.status === 'number') {
            const statusCode = error.status;
            const errorMessage = error.message || 'API request failed';
            const errorCode = error.code || this.getErrorCode(statusCode);

            return new OpenAIError(
                errorMessage,
                errorCode,
                statusCode,
                {
                    type: error.type,
                    param: error.param,
                    code: error.code,
                    originalError: error,
                }
            );
        }

        // 处理旧的 API 错误格式（兼容性）
        if (error.response) {
            const statusCode = error.response.status;
            const data = error.response.data;

            return new OpenAIError(
                data?.error?.message || error.message || 'API request failed',
                this.getErrorCode(statusCode),
                statusCode,
                {
                    type: data?.error?.type,
                    param: data?.error?.param,
                    code: data?.error?.code,
                    originalError: error,
                }
            );
        }

        // 处理网络错误
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return new OpenAIError(
                'Failed to connect to OpenAI API',
                'NETWORK_ERROR',
                undefined,
                { originalError: error }
            );
        }

        // 处理超时错误
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            return new OpenAIError(
                'Request timeout',
                'TIMEOUT_ERROR',
                undefined,
                { originalError: error }
            );
        }

        // 处理速率限制
        if (error.message?.includes('rate limit')) {
            return new OpenAIError(
                'Rate limit exceeded',
                'RATE_LIMIT_ERROR',
                429,
                { originalError: error }
            );
        }

        // 处理配额超限
        if (error.message?.includes('quota') || error.message?.includes('insufficient')) {
            return new OpenAIError(
                'Quota exceeded or insufficient credits',
                'QUOTA_ERROR',
                402,
                { originalError: error }
            );
        }

        // 处理无效 API 密钥
        if (error.message?.includes('api key') || error.message?.includes('authentication')) {
            return new OpenAIError(
                'Invalid API key',
                'AUTH_ERROR',
                401,
                { originalError: error }
            );
        }

        // 默认错误
        return new OpenAIError(
            error.message || 'Unknown error occurred',
            'UNKNOWN_ERROR',
            undefined,
            { originalError: error }
        );
    }

    /**
     * 根据状态码获取错误代码
     * @param statusCode HTTP 状态码
     * @returns 错误代码
     */
    private static getErrorCode(statusCode: number): string {
        switch (statusCode) {
            case 400:
                return 'BAD_REQUEST';
            case 401:
                return 'AUTH_ERROR';
            case 402:
                return 'PAYMENT_REQUIRED';
            case 403:
                return 'FORBIDDEN';
            case 404:
                return 'NOT_FOUND';
            case 409:
                return 'CONFLICT';
            case 422:
                return 'UNPROCESSABLE_ENTITY';
            case 429:
                return 'RATE_LIMIT_ERROR';
            case 500:
                return 'INTERNAL_SERVER_ERROR';
            case 502:
                return 'BAD_GATEWAY';
            case 503:
                return 'SERVICE_UNAVAILABLE';
            case 504:
                return 'GATEWAY_TIMEOUT';
            default:
                return 'API_ERROR';
        }
    }

    /**
     * 检查错误是否可重试
     * @returns 是否可重试
     */
    isRetryable(): boolean {
        // 可重试的错误代码
        const retryableCodes = [
            'NETWORK_ERROR',
            'TIMEOUT_ERROR',
            'RATE_LIMIT_ERROR',
            'INTERNAL_SERVER_ERROR',
            'BAD_GATEWAY',
            'SERVICE_UNAVAILABLE',
            'GATEWAY_TIMEOUT',
        ];

        return retryableCodes.includes(this.code);
    }

    /**
     * 获取重试延迟时间（毫秒）
     * @param attempt 当前尝试次数
     * @returns 延迟时间
     */
    getRetryDelay(attempt: number): number {
        // 速率限制错误使用更长的延迟
        if (this.code === 'RATE_LIMIT_ERROR') {
            // 检查是否有 Retry-After 头
            const retryAfter = this.details?.retryAfter;
            if (retryAfter) {
                return retryAfter * 1000;
            }
            // 使用指数退避，起始延迟 5 秒
            return Math.min(5000 * Math.pow(2, attempt - 1), 60000);
        }

        // 其他错误使用标准指数退避
        return Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    }

    /**
     * 获取用户友好的错误消息
     * @returns 用户友好的消息
     */
    getUserMessage(): string {
        switch (this.code) {
            case 'AUTH_ERROR':
                return '认证失败：请检查您的 API 密钥是否正确。';
            case 'RATE_LIMIT_ERROR':
                return '请求过于频繁，请稍后再试。';
            case 'QUOTA_ERROR':
                return '配额已用尽或余额不足，请检查您的账户。';
            case 'NETWORK_ERROR':
                return '网络连接失败，请检查您的网络设置。';
            case 'TIMEOUT_ERROR':
                return '请求超时，请稍后重试。';
            case 'BAD_REQUEST':
                return '请求参数错误，请检查输入内容。';
            case 'SERVICE_UNAVAILABLE':
                return 'OpenAI 服务暂时不可用，请稍后再试。';
            default:
                return this.message;
        }
    }

    /**
     * 转换为 JSON
     * @returns JSON 对象
     */
    toJSON(): Record<string, any> {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            statusCode: this.statusCode,
            details: this.details,
            userMessage: this.getUserMessage(),
            isRetryable: this.isRetryable(),
        };
    }
}