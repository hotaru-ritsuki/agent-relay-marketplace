import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupTrackedChildren,
  createProcessSupervisor,
  installSupervisorTeardown,
  run,
  spawnTracked
} from "./process-supervisor/index.mjs";
import { createWindowsBackend } from "./process-supervisor/backends/windows.mjs";
import { makeTempDir, resolveTestCommand } from "./helpers.mjs";

const windowsBackend = createWindowsBackend();
const {
  cleanupWindowsJobForTest: cleanupBackendLaunch,
  getWindowsJobLeaseCount: getBackendLeaseCount,
  runWindowsJobForTest: runBackend
} = windowsBackend.test;
installSupervisorTeardown(after);
after(async () => {
  await windowsBackend.shutdown();
});

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

test("cold-start post-assignment failure has strict zero-to-zero native census", {
  skip: process.platform !== "win32"
}, () => {
  const countSliceProcesses = () => {
    const result = spawnSync("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=@(Get-CimInstance Win32_Process | ? { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*process-supervisor*native*windows*controller.ps1*' -or $_.CommandLine -like '*process-supervisor*native*windows*launch-shim.mjs*') }); $p.Count"
    ], { encoding: "utf8", windowsHide: true });
    return Number(result.stdout.trim());
  };
  assert.equal(countSliceProcesses(), 0, "PRE must be a cold zero baseline");
  const cwd = makeTempDir("cold-assignment-failure-");
  const shimPidFile = path.join(cwd, "shim.pid");
  assert.throws(
    () => runBackend(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      controllerFault: "fail-after-assign",
      faultPidFile: shimPidFile,
      controlTimeout: 2000,
      timeout: 1000
    }),
    /post-AssignProcessToJobObject/
  );
  const shimPid = Number(fs.readFileSync(shimPidFile, "utf8"));
  assert.throws(
    () => process.kill(shimPid, 0),
    (error) => error?.code === "ESRCH"
  );
  assert.equal(countSliceProcesses(), 0, "POST must return to a strict zero baseline");
});

test("Windows run retains a Job lease until global cleanup terminates descendants", {
  skip: process.platform !== "win32"
}, async (t) => {
  const cwd = makeTempDir("run-job-integration-");
  const descendantPidFile = path.join(cwd, "descendant.pid");
  const descendant = [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.argv[1],String(process.pid));",
    "setInterval(()=>{},1000);"
  ].join("");
  const root = [
    "const{spawn}=require('node:child_process');",
    `const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.env.PID_FILE],`,
    "{detached:true,stdio:'ignore',windowsHide:true});c.unref();",
    "process.stdout.write('root');"
  ].join("");
  let descendantPid;
  t.after(() => {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid); } catch {}
    }
  });

  const result = runBackend(process.execPath, ["-e", root], {
    cwd,
    env: { ...process.env, PID_FILE: descendantPidFile }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "root");
  assert.equal(typeof result.lease?.launchId, "string");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(descendantPidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
  process.kill(descendantPid, 0);
  await windowsBackend.cleanup();
  assert.equal(getBackendLeaseCount(), 0);
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error) => error?.code === "ESRCH"
  );
});

test("Windows global cleanup terminalizes multiple retained run leases", {
  skip: process.platform !== "win32"
}, async () => {
  const cwd = makeTempDir("multiple-run-leases-");
  const pids = [];
  for (let index = 0; index < 2; index += 1) {
    const pidFile = path.join(cwd, `descendant-${index}.pid`);
    const descendant = [
      "const fs=require('node:fs');",
      "fs.writeFileSync(process.argv[1],String(process.pid));",
      "setInterval(()=>{},1000);"
    ].join("");
    const root = [
      "const{spawn}=require('node:child_process');",
      `const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.env.PID_FILE],`,
      "{detached:true,stdio:'ignore',windowsHide:true});c.unref();"
    ].join("");
    const result = runBackend(process.execPath, ["-e", root], {
      cwd,
      env: { ...process.env, PID_FILE: pidFile }
    });
    assert.equal(result.status, 0);
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    pids.push(Number(fs.readFileSync(pidFile, "utf8")));
  }
  for (const pid of pids) process.kill(pid, 0);
  await windowsBackend.cleanup();
  assert.equal(getBackendLeaseCount(), 0);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
  }
});

