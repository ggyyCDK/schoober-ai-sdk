/**
 * 消息验证工具函数
 * 用于检查 ApiMessage 的 content 是否为空
 */

import { ApiMessage } from '@/types';
import Anthropic from '@anthropic-ai/sdk';

/**
 * 检查消息 content 是否为空
 * @param content - 消息内容，可能是 string 或 ContentBlockParam[]
 * @returns true 如果 content 为空，false 如果 content 有内容
 */
export function isContentEmpty(content: string | Anthropic.ContentBlockParam[] | undefined | null): boolean {
    if (content === undefined || content === null) {
        return true;
    }

    // 字符串类型：检查 trim 后长度
    if (typeof content === 'string') {
        return content.trim().length === 0;
    }

    // ContentBlockParam[] 类型：检查数组长度
    if (Array.isArray(content)) {
        return content.length === 0;
    }

    // 其他类型视为无效（空）
    return true;
}

/**
 * 检查 ApiMessage 的 content 是否为空
 * @param message - ApiMessage 对象
 * @returns true 如果 content 为空，false 如果 content 有内容
 */
export function isMessageContentEmpty(message: ApiMessage): boolean {
    return isContentEmpty(message.content);
}