import crossSpawn from "cross-spawn";

export type CommandTextOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
};

export type CommandTextResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes a command without relying on a POSIX shell. cross-spawn resolves
 * Windows npm `.cmd` shims while retaining regular child-process semantics on
 * macOS and Linux.
 */
export function executeCommandText(
  command: string,
  args: readonly string[],
  options: CommandTextOptions
): Promise<CommandTextResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error("Command timeout must be a positive integer."));
  }
  if (!Number.isSafeInteger(options.maxBuffer) || options.maxBuffer <= 0) {
    return Promise.reject(new Error("Command output limit must be a positive integer."));
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error("Command execution was aborted."));
  }

  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let settled = false;

    const stop = (error: Error) => {
      if (!failure) failure = error;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const append = (chunks: Buffer[], chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > options.maxBuffer) {
        stop(new Error(`Command output exceeded ${options.maxBuffer} bytes.`));
        return;
      }
      chunks.push(data);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, chunk));

    const timer = setTimeout(
      () => stop(new Error(`Command timed out after ${options.timeoutMs}ms.`)),
      options.timeoutMs
    );
    timer.unref?.();
    const onAbort = () => stop(new Error("Command execution was aborted."));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: CommandTextResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    child.once("error", (error) => finish(failure || error));
    child.once("close", (code, signal) => {
      if (failure) {
        finish(failure);
        return;
      }
      if (code !== 0) {
        finish(new Error(
          `Command exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`
        ));
        return;
      }
      finish({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export { crossSpawn };
