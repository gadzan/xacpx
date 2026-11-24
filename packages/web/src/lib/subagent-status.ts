import type { ToolStepDto, ToolStepStatus } from "@ganglion/xacpx-relay-protocol";

export function resolveSubagentStatus(step: ToolStepDto, children: ToolStepDto[]): ToolStepStatus {
  if (step.status === "error" || children.some((child) => child.status === "error")) return "error";
  if (step.status === "running" || children.some((child) => child.status === "running")) return "running";
  return "success";
}
