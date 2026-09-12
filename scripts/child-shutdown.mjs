export async function terminateManagedChildren(
  children,
  {
    interruptTimeoutMs = 10_000,
    terminateTimeoutMs = 3_000,
    killTimeoutMs = 2_000
  } = {}
) {
  let running = [...children].filter(isRunning);
  sendSignal(running, "SIGINT");
  running = await waitForChildren(running, interruptTimeoutMs);
  if (running.length > 0) {
    sendSignal(running, "SIGTERM");
    running = await waitForChildren(running, terminateTimeoutMs);
  }
  if (running.length > 0) {
    sendSignal(running, "SIGKILL");
    running = await waitForChildren(running, killTimeoutMs);
  }
  return { exited: running.length === 0, remaining: running };
}

function sendSignal(children, signal) {
  for (const child of children) {
    if (!isRunning(child)) continue;
    try {
      child.kill(signal);
    } catch {
      // The exit observation below is authoritative.
    }
  }
}

function waitForChildren(children, timeoutMs) {
  const running = children.filter(isRunning);
  if (running.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const pending = new Set(running);
    const listeners = new Map();
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      for (const [child, listener] of listeners) child.removeListener("exit", listener);
      resolve([...pending].filter(isRunning));
    };
    for (const child of running) {
      const listener = () => {
        pending.delete(child);
        if (pending.size === 0) finish();
      };
      listeners.set(child, listener);
      child.once("exit", listener);
      if (!isRunning(child)) pending.delete(child);
    }
    timer = setTimeout(finish, Math.max(0, timeoutMs));
    if (pending.size === 0) finish();
  });
}

function isRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}
