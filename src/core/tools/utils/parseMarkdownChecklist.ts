import crypto from 'crypto';

/**
 * Todo 状态类型
 */
export type TodoStatus = 'pending' | 'completed' | 'in_progress';

/**
 * Todo 项接口
 */
export interface TodoItem {
    /** 唯一标识符 */
    id: string;
    /** 任务内容 */
    content: string;
    /** 任务状态 */
    status: TodoStatus;
}

/**
 * 解析 Markdown 格式的 checklist 为结构化的 TodoItem 数组
 * 
 * 支持的格式：
 * - [ ] 待办任务 (pending)
 * - [x] 已完成任务 (completed)
 * - [X] 已完成任务 (completed)
 * - [-] 进行中任务 (in_progress)
 * - [~] 进行中任务 (in_progress)
 * 
 * 也支持带 - 前缀的格式：
 * - - [ ] 待办任务
 * - - [x] 已完成任务
 * 
 * @param md Markdown 格式的 checklist 文本
 * @returns TodoItem 数组
 * 
 * @example
 * ```typescript
 * const todos = parseMarkdownChecklist(`
 * [ ] 设计数据库结构
 * [x] 实现API接口
 * [-] 编写测试用例
 * `);
 * // 返回:
 * // [
 * //   { id: '...', content: '设计数据库结构', status: 'pending' },
 * //   { id: '...', content: '实现API接口', status: 'completed' },
 * //   { id: '...', content: '编写测试用例', status: 'in_progress' }
 * // ]
 * ```
 */
export function parseMarkdownChecklist(md: string): TodoItem[] {
    if (typeof md !== 'string') return [];

    const lines = md
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    const todos: TodoItem[] = [];

    for (const line of lines) {
        // 支持 "[ ] Task" 和 "- [ ] Task" 两种格式
        const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/);
        if (!match) continue;

        let status: TodoStatus = 'pending';
        if (match[1] === 'x' || match[1] === 'X') {
            status = 'completed';
        } else if (match[1] === '-' || match[1] === '~') {
            status = 'in_progress';
        }

        // 生成唯一 ID（基于内容和状态的哈希）
        const id = crypto
            .createHash('md5')
            .update(match[2] + status)
            .digest('hex');

        todos.push({
            id,
            content: match[2],
            status,
        });
    }

    return todos;
}

/**
 * 将 TodoItem 数组转换回 Markdown 格式
 * 
 * @param todos TodoItem 数组
 * @returns Markdown 格式的 checklist 文本
 * 
 * @example
 * ```typescript
 * const markdown = todoItemsToMarkdown([
 *   { id: '1', content: '设计数据库结构', status: 'pending' },
 *   { id: '2', content: '实现API接口', status: 'completed' }
 * ]);
 * // 返回:
 * // [ ] 设计数据库结构
 * // [x] 实现API接口
 * ```
 */
export function todoItemsToMarkdown(todos: TodoItem[]): string {
    return todos
        .map((todo) => {
            let checkbox = '[ ]';
            if (todo.status === 'completed') {
                checkbox = '[x]';
            } else if (todo.status === 'in_progress') {
                checkbox = '[-]';
            }
            return `${checkbox} ${todo.content}`;
        })
        .join('\n');
}