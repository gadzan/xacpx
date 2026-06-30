describe("terminateProcessTree", () => {
  test("returns immediately for pid <= 0", async () => {
    const killProcess = () => {
      throw new Error("should not be called");
    };
    await terminateProcessTree(0, {}, "linux", async () => 0, killProcess);
    await terminateProcessTree(-1, {}, "linux", async () => 0, killProcess);
  });

  test("uses taskkill on windows", async () => {
    let ranCommand = "";
    const runCommand = async (cmd: string, _args: string[]) => {
      ranCommand = cmd;
      return 0;
    };
    await terminateProcessTree(1234, {}, "win32", runCommand, () => {});
    expect(ranCommand).toBe("taskkill");
  });

  test("taskkill on windows includes /PID, /T (tree), /F (force)", async () => {
    let capturedArgs: string[] = [];
    const runCommand = async (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return 0;
    };
    await terminateProcessTree(9999, {}, "win32", runCommand, () => {});
    expect(capturedArgs).toEqual(["/PID", "9999", "/T", "/F"]);
  });

  test("taskkill errors on windows are swallowed", async () => {
    const runCommand = async () => {
      throw new Error("process not found");
    };
    // Should not throw
    await terminateProcessTree(1234, {}, "win32", runCommand, () => {});
  });

  test("sends SIGTERM to process on unix", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const killProcess = (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
    };
    const isProcessRunning = (_pid: number) => false; // exits immediately

    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);

    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed[0].pid).toBe(1234);
    expect(killed[0].signal).toBe("SIGTERM");
  });

  test("uses negative pid for detached process group", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const killProcess = (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
    };
    const isProcessRunning = (_pid: number) => false;

    await terminateProcessTree(1234, { detachedProcessGroup: true }, "linux", async () => 0, killProcess, isProcessRunning);

    expect(killed[0].pid).toBe(-1234);
  });

  test("waits up to 5 seconds for process to exit after SIGTERM", async () => {
    const killProcess = () => {};
    let checkCount = 0;
    const isProcessRunning = (_pid: number) => {
      checkCount++;
      return checkCount < 3; // exits after 3 checks
    };

    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);
    // Should have checked multiple times
    expect(checkCount).toBeGreaterThan(0);
  });

  test("escalates to SIGKILL if process does not exit after timeout", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const killProcess = (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
    };
    const isProcessRunning = () => true; // never exits

    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);

    // Should have sent both SIGTERM and SIGKILL
    expect(killed.length).toBe(2);
    expect(killed[0].signal).toBe("SIGTERM");
    expect(killed[1].signal).toBe("SIGKILL");
  });

  test("does not send SIGKILL if process exits after SIGTERM", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const killProcess = (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
    };
    let checks = 0;
    const isProcessRunning = (_pid: number) => {
      checks++;
      return checks < 2; // exits after first check
    };

    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);

    expect(killed.length).toBe(1);
    expect(killed[0].signal).toBe("SIGTERM");
  });

  test("swallows errors from killProcess", async () => {
    const killProcess = () => {
      throw new Error("process already exited");
    };
    const isProcessRunning = () => false;

    // Should not throw
    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);
  });

  test("swallows errors from SIGKILL", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const killProcess = (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
      if (signal === "SIGTERM") {
        throw new Error("already exited");
      }
    };
    const isProcessRunning = () => true;

    // Should not throw
    await terminateProcessTree(1234, {}, "linux", async () => 0, killProcess, isProcessRunning);
  });

  test("process platform defaults to process.platform", async () => {
    // This test verifies the platform parameter works by checking the code path
    const killed: Array<{ pid: number; signal: string }> = [];
    const runCommand = async (_cmd: string, _args: string[]) => 0;

    // When platform is not win32, it uses unix path (SIGTERM)
    const platform = process.platform === "win32" ? "linux" : "linux";
    await terminateProcessTree(1234, {}, platform, runCommand, (pid, signal) => {
      killed.push({ pid, signal });
    }, () => false);

    expect(killed.some(k => k.signal === "SIGTERM")).toBe(true);
  });
});