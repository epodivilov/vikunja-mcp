/**
 * Lean DTOs returned to the agent. These are the ONLY task/project shapes that
 * cross the tool boundary — never expose a raw Vikunja API object to the model.
 */

export interface LeanProject {
  /** Project key prefix, e.g. "INFRA". Empty string if the project has no identifier. */
  key: string;
  id: number;
  title: string;
}

export interface LeanTask {
  /** Human/agent-facing task key, e.g. "INFRA-41". */
  ref: string;
  /** Global Vikunja id. Escape hatch only — prefer `ref` everywhere. */
  id: number;
  title: string;
  done: boolean;
  priority?: number;
  due?: string;
  labels: string[];
}

export interface LeanLabel {
  id: number;
  title: string;
}
