/**
 * 系统提示词组合
 * 将核心提示词与角色描述组合成完整的系统提示
 */

import { coreSystemPrompt } from './core-prompt';


/**
 * 默认角色定义（当 Agent 没有提供 description 时使用）
 */
export const defaultRole = `You are Schoober，一个技术专家，产品专家，具备各项软件专家知识。`;

/**
 * 构建基础系统提示词（不包含工具定义和自定义提示词）
 * 
 * 组合顺序：角色定义 + 核心提示词（消息风格、任务执行、工具使用、用户交互、通用规则）
 * 
 * 注意：工具定义和自定义提示词将在 Agent.composeSystemPrompt 中按正确顺序添加
 *
 * @param roleDescription 角色定义，通常使用 Agent 的 description。如果不提供，使用默认角色定义
 * @param corePrompt 核心系统提示词，如果不提供，使用默认的 coreSystemPrompt
 * @returns 基础系统提示词
 */
export function buildSystemPrompt(roleDescription?: string, corePrompt?: string): string {
    return (roleDescription || defaultRole) + '\n' + (corePrompt ?? coreSystemPrompt);
}