test("Windows global cleanup failure poisons its controller and fails the test", {
  skip: process.platform !== "win32"
}, async () => {
  const cwd = makeTempDir("run-cleanup-failure-");
  const controllerPidFile = path.join(cwd, "controller.pid");
  const result = runBackend(process.execPath, ["-e", ""], {
    controllerFault: "drop-cleanup-ack",
    controllerPidFile,
    controlTimeout: 500,
    timeout: 2000
  });
  await assert.rejects(
    windowsBackend.cleanup(),
    /Windows Job lease|cleanup.*deadline|poison/i
  );
  assert.equal(getBackendLeaseCount(), 0);
  const oldControllerPid = Number(fs.readFileSync(controllerPidFile, "utf8"));
  assert.throws(
    () => process.kill(oldControllerPid, 0),
    (error) => error?.code === "ESRCH"
  );
  const fresh = run(process.execPath, ["-e", "process.stdout.write('fresh')"]);
  assert.equal(fresh.stdout, "fresh");
  assert.deepEqual(
    {
      backend: fresh.supervisor.backend,
      mode: fresh.supervisor.mode,
      containment: fresh.supervisor.containment,
      cleanup: fresh.supervisor.cleanup.level
    },
    {
      backend: "windows-job",
      mode: "host-strict",
      containment: "kernel",
      cleanup: "kernel-drained"
    }
  );
  await cleanupTrackedChildren();
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows spawnTracked exposes actual target PID, streams, and exit semantics", {
  skip: process.platform !== "win32"
}, async () => {
  const cwd = makeTempDir("spawn-tracked-pid-");
  const shimPidFile = path.join(cwd, "shim.pid");
  const source =
    "process.stdout.write(String(process.pid));process.stderr.write('tracked-error');setTimeout(()=>process.exit(7),500)";
  const native = spawn(
    process.execPath,
    ["-e", source],
    { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let nativeStdout = "";
  native.stdout.setEncoding("utf8");
  native.stdout.on("data", (chunk) => { nativeStdout += chunk; });
  await new Promise((resolve, reject) => {
    native.once("error", reject);
    native.once("exit", resolve);
  });
  assert.equal(Number(nativeStdout), native.pid);

  const supervisor = createProcessSupervisor({
    minimumGuarantee: "host-strict",
    backendFactories: [
      () => createWindowsBackend({ faults: { faultPidFile: shimPidFile } })
    ]
  });
  const child = await supervisor.spawnTracked({
      command: process.execPath,
      args: ["-e", source],
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
  const publishedShimPid = Number(fs.readFileSync(shimPidFile, "utf8"));
  const directChildren = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$p=@(Get-CimInstance Win32_Process | ? ParentProcessId -eq ${publishedShimPid} | % ProcessId); $p -join ','`
  ], { encoding: "utf8", windowsHide: true });
  assert.match(
    `,${directChildren.stdout.trim()},`,
    new RegExp(`,${child.pid},`),
    `shim=${publishedShimPid}, direct=${directChildren.stdout.trim()}`
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const shimPid = Number(fs.readFileSync(shimPidFile, "utf8"));
  assert.equal(Number(stdout), child.pid);
  assert.notEqual(child.pid, shimPid);
  assert.equal(stderr, "tracked-error");
  assert.deepEqual(exit, { code: 7, signal: null });
  assert.equal(child.exitCode, 7);
  assert.equal(child.signalCode, null);
  await supervisor.shutdown();
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows spawnTracked detached sleeper unref remains owned until cleanup", {
  skip: process.platform !== "win32"
}, async () => {
  const sleeper = await spawnTracked(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  assert.equal(sleeper.unref(), sleeper);
  process.kill(sleeper.pid, 0);
  await cleanupTrackedChildren();
  assert.equal(getBackendLeaseCount(), 0);
  assert.throws(
    () => process.kill(sleeper.pid, 0),
    (error) => error?.code === "ESRCH"
  );
});

test("Windows PID handshake retries sharing locks and validates retained membership", {
  skip: process.platform !== "win32"
}, () => {
  const result = runBackend(
    process.execPath,
    ["-e", "setTimeout(()=>process.exit(0),300)"],
    {
      controllerFault: "pid-handshake-sharing-lock",
      timeout: 3000
    }
  );
  assert.equal(result.status, 0);
  cleanupBackendLaunch(result.lease);
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows PID handshake rejects shim, nonmember, and stale PID publications", {
  skip: process.platform !== "win32"
}, async () => {
  assert.throws(
    () => runBackend(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { controllerFault: "pid-handshake-wrong-pid", controlTimeout: 5000 }
    ),
    /direct child|member/i
  );
  assert.equal(getBackendLeaseCount(), 0);

  const outsider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await new Promise((resolve, reject) => {
    outsider.once("spawn", resolve);
    outsider.once("error", reject);
  });
  assert.throws(
    () => runBackend(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        controllerFault: "pid-handshake-nonmember-pid",
        handshakePid: outsider.pid,
        controlTimeout: 5000
      }
    ),
    /not a member|membership proof|direct child/i
  );
  process.kill(outsider.pid, 0);
  outsider.kill("SIGKILL");
  await new Promise((resolve) => outsider.once("exit", resolve));
  assert.equal(getBackendLeaseCount(), 0);

  const stale = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve, reject) => {
    stale.once("error", reject);
    stale.once("exit", resolve);
  });
  assert.throws(
    () => runBackend(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        controllerFault: "pid-handshake-nonmember-pid",
        handshakePid: stale.pid,
        controlTimeout: 5000
      }
    ),
    /OpenProcess|process snapshot|member|direct child/i
  );
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows PID handshake malformed, early-exit, and timeout faults fail closed", {
  skip: process.platform !== "win32"
}, () => {
  const malformedStarted = Date.now();
  assert.throws(
    () => runBackend(process.execPath, ["-e", ""], {
      controllerFault: "pid-handshake-malformed",
      controlTimeout: 5000
    }),
    /JSON|invalid|malformed/i
  );
  assert.ok(Date.now() - malformedStarted < 2500);
  assert.equal(getBackendLeaseCount(), 0);

  for (const fault of ["pid-handshake-early-exit", "pid-handshake-timeout"]) {
    assert.throws(
      () => runBackend(process.execPath, ["-e", ""], {
        controllerFault: fault,
        controlTimeout: 5000
      }),
      /PID publication deadline expired/i
    );
    assert.equal(getBackendLeaseCount(), 0);
  }
});

test("Windows PID handshake fails closed when the target handle cannot prove absence", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(
    () => runBackend(
      process.execPath,
      ["-e", "setTimeout(()=>{},1000)"],
      {
        controllerFault: "pid-handshake-invalid-handle",
        controlTimeout: 5000
      }
    ),
    /OpenProcess.*target PID handshake/i
  );
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows spawnTracked orders exit, stream closure, and close while preserving unread output", {
  skip: process.platform !== "win32"
}, async () => {
  const child = await spawnTracked(
    process.execPath,
    ["-e", "process.stdout.write('unread-out');process.stderr.write('unread-error')"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  const events = [];
  child.on("exit", () => events.push("exit"));
  child.stdout.on("close", () => events.push("stdout-close"));
  child.stderr.on("close", () => events.push("stderr-close"));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => {
      events.push("close");
      resolve();
    });
  });

  await closed;

  assert.equal(events[0], "exit");
  assert.ok(events.indexOf("stdout-close") < events.indexOf("close"));
  assert.ok(events.indexOf("stderr-close") < events.indexOf("close"));
  assert.equal(child.stdout.read().toString("utf8"), "unread-out");
  assert.equal(child.stderr.read().toString("utf8"), "unread-error");
  await cleanupTrackedChildren();
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows spawnTracked kill matches native SIGTERM and SIGKILL semantics", {
  skip: process.platform !== "win32"
}, async () => {
  for (const signal of ["SIGTERM", "SIGKILL", "SIGINT", "SIGBREAK", "SIGHUP"]) {
    const native = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    await new Promise((resolve, reject) => {
      native.once("spawn", resolve);
      native.once("error", reject);
    });
    const nativeExit = new Promise((resolve) => {
      native.once("exit", (code, signalCode) => resolve({ code, signalCode }));
    });
    assert.equal(native.kill(signal), true);
    const nativeResult = await nativeExit;
    assert.equal(nativeResult.code, null);

    const child = await spawnTracked(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore", windowsHide: true }
    );
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signalCode) => resolve({ code, signalCode }));
    });
    assert.equal(child.kill(signal), true);
    assert.deepEqual(await closed, nativeResult);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, nativeResult.signalCode);
    assert.equal(getBackendLeaseCount(), 0);
  }

  const child = await spawnTracked(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore", windowsHide: true }
  );
  assert.equal(child.kill("SIGKILL"), true);
  assert.equal(child.kill("SIGKILL"), false);
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows spawnTracked unref lets its parent exit naturally and terminalize the Job", {
  skip: process.platform !== "win32"
}, () => {
  const helpersUrl = new URL("./helpers.mjs", import.meta.url).href;
  const source = `
    const { spawnTracked } = await import(${JSON.stringify(helpersUrl)});
    const child = await spawnTracked(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  `;
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 7000, windowsHide: true }
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 5000, `parent exit took ${elapsed}ms`);
});

test("Windows spawnTracked reports real ENOENT with native error and close semantics", {
  skip: process.platform !== "win32"
}, async () => {
  const missing = path.join(makeTempDir("spawn-missing-"), "missing.exe");
  const supervisor = createProcessSupervisor({
    minimumGuarantee: "host-strict",
    backendFactories: [createWindowsBackend]
  });
  const child = await supervisor.spawnTracked({
    command: missing,
    args: ["argument"],
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let exitEmitted = false;
  child.once("exit", () => {
    exitEmitted = true;
  });
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  let infrastructureError;
  await assert.rejects(
    child.completion,
    (error) => {
      infrastructureError = error;
      return error.code === "ROOT_PROCESS_ERROR" &&
        error.result?.error?.code === "ENOENT";
    }
  );
  await closePromise;

  assert.equal(child.pid, undefined);
  assert.equal(child.kill(), false);
  assert.equal(exitEmitted, true);
  assert.equal(infrastructureError.result.error.path, missing);
  assert.deepEqual(infrastructureError.result.error.spawnargs, ["argument"]);
  assert.match(infrastructureError.result.error.syscall, /^spawn /);
  await assert.rejects(supervisor.shutdown(), /ENOENT/);
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows backend ENOENT remains spawnSync-shaped through run", {
  skip: process.platform !== "win32"
}, () => {
  const missing = path.join(makeTempDir("run-missing-"), "missing.exe");
  const result = runBackend(
    missing,
    ["argument"],
    { windowsHide: true }
  );
  assert.equal(result.status, null);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(getBackendLeaseCount(), 0);
});

test("native Windows test commands bypass the shell", {
  skip: process.platform !== "win32"
}, () => {
  assert.deepEqual(resolveTestCommand("node"), {
    command: process.execPath,
    shell: false
  });
  assert.deepEqual(resolveTestCommand("git"), {
    command: "git.exe",
    shell: false
  });
  const npmInvocation = resolveTestCommand("npm");
  assert.equal(npmInvocation.command, process.execPath);
  assert.equal(npmInvocation.shell, false);
  assert.match(npmInvocation.argsPrefix[0], /npm-cli\.js$/);
});

test("Windows npm routing resolves a PATH npm.cmd layout without executing the shim", {
  skip: process.platform !== "win32"
}, () => {
  const bin = makeTempDir("portable-npm-bin-");
  const npmCli = path.join(bin, "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "npm.cmd"),
    "@echo this shim must never execute & exit /b 91\r\n",
    "utf8"
  );
  fs.writeFileSync(npmCli, "process.exit(0);\n", "utf8");

  const invocation = resolveTestCommand(
    "npm",
    "win32",
    { Path: bin, npm_execpath: "" }
  );

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.argsPrefix, [fs.realpathSync.native(npmCli)]);
});

test("Windows npm routing ignores an invalid npm_execpath and falls back to PATH", {
  skip: process.platform !== "win32"
}, () => {
  const root = makeTempDir("portable-npm-invalid-execpath-");
  const invalid = path.join(root, "invalid", "npm-cli.js");
  const bin = path.join(root, "bin");
  const npmCli = path.join(bin, "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(invalid, Buffer.from([0, 0, 0]));
  fs.writeFileSync(path.join(bin, "npm.cmd"), "@exit /b 92\r\n", "utf8");
  fs.writeFileSync(npmCli, "process.exit(0);\n", "utf8");

  const invocation = resolveTestCommand(
    "npm",
    "win32",
    { Path: bin, npm_execpath: invalid }
  );

  assert.deepEqual(invocation.argsPrefix, [fs.realpathSync.native(npmCli)]);
});

test("Windows job facade rejects invalid operation schemas without contaminating a live lease", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(() => runBackend("", []), /command/i);
  assert.throws(() => runBackend(process.execPath, "not-an-array"), /args/i);
  assert.throws(() => runBackend(process.execPath, [1]), /args/i);
  assert.throws(
    () => runBackend(process.execPath, ["-e", ""], { shell: true }),
    /shell/i
  );
  assert.throws(
    () => runBackend(process.execPath, ["-e", ""], { detached: "yes" }),
    /detached/i
  );
  assert.throws(
    () => runBackend(process.execPath, ["-e", ""], { windowsHide: 1 }),
    /windowsHide/i
  );
  for (const [name, value] of [
    ["timeout", 0],
    ["controlTimeout", 31_000],
    ["maxBuffer", 64 * 1024 * 1024 + 1]
  ]) {
    assert.throws(
      () => runBackend(process.execPath, ["-e", ""], { [name]: value }),
      new RegExp(name)
    );
  }

  const result = runBackend(process.execPath, ["-e", ""], { timeout: 3000 });
  assert.throws(
    () => cleanupBackendLaunch({ ...result.lease, launchId: "" }),
    /lease/i
  );
  assert.equal(cleanupBackendLaunch(result.lease).activeProcesses, 0);
});

test("Windows job controller preserves sync run semantics and owns descendants after root exit", {
  skip: process.platform !== "win32"
}, async (t) => {
  const warmup = runBackend(process.execPath, ["-e", ""], { timeout: 3000 });
  cleanupBackendLaunch(warmup.lease);
  const cwd = makeTempDir("controller slice with spaces ");
  const descendantPidFile = path.join(cwd, "descendant.pid");
  const descendantSource = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[1], String(process.pid));",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const rootSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath,",
    `['-e', ${JSON.stringify(descendantSource)}, process.env.DESCENDANT_PID_FILE],`,
    "{ detached: true, stdio: 'inherit', windowsHide: true });",
    "child.unref();",
    "const input = fs.readFileSync(0, 'utf8');",
    "process.stdout.write(`out:${input}:${process.env.SLICE_VALUE}:${process.cwd()}`);",
    "process.stderr.write('err:controller-slice');"
  ].join(" ");
  let descendantPid;
  t.after(async () => {
    if (Number.isInteger(descendantPid)) {
      try {
        process.kill(descendantPid);
      } catch {
        // Job cleanup already terminated it.
      }
    }
  });

  const runStartedAt = Date.now();
  const result = runBackend(
    process.execPath,
    ["-e", rootSource, "literal & | < > ^ % ! \" payload"],
    {
      cwd,
      env: {
        ...process.env,
        SLICE_VALUE: "value & | < > ^ % ! \"",
        DESCENDANT_PID_FILE: descendantPidFile
      },
      encoding: "utf8",
      input: "stdin & | < > ^ % ! \"",
      shell: false,
      windowsHide: true,
      timeout: 3000
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const runElapsedMs = Date.now() - runStartedAt;
  assert.ok(
    runElapsedMs < 2000,
    `root result must not wait for descendant stdio EOF (elapsed ${runElapsedMs}ms)`
  );
  assert.match(result.stdout, /^out:stdin & \| < > \^ % ! ":value & \| < > \^ % ! "/);
  assert.equal(result.stderr, "err:controller-slice");
  assert.match(result.stdout, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const descendantDeadline = Date.now() + 3000;
  while (!fs.existsSync(descendantPidFile) && Date.now() < descendantDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(descendantPidFile), true);
  descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
  process.kill(descendantPid, 0);
  const proof = cleanupBackendLaunch(result.lease);
  assert.equal(proof.status, "stopped");
  assert.equal(proof.activeProcesses, 0);
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error) => error?.code === "ESRCH"
  );
});

test("Windows run returns a spawnSync-shaped ENOENT result", {
  skip: process.platform !== "win32"
}, () => {
  const missing = path.join(makeTempDir("missing-command-"), "does-not-exist.exe");
  const args = ["first", "second"];
  const native = spawnSync(missing, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const result = runBackend(missing, args, { timeout: 3000 });

  assert.equal(result.pid, native.pid);
  assert.equal(result.status, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, native.stdout);
  assert.equal(result.stderr, native.stderr);
  assert.ok(result.error instanceof Error);
  assert.equal(result.error.code, native.error.code);
  assert.equal(result.error.errno, native.error.errno);
  assert.equal(result.error.path, missing);
  assert.deepEqual(result.error.spawnargs, args);
  assert.match(result.error.syscall, /^spawnSync /);
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows run preserves nontrivial native exit codes without byte truncation", {
  skip: process.platform !== "win32"
}, () => {
  const source = "setTimeout(()=>process.exit(513),300)";
  const native = spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const result = runBackend(
    process.execPath,
    ["-e", source],
    { timeout: 3000 }
  );

  assert.equal(native.status, 513);
  assert.equal(result.status, native.status);
  assert.equal(result.error, undefined);
  cleanupBackendLaunch(result.lease);
  assert.equal(getBackendLeaseCount(), 0);
});

test("Windows job controller preserves Buffer input and encoding null output", {
  skip: process.platform !== "win32"
}, () => {
  const input = Buffer.from([0, 1, 2, 38, 124, 255]);
  const result = runBackend(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const b=fs.readFileSync(0);process.stdout.write(b);process.stderr.write(b)"
    ],
    {
      input,
      encoding: null,
      shell: false,
      windowsHide: true,
      timeout: 3000
    }
  );
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, input);
  assert.deepEqual(result.stderr, input);
  assert.equal(cleanupBackendLaunch(result.lease).activeProcesses, 0);
});

test("Windows job controller bounds simultaneous stdout and stderr", {
  skip: process.platform !== "win32"
}, () => {
  const result = runBackend(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const b=fs.readFileSync(0);process.stdout.write(b);process.stderr.write(b)"
    ],
    {
      input: "x".repeat(128 * 1024),
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      shell: false,
      windowsHide: true,
      timeout: 3000
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.length, 128 * 1024);
  assert.equal(result.stderr.length, 128 * 1024);

  const overflow = runBackend(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(128 * 1024))"],
    {
      encoding: "utf8",
      maxBuffer: 1024,
      shell: false,
      windowsHide: true,
      timeout: 3000
    }
  );
  assert.equal(overflow.status, null);
  assert.equal(overflow.error?.code, "ENOBUFS");
  assert.equal(cleanupBackendLaunch(overflow.lease).activeProcesses, 0);
  cleanupBackendLaunch(result.lease);
});

test("Windows job controller chunks valid 4 MiB and dual-stream multi-MiB output", {
  skip: process.platform !== "win32"
}, () => {
  const fourMiB = 4 * 1024 * 1024;
  const stdoutOnly = runBackend(
    process.execPath,
    ["-e", `process.stdout.write(Buffer.alloc(${fourMiB}, 0x61))`],
    { encoding: null, maxBuffer: fourMiB, timeout: 10_000 }
  );
  assert.equal(stdoutOnly.status, 0);
  assert.equal(stdoutOnly.stdout.length, fourMiB);
  assert.equal(stdoutOnly.stdout[0], 0x61);
  assert.equal(stdoutOnly.stdout.at(-1), 0x61);
  cleanupBackendLaunch(stdoutOnly.lease);

  const perStream = 2 * 1024 * 1024;
  const dual = runBackend(
    process.execPath,
    [
      "-e",
      `process.stdout.write(Buffer.alloc(${perStream},0x62));` +
        `process.stderr.write(Buffer.alloc(${perStream},0x63))`
    ],
    { encoding: null, maxBuffer: perStream * 2, timeout: 10_000 }
  );
  assert.equal(dual.status, 0);
  assert.equal(dual.stdout.length, perStream);
  assert.equal(dual.stderr.length, perStream);
  assert.equal(dual.stdout[0], 0x62);
  assert.equal(dual.stderr.at(-1), 0x63);
  cleanupBackendLaunch(dual.lease);
});

test("Windows root snapshot barrier captures exact repeated 2 MiB roots and excludes tail writes", {
  skip: process.platform !== "win32"
}, async () => {
  const rootBytes = 2 * 1024 * 1024;
  const descendant = [
    "setTimeout(()=>{process.stdout.write('tail'.repeat(1024));setInterval(()=>{},1000)},1200);"
  ].join("");
  const root = [
    "const{spawn}=require('node:child_process');",
    `const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],`,
    "{detached:true,stdio:'inherit',windowsHide:true});c.unref();",
    `const b=Buffer.alloc(65536,0x72);for(let n=0;n<${rootBytes};n+=b.length)process.stdout.write(b);`
  ].join("");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = runBackend(process.execPath, ["-e", root], {
      encoding: null,
      maxBuffer: rootBytes + 64 * 1024,
      timeout: 10_000
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.length, rootBytes);
    assert.equal(result.stdout.every((byte) => byte === 0x72), true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    cleanupBackendLaunch(result.lease);
  }
});

test("Windows job cleanup is idempotent with correlated tombstone proof", {
  skip: process.platform !== "win32"
}, () => {
  const result = runBackend(process.execPath, ["-e", ""], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 3000
  });

  const first = cleanupBackendLaunch(result.lease);
  const second = cleanupBackendLaunch(result.lease);

  assert.equal(first.status, "stopped");
  assert.equal(first.tombstone, true);
  assert.equal(second.status, "stopped");
  assert.equal(second.tombstone, true);
  assert.equal(second.launchId, first.launchId);
});

test("lost Windows launch acknowledgement aborts the controller and next launch restarts cleanly", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(
    () => runBackend(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      controllerFault: "drop-launch-ack",
      controlTimeout: 1000,
      timeout: 1000
    }),
    /launch acknowledgement|controller.*deadline/i
  );

  const next = runBackend(process.execPath, ["-e", "process.stdout.write('restarted')"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 3000
  });
  assert.equal(next.status, 0);
  assert.equal(next.stdout, "restarted");
  assert.equal(cleanupBackendLaunch(next.lease).activeProcesses, 0);
});

test("Windows controller exit resets the Worker client and next launch restarts cleanly", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(
    () => runBackend(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      controllerFault: "exit-after-launch",
      controlTimeout: 2000,
      timeout: 1000
    }),
    /controller exited|terminal proof/i
  );

  const next = runBackend(process.execPath, ["-e", "process.stdout.write('restarted')"], {
    timeout: 3000
  });
  assert.equal(next.status, 0);
  assert.equal(next.stdout, "restarted");
  assert.equal(cleanupBackendLaunch(next.lease).activeProcesses, 0);
});

test("Windows assignment failure terminates the retained suspended shim", {
  skip: process.platform !== "win32"
}, () => {
  const countShimProcesses = () => {
    const result = spawnSync("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=@(Get-CimInstance Win32_Process | ? { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*process-supervisor*native*windows*launch-shim.mjs*' -and $_.CommandLine -notlike '*process-supervisor*native*windows*controller.ps1*' }); $p.Count"
    ], { encoding: "utf8", windowsHide: true });
    return Number(result.stdout.trim());
  };
  const cwd = makeTempDir("assignment-failure-");
  const faults = new Map([
    ["fail-set-handle", /SetHandleInformation/],
    ["fail-job-create", /CreateJobObject/],
    ["fail-job-config", /SetInformationJobObject/],
    ["fail-assign", /AssignProcessToJobObject/],
    ["fail-after-assign", /post-AssignProcessToJobObject/]
  ]);
  for (const [fault, expectedOperation] of faults) {
    const shimPidFile = path.join(cwd, `${fault}.pid`);
    assert.throws(
      () => runBackend(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        controllerFault: fault,
        faultPidFile: shimPidFile,
        controlTimeout: 2000,
        timeout: 1000
      }),
      expectedOperation
    );
    if (fault === "fail-set-handle") {
      assert.equal(fs.existsSync(shimPidFile), false);
    } else {
      assert.equal(fs.existsSync(shimPidFile), true, "controller must publish the retained shim PID");
      const shimPid = Number(fs.readFileSync(shimPidFile, "utf8"));
      assert.throws(
        () => process.kill(shimPid, 0),
        (error) => error?.code === "ESRCH"
      );
    }
    assert.equal(countShimProcesses(), 0);
  }
});

test("Windows cleanup timeout poisons the controller and permits a fresh launch", {
  skip: process.platform !== "win32"
}, () => {
  const stuck = runBackend(process.execPath, ["-e", ""], {
    controllerFault: "drop-cleanup-ack",
    controlTimeout: 500,
    timeout: 1000
  });
  assert.throws(
    () => cleanupBackendLaunch(stuck.lease),
    /cleanup.*deadline|poison/i
  );
  const next = runBackend(process.execPath, ["-e", "process.stdout.write('fresh')"], {
    timeout: 2000
  });
  assert.equal(next.stdout, "fresh");
  cleanupBackendLaunch(next.lease);
  assert.equal(cleanupBackendLaunch(next.lease).activeProcesses, 0);
});

test("Windows response-port loss poisons the controller and permits a fresh launch", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(
    () => runBackend(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      workerFault: "drop-response-port",
      controlTimeout: 500,
      timeout: 1000
    }),
    /launch.*deadline|poison/i
  );
  const next = runBackend(process.execPath, ["-e", "process.stdout.write('fresh')"], {
    timeout: 2000
  });
  assert.equal(next.stdout, "fresh");
});

test("malformed and oversized Windows controller frames poison and restart cleanly", {
  skip: process.platform !== "win32"
}, () => {
  const cwd = makeTempDir("protocol-faults-");
  for (const controllerFault of [
    "malformed-wait-frame",
    "oversize-wait-frame",
    "unknown-chunk-request",
    "duplicate-output-chunk",
    "mismatched-chunk-instance",
    "mismatched-chunk-action",
    "noncanonical-chunk-base64"
  ]) {
    const controllerPidFile = path.join(cwd, `${controllerFault}.pid`);
    assert.throws(
      () => runBackend(process.execPath, ["-e", ""], {
        controllerFault,
        controllerPidFile,
        controlTimeout: 500,
        timeout: 1000
      }),
      /cleanup proof missing|invalid|oversized|unknown|duplicate|sequence|instance|action|canonical|poison/i
    );
    const oldControllerPid = Number(fs.readFileSync(controllerPidFile, "utf8"));
    assert.throws(
      () => process.kill(oldControllerPid, 0),
      (error) => error?.code === "ESRCH"
    );
    const next = runBackend(process.execPath, ["-e", "process.stdout.write('fresh')"], {
      timeout: 2000
    });
    assert.equal(next.stdout, "fresh");
    cleanupBackendLaunch(next.lease);
  }
});

test("framed output corruption faults terminate the entire controller epoch", {
  skip: process.platform !== "win32"
}, () => {
  const cwd = makeTempDir("output-proof-faults-");
  for (const controllerFault of [
    "raw-oversize-output-chunk",
    "corrupt-stdout-length",
    "corrupt-stderr-length",
    "corrupt-stdout-sha256",
    "corrupt-stderr-sha256",
    "corrupt-stdout-chunk-count",
    "corrupt-stderr-chunk-count"
  ]) {
    const sibling = runBackend(process.execPath, ["-e", ""], {
      timeout: 2000
    });
    const controllerPidFile = path.join(cwd, `${controllerFault}.pid`);
    assert.throws(
      () => runBackend(
        process.execPath,
        ["-e", "process.stdout.write('proof')"],
        { controllerFault, controllerPidFile, timeout: 2000 }
      ),
      /chunk|proof|length|sha256|count|poison|terminal/i
    );
    const oldControllerPid = Number(fs.readFileSync(controllerPidFile, "utf8"));
    assert.throws(
      () => process.kill(oldControllerPid, 0),
      (error) => error?.code === "ESRCH"
    );
    assert.throws(
      () => cleanupBackendLaunch(sibling.lease),
      /Unknown Windows job launch/
    );
    const fresh = runBackend(
      process.execPath,
      ["-e", "process.stdout.write('fresh')"],
      { timeout: 2000 }
    );
    assert.notEqual(fresh.controllerInstanceId, sibling.controllerInstanceId);
    assert.notEqual(fresh.controllerPid, oldControllerPid);
    cleanupBackendLaunch(fresh.lease);
  }
});

test("oversized controller error reason closes its epoch without an oversized frame", {
  skip: process.platform !== "win32"
}, () => {
  const cwd = makeTempDir("oversized-error-reason-");
  const controllerPidFile = path.join(cwd, "controller.pid");
  assert.throws(
    () => runBackend(process.execPath, ["-e", ""], {
      controllerFault: "oversized-error-reason",
      controllerPidFile,
      timeout: 2000
    }),
    /controller|terminal|poison|frame/i
  );
  const oldControllerPid = Number(fs.readFileSync(controllerPidFile, "utf8"));
  assert.throws(
    () => process.kill(oldControllerPid, 0),
    (error) => error?.code === "ESRCH"
  );
  const fresh = runBackend(process.execPath, ["-e", ""], { timeout: 2000 });
  assert.notEqual(fresh.controllerPid, oldControllerPid);
  cleanupBackendLaunch(fresh.lease);
});

test("concurrent Windows cleanup callers replay one terminal proof", {
  skip: process.platform !== "win32"
}, () => {
  const result = runBackend(process.execPath, ["-e", ""], {
    controllerFault: "concurrent-cleanup",
    timeout: 2000
  });
  const proof = cleanupBackendLaunch(result.lease);
  assert.equal(proof.status, "stopped");
  assert.equal(proof.activeProcesses, 0);
  assert.equal(proof.launchId, result.launchId);
});

test("ambiguous Windows wait poisons the transport and leaves zero controller processes", {
  skip: process.platform !== "win32"
}, () => {
  const countSliceProcesses = () => {
    const probe = spawnSync("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=@(Get-CimInstance Win32_Process | ? { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*process-supervisor*native*windows*controller.ps1*' -or $_.CommandLine -like '*process-supervisor*native*windows*launch-shim.mjs*') }); $p.Count"
    ], { encoding: "utf8", windowsHide: true });
    return Number(probe.stdout.trim());
  };
  const baseline = countSliceProcesses();
  const backendUrl =
    new URL("./process-supervisor/backends/windows.mjs", import.meta.url).href;
  const source = [
    `import { createWindowsBackend } from ${JSON.stringify(backendUrl)};`,
    "const { test: { runWindowsJobForTest: runBackend } } = createWindowsBackend();",
    "try {",
    "runBackend(process.execPath, ['-e', 'setInterval(()=>{},1000)'],",
    "{ controllerFault: 'drop-wait-ack', controlTimeout: 500, timeout: 500 });",
    "} catch {}"
  ].join("\n");
  const faultStartedAt = Date.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(Date.now() - faultStartedAt < 4000, "poison shutdown must complete under its hard bound");
  assert.equal(countSliceProcesses(), baseline);
});

test("Windows job quota terminates a descendant writing after root exit", {
  skip: process.platform !== "win32"
}, async () => {
  const cwd = makeTempDir("post-root-quota-");
  const descendantPidFile = path.join(cwd, "descendant.pid");
  const descendantSource = [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.argv[1],String(process.pid));",
    "setTimeout(()=>setInterval(()=>process.stdout.write('x'.repeat(2048)),10),150);"
  ].join("");
  const rootSource = [
    "const{spawn}=require('node:child_process');",
    `const c=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)},process.env.PID_FILE],`,
    "{detached:true,stdio:'inherit',windowsHide:true});",
    "c.unref();process.stdout.write('root');"
  ].join("");
  const result = runBackend(process.execPath, ["-e", rootSource], {
    cwd,
    env: { ...process.env, PID_FILE: descendantPidFile },
    maxBuffer: 4096,
    timeout: 5000
  });
  assert.equal(result.stdout, "root");
  const pidDeadline = Date.now() + 2000;
  while (!fs.existsSync(descendantPidFile) && Date.now() < pidDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
  const quotaDeadline = Date.now() + 3000;
  let stopped = false;
  while (Date.now() < quotaDeadline) {
    try {
      process.kill(descendantPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      stopped = error?.code === "ESRCH";
      break;
    }
  }
  assert.equal(stopped, true, "job-wide quota must terminate the post-root descendant");
  const proof = cleanupBackendLaunch(result.lease);
  assert.equal(proof.activeProcesses, 0);
});

test("Windows output quota remains active for a descendant delayed beyond root completion", {
  skip: process.platform !== "win32"
}, async () => {
  const cwd = makeTempDir("delayed-job-quota-");
  const descendantPidFile = path.join(cwd, "descendant.pid");
  const descendantSource = [
    "const fs=require('node:fs');",
    "fs.writeFileSync(process.argv[1],String(process.pid));",
    "setTimeout(()=>setInterval(()=>process.stdout.write('x'.repeat(2048)),10),1200);"
  ].join("");
  const rootSource = [
    "const{spawn}=require('node:child_process');",
    `const c=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)},process.env.PID_FILE],`,
    "{detached:true,stdio:'inherit',windowsHide:true});",
    "c.unref();process.stdout.write('root');"
  ].join("");
  const result = runBackend(process.execPath, ["-e", rootSource], {
    cwd,
    env: { ...process.env, PID_FILE: descendantPidFile },
    maxBuffer: 4096,
    timeout: 5000
  });
  assert.equal(result.stdout, "root");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const proof = cleanupBackendLaunch(result.lease);
  assert.equal(proof.status, "stopped");
  assert.equal(proof.activeProcesses, 0);
  assert.equal(proof.errorCode, "ENOBUFS");
});

test("invalid cleanup proof poisons the exact old controller before restart", {
  skip: process.platform !== "win32"
}, () => {
  const cwd = makeTempDir("invalid-cleanup-proof-");
  const controllerPidFile = path.join(cwd, "controller.pid");
  const invalid = runBackend(process.execPath, ["-e", ""], {
    controllerFault: "invalid-cleanup-proof",
    controllerPidFile,
    controlTimeout: 1000,
    timeout: 2000
  });
  const sibling = runBackend(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeout: 5000 }
  );
  assert.equal(sibling.controllerInstanceId, invalid.controllerInstanceId);
  assert.throws(
    () => cleanupBackendLaunch(invalid.lease),
    /invalid (?:ownership )?terminal proof/i
  );
  const oldControllerPid = Number(fs.readFileSync(controllerPidFile, "utf8"));
  assert.throws(
    () => process.kill(oldControllerPid, 0),
    (error) => error?.code === "ESRCH"
  );
  assert.throws(
    () => cleanupBackendLaunch(sibling.lease),
    /Unknown Windows job launch/
  );
  const next = runBackend(process.execPath, ["-e", "process.stdout.write('fresh')"], {
    timeout: 2000
  });
  assert.notEqual(next.controllerPid, oldControllerPid);
  cleanupBackendLaunch(next.lease);
  assert.equal(getBackendLeaseCount(), 0);
});

test("cleanup proof controller PID is diagnostic rather than ownership", {
  skip: process.platform !== "win32"
}, () => {
  const diagnostic = runBackend(process.execPath, ["-e", ""], {
    controllerFault: "mismatched-controller-pid-proof",
    timeout: 2000
  });
  const proof = cleanupBackendLaunch(diagnostic.lease);
  assert.notEqual(proof.controllerPid, diagnostic.controllerPid);
  assert.equal(getBackendLeaseCount(), 0);

  const fresh = runBackend(process.execPath, ["-e", ""], {
    timeout: 2000
  });
  assert.equal(fresh.controllerPid, diagnostic.controllerPid);
  cleanupBackendLaunch(fresh.lease);
  assert.equal(getBackendLeaseCount(), 0);
});

test("idle acknowledged controller crash terminates Worker epoch and purges two leases", {
  skip: process.platform !== "win32"
}, async () => {
  const first = runBackend(process.execPath, ["-e", ""], { timeout: 2000 });
  const second = runBackend(process.execPath, ["-e", ""], { timeout: 2000 });
  assert.equal(first.controllerInstanceId, second.controllerInstanceId);
  assert.equal(first.controllerPid, second.controllerPid);
  const oldControllerPid = first.controllerPid;
  process.kill(oldControllerPid);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(oldControllerPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      assert.equal(error?.code, "ESRCH");
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const fresh = runBackend(
    process.execPath,
    ["-e", "process.stdout.write('fresh')"],
    { timeout: 2000 }
  );
  assert.notEqual(fresh.controllerInstanceId, first.controllerInstanceId);
  assert.notEqual(fresh.controllerPid, oldControllerPid);
  assert.throws(
    () => cleanupBackendLaunch(first.lease),
    /Unknown Windows job launch/
  );
  assert.throws(
    () => cleanupBackendLaunch(second.lease),
    /Unknown Windows job launch/
  );
  assert.equal(fresh.stdout, "fresh");
  cleanupBackendLaunch(fresh.lease);
});

test("replacement Windows Worker still performs repeatable explicit shutdown", {
  skip: process.platform !== "win32"
}, () => {
  const countSliceProcesses = () => {
    const result = spawnSync("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=@(Get-CimInstance Win32_Process | ? { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*process-supervisor*native*windows*controller.ps1*' -or $_.CommandLine -like '*process-supervisor*native*windows*launch-shim.mjs*') }); $p.Count"
    ], { encoding: "utf8", windowsHide: true });
    return Number(result.stdout.trim());
  };
  const baseline = countSliceProcesses();
  const cwd = makeTempDir("replacement-worker-");
  const oldControllerPidFile = path.join(cwd, "old-controller.pid");
  const replacementControllerPidFile = path.join(cwd, "replacement-controller.pid");
  const backendUrl =
    new URL("./process-supervisor/backends/windows.mjs", import.meta.url).href;
  const source = [
    `import { createWindowsBackend } from ${JSON.stringify(backendUrl)};`,
    "const backend=createWindowsBackend();",
    "const {runWindowsJobForTest:runBackend,cleanupWindowsJobForTest:cleanupBackendLaunch}=backend.test;",
    `const invalid=runBackend(process.execPath,['-e',''],{controllerFault:'invalid-cleanup-proof',controllerPidFile:${JSON.stringify(oldControllerPidFile)},timeout:2000});`,
    "try{cleanupBackendLaunch(invalid.lease)}catch{}",
    `const replacement=runBackend(process.execPath,['-e',"process.stdout.write('fresh')"],{controllerPidFile:${JSON.stringify(replacementControllerPidFile)},timeout:2000});`,
    "cleanupBackendLaunch(replacement.lease);",
    "await backend.shutdown();"
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  const oldControllerPid = Number(fs.readFileSync(oldControllerPidFile, "utf8"));
  const replacementControllerPid = Number(
    fs.readFileSync(replacementControllerPidFile, "utf8")
  );
  assert.notEqual(replacementControllerPid, oldControllerPid);
  for (const controllerPid of [oldControllerPid, replacementControllerPid]) {
    assert.throws(
      () => process.kill(controllerPid, 0),
      (error) => error?.code === "ESRCH"
    );
  }
  assert.equal(countSliceProcesses(), baseline);
});

test("Windows cleanup rejects mismatch and replay for every ownership tuple field", {
  skip: process.platform !== "win32"
}, async () => {
  const backend = createWindowsBackend();
  const result = backend.test.runWindowsJobForTest(
    process.execPath,
    ["-e", "process.stdout.write('owned')"],
    { timeout: 2000 }
  );
  const expected = result.lease.ownership;
  assert.deepEqual(Object.keys(expected).sort(), [
    "backend", "epoch", "nonce", "runId"
  ]);

  const proof = backend.test.cleanupWindowsJobForTest(result.lease);
  for (const field of ["epoch", "runId", "nonce", "backend"]) {
    assert.equal(proof[field], expected[field]);
    assert.throws(
      () => backend.test.cleanupWindowsJobForTest({
        ...result.lease,
        ownership: { ...expected, [field]: `${expected[field]}-replayed` }
      }),
      /ownership|unknown Windows job launch/i,
      `${field} replay must fail closed`
    );
  }
  await backend.shutdown();
});

test("Windows cleanup rejects native proof mismatch for every ownership tuple field", {
  skip: process.platform !== "win32"
}, async () => {
  for (const field of ["epoch", "runId", "nonce", "backend"]) {
    const backend = createWindowsBackend();
    const result = backend.test.runWindowsJobForTest(
      process.execPath,
      ["-e", "process.stdout.write('mismatch')"],
      {
        controllerFault: `mismatched-${field}-proof`,
        timeout: 2000
      }
    );
    assert.throws(
      () => backend.test.cleanupWindowsJobForTest(result.lease),
      /ownership|invalid terminal proof/i,
      `${field} proof mismatch must fail closed`
    );
    await backend.shutdown();
  }
});

test("two Windows backend instances isolate cleanup poison and shutdown", {
  skip: process.platform !== "win32"
}, async () => {
  const first = createWindowsBackend();
  const second = createWindowsBackend();
  const firstRun = first.test.runWindowsJobForTest(
    process.execPath,
    ["-e", "process.stdout.write('first')"],
    { controllerFault: "invalid-cleanup-proof", timeout: 2000 }
  );
  const secondRun = second.test.runWindowsJobForTest(
    process.execPath,
    ["-e", "process.stdout.write('second')"],
    { timeout: 2000 }
  );

  assert.equal(first.test.getWindowsJobLeaseCount(), 1);
  assert.equal(second.test.getWindowsJobLeaseCount(), 1);
  assert.throws(
    () => first.test.cleanupWindowsJobForTest(firstRun.lease),
    /invalid (?:ownership )?terminal proof/i
  );
  assert.equal(second.test.getWindowsJobLeaseCount(), 1);
  process.kill(secondRun.controllerPid, 0);

  await first.shutdown();
  process.kill(secondRun.controllerPid, 0);
  assert.equal(
    second.test.cleanupWindowsJobForTest(secondRun.lease).activeProcesses,
    0
  );
  await second.shutdown();
});

test("Windows backend shutdown stops infrastructure after cleanup failure", {
  skip: process.platform !== "win32"
}, async () => {
  const faults = {};
  const backend = createWindowsBackend({ faults });
  const {
    getWindowsJobLeaseCount: leaseCount,
    runWindowsJobForTest: backendRun
  } = backend.test;
  const result = backendRun(
    process.execPath,
    ["-e", "process.stdout.write('shutdown-cleanup-fault')"],
    { timeout: 2000 }
  );
  faults.shutdownCleanupFailure = true;

  await assert.rejects(
    backend.shutdown(),
    /injected Windows backend shutdown cleanup failure/i
  );
  assert.equal(leaseCount(), 0);
  assert.throws(
    () => process.kill(result.controllerPid, 0),
    (error) => error?.code === "ESRCH"
  );
});

test("Windows backend resets shutdown state after infrastructure stop failure", {
  skip: process.platform !== "win32"
}, async () => {
  const faults = { shutdownStopFailure: true };
  const backend = createWindowsBackend({ faults });

  await assert.rejects(
    backend.shutdown(),
    /injected Windows backend infrastructure stop failure/i
  );
  faults.shutdownStopFailure = false;
  const result = backend.test.runWindowsJobForTest(
    process.execPath,
    ["-e", "process.stdout.write('fresh-after-stop-fault')"],
    { timeout: 2000 }
  );
  assert.equal(result.stdout, "fresh-after-stop-fault");
  backend.test.cleanupWindowsJobForTest(result.lease);
  await backend.shutdown();
});
