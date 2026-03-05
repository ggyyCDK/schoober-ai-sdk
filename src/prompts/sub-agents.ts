import { Agent as IAgent } from "@/types";

/**
 * 生成子Agent信息提示词
 * @param subAgents 子Agent映射表（key为子Agent名称，value为子Agent实例）
 * @returns 包含所有子Agent信息的提示词
 */
export async function generateSubAgentsPrompt(
    subAgents: Map<string, IAgent>
): Promise<string> {
    if (subAgents.size === 0) {
        return "";
    }

    const sections: string[] = [];

    sections.push("# Available Sub-Agents");
    sections.push("");
    sections.push(
        "You have access to the following sub-agents for task delegation. When using the `new_task` tool, you MUST specify one of these agent names in the `agentName` parameter:"
    );
    sections.push("");

    // 生成每个子Agent的信息
    for (const [name, agent] of subAgents.entries()) {
        const lines: string[] = [];

        // 子Agent名称（作为标题）
        lines.push(`## ${name}`);

        // 子Agent描述
        if (agent.description) {
            lines.push(`Description: ${agent.description}`);
        } else {
            lines.push(`Description: No description available`);
        }

        sections.push(lines.join("\n"));
        sections.push("");
    }

    sections.push(
        "**Important**: When calling the `new_task` tool, you MUST use one of the agent names listed above for the `agentName` parameter."
    );

    return sections.join("\n");
}