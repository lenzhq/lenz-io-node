/**
 * Since 3.2, the top-level calls return `Result<T>`. A subclass override (or
 * a stub) declares that type, or casts to it; both compile under
 * `tsc --strict` (`type-compat.test.ts`). Never run.
 */

import {
  Lenz,
  type AssessInput,
  type AssessResponse,
  type Result,
  type TaskAccepted,
  type VerifyInput,
} from "../../src/index.js";

/** A 3.2 subclass overriding a call: it returns `Result<T>`. */
export class Recorded extends Lenz {
  override async verify(input: VerifyInput): Promise<Result<TaskAccepted>> {
    void input;
    const accepted: TaskAccepted = { task_id: "t", claim: "c" } as TaskAccepted;
    return Object.assign(accepted, { httpStatus: 202, headers: {} });
  }

  override async assess(input: AssessInput): Promise<Result<AssessResponse>> {
    void input;
    // Or a cast, for a recorded body without the metadata.
    return { claims: [], more_claims: [] } as unknown as Result<AssessResponse>;
  }
}

export function instanceStub(c: Lenz): void {
  c.verify = async () =>
    ({ task_id: "t", claim: "c", httpStatus: 202, headers: {} }) as Result<TaskAccepted>;
}
