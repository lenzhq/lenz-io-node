/**
 * Subclass and instance overrides written for 2.21, unchanged: they must
 * still compile now that the methods they replace take request options
 * (`type-compat.test.ts`). Never run.
 */

import {
  Lenz,
  type BatchAccepted,
  type TaskStatus,
  type VerifyBatchInput,
} from "../../src/index.js";

/** A 2.21 subclass overriding the methods the waits call through. */
export class Recorded extends Lenz {
  override async getStatus(
    taskId: string,
    budget?: { timeoutMs?: number; deadlineAt?: number },
  ): Promise<TaskStatus> {
    void budget;
    return { task_id: taskId, status: "processing" } as unknown as TaskStatus;
  }

  override async verifyBatch(input: VerifyBatchInput): Promise<BatchAccepted> {
    return { batch_id: "b", items: input.claims.map(() => ({ task_id: "t" })) } as BatchAccepted;
  }
}

/** One that takes only the id, as many 2.x test doubles do. */
export class Bare extends Lenz {
  override async getStatus(taskId: string): Promise<TaskStatus> {
    return { task_id: taskId, status: "completed" } as unknown as TaskStatus;
  }
}

export function instanceOverrides(c: Lenz): void {
  c.getStatus = async (taskId: string) =>
    ({ task_id: taskId, status: "completed" }) as unknown as TaskStatus;
  c.verifyBatch = async (input: VerifyBatchInput) =>
    ({ batch_id: "b", items: input.claims.map(() => ({ task_id: "t" })) }) as BatchAccepted;
}
