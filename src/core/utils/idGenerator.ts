/**
 * ID 生成器工具
 * 使用随机字符串生成带语义前缀的短 ID
 */

import { randomBytes } from 'crypto';

/**
 * 生成随机字符串 (使用 a-z 字符集)
 * @param length 长度
 */
function generateRandomString(length: number = 10): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += alphabet[bytes[i] % alphabet.length];
    }
    return result;
}

/**
 * 生成任务 ID
 * 格式: task_xxxxxxxxxx
 */
export function generateTaskId(): string {
    return `task_${generateRandomString()}`;
}

/**
 * 生成 API 消息 ID (用于 LLM 交互的消息)
 * 格式: msg_api_xxxxxxxxxx
 */
export function generateApiMessageId(): string {
    return `msg_api_${generateRandomString()}`;
}

/**
 * 生成用户消息 ID (用于 UI 展示的消息)
 * 格式: msg_user_xxxxxxxxxx
 */
export function generateUserMessageId(): string {
    return `msg_user_${generateRandomString()}`;
}

/**
 * 生成工具请求 ID
 * 格式: tool_req_xxxxxxxxxx
 */
export function generateToolRequestId(): string {
    return `tool_req_${generateRandomString()}`;
}

/**
 * 生成通用 ID（带自定义前缀）
 * @param prefix 前缀
 */
export function generateId(prefix: string): string {
    return `${prefix}_${generateRandomString()}`;
}