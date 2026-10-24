import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SandboxedExecutionEnv } from "../src/sandbox/sandboxed-env.js";

/** A pi-durable required-member addition must fail this assignment. */
declare const sandboxed: SandboxedExecutionEnv;
const executionEnv: ExecutionEnv = sandboxed;
void executionEnv;
