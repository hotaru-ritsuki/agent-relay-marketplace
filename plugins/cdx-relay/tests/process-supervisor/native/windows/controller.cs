using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

public static class PersistentWindowsJobController
{
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000,
        EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x100, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1,
        JOB_OBJECT_ASSOCIATE_COMPLETION_PORT = 7;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, HANDLE_FLAG_INHERIT = 1,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002, WAIT_OBJECT_0 = 0,
        WAIT_TIMEOUT = 258, STILL_ACTIVE = 259,
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000,
        TH32CS_SNAPPROCESS = 0x00000002, JOB_OBJECT_MSG_NEW_PROCESS = 6;
    const int ERROR_ACCESS_DENIED = 5, ERROR_INVALID_PARAMETER = 87;
    const int MaxFrame = 4 * 1024 * 1024;

    enum LaunchState { Active, Terminating, Terminal }

    sealed class OutputSnapshot
    {
        public byte[] Stdout;
        public byte[] Stderr;
        public bool Overflow;
    }

    sealed class OutputCapture
    {
        readonly object Gate = new object();
        readonly MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
        readonly long maxBuffer;
        readonly Action overflowAction;
        long total;
        bool overflow;

        public OutputCapture(long maxBuffer, Action overflowAction)
        {
            this.maxBuffer = maxBuffer;
            this.overflowAction = overflowAction;
        }

        public void Append(bool isStdout, byte[] chunk, int count)
        {
            bool crossed = false;
            lock (Gate)
            {
                var target = isStdout ? stdout : stderr;
                long available = Math.Min(maxBuffer - target.Length, maxBuffer - total);
                int retained = (int)Math.Max(0, Math.Min(count, available));
                if (retained > 0)
                {
                    target.Write(chunk, 0, retained);
                    total += retained;
                }
                if (retained != count && !overflow)
                {
                    overflow = true;
                    crossed = true;
                }
                Monitor.PulseAll(Gate);
            }
            if (crossed) overflowAction();
        }

        public void Drain(Stream stream, SafeFileHandle handle, bool isStdout)
        {
            byte[] buffer = new byte[16 * 1024];
            while (true)
            {
                int read = 0;
                bool closed = false;
                lock (Gate)
                {
                    uint available = PipeAvailable(handle, out closed);
                    if (available > 0)
                    {
                        int wanted = (int)Math.Min((uint)buffer.Length, available);
                        read = stream.Read(buffer, 0, wanted);
                        if (read > 0) AppendLocked(isStdout, buffer, read);
                    }
                }
                if (closed || read == 0 && stream == null) return;
                if (read == 0) Thread.Sleep(2);
            }
        }

        void AppendLocked(bool isStdout, byte[] chunk, int count)
        {
            var target = isStdout ? stdout : stderr;
            long available = Math.Min(maxBuffer - target.Length, maxBuffer - total);
            int retained = (int)Math.Max(0, Math.Min(count, available));
            if (retained > 0)
            {
                target.Write(chunk, 0, retained);
                total += retained;
            }
            if (retained != count && !overflow)
            {
                overflow = true;
                Task.Run(overflowAction);
            }
            Monitor.PulseAll(Gate);
        }

        public OutputSnapshot FreezeRoot(
            SafeFileHandle stdoutHandle,
            SafeFileHandle stderrHandle,
            int timeoutMs)
        {
            lock (Gate)
            {
                bool stdoutClosed, stderrClosed;
                long stdoutWatermark = stdout.Length +
                    PipeAvailable(stdoutHandle, out stdoutClosed);
                long stderrWatermark = stderr.Length +
                    PipeAvailable(stderrHandle, out stderrClosed);
                long deadline = Environment.TickCount64 + timeoutMs;
                while (!overflow &&
                    (stdout.Length < stdoutWatermark || stderr.Length < stderrWatermark))
                {
                    long remaining = deadline - Environment.TickCount64;
                    if (remaining <= 0)
                        throw new TimeoutException("Root output watermark deadline expired.");
                    Monitor.Wait(Gate, (int)Math.Min(remaining, 20));
                }
                return new OutputSnapshot {
                    Stdout = Prefix(stdout, stdoutWatermark),
                    Stderr = Prefix(stderr, stderrWatermark),
                    Overflow = overflow
                };
            }
        }

        static byte[] Prefix(MemoryStream stream, long length)
        {
            byte[] all = stream.ToArray();
            if (length >= all.Length) return all;
            byte[] result = new byte[length];
            Buffer.BlockCopy(all, 0, result, 0, (int)length);
            return result;
        }
    }

    sealed class LaunchRecord : IDisposable
    {
        public readonly object Gate = new object();
        public string Id;
        public OwnershipIdentity Ownership;
        public string TargetPidDirectory;
        public string TargetPidFile;
        public string TestFault;
        public long MaxBuffer;
        public int TimeoutMs;
        public volatile bool Overflow, TimedOut;
        public volatile bool RootComplete;
        public OutputCapture Capture;
        public OutputSnapshot RootSnapshot;
        public int Pid, TargetPid;
        public SpawnErrorData SpawnError;
        public SafeFileHandle Job, Process, Thread;
        public SafeFileHandle CompletionPort;
        public readonly HashSet<int> JobProcessIds = new HashSet<int>();
        public FileStream Input, Output, Error;
        public Task<ShimResult> Completion;
        public Task StdoutDrain, StderrDrain;
        public Task<object> TerminalTask;
        public LaunchState State = LaunchState.Active;
        bool disposed;

        public void Dispose()
        {
            lock (Gate)
            {
                if (disposed) return;
                disposed = true;
                Input?.Dispose();
                Output?.Dispose();
                Error?.Dispose();
                if (!String.IsNullOrEmpty(TargetPidFile))
                {
                    try { File.Delete(TargetPidFile); } catch { }
                }
                if (!String.IsNullOrEmpty(TargetPidDirectory))
                {
                    try { Directory.Delete(TargetPidDirectory, true); } catch { }
                }
                Thread?.Dispose();
                Process?.Dispose();
                Job?.Dispose();
                CompletionPort?.Dispose();
            }
        }
    }

    sealed class OwnershipIdentity
    {
        public string epoch { get; set; }
        public string runId { get; set; }
        public string nonce { get; set; }
        public string backend { get; set; }
    }

    sealed class TerminalProof
    {
        public string epoch { get; set; }
        public string runId { get; set; }
        public string nonce { get; set; }
        public string backend { get; set; }
        public string controllerInstanceId { get; set; }
        public int controllerPid { get; set; }
        public string launchId { get; set; }
        public string status { get; set; }
        public uint activeProcesses { get; set; }
        public bool tombstone { get; set; }
        public string errorCode { get; set; }
    }

    sealed class TombstoneRecord
    {
        public OwnershipIdentity Ownership;
        public TerminalProof Proof;
    }

    sealed class ShimResult
    {
        public long? status { get; set; }
        public string signal { get; set; }
        public object error { get; set; }
    }

    sealed class SpawnErrorData
    {
        public string message { get; set; }
        public string code { get; set; }
        public int? errno { get; set; }
        public string syscall { get; set; }
        public string path { get; set; }
        public string[] spawnargs { get; set; }
    }

    sealed class TargetHandshake
    {
        public int? Pid;
        public SpawnErrorData Error;
    }

    static readonly ConcurrentDictionary<string, LaunchRecord> Launches =
        new ConcurrentDictionary<string, LaunchRecord>();
    static readonly ConcurrentDictionary<string, TombstoneRecord> Tombstones =
        new ConcurrentDictionary<string, TombstoneRecord>();
    static readonly Queue<string> TombstoneOrder = new Queue<string>();
    static readonly object TombstoneGate = new object(), WriteGate = new object();
    static Stream OutputStream;
    static string InstanceId;

    public static void Run(string nodeExecutable, string shimScript, Stream input, Stream output)
    {
        OutputStream = output;
        InstanceId = Guid.NewGuid().ToString("N");
        Write(new { type = "ready", controllerInstanceId = InstanceId });
        try
        {
            while (true)
            {
                var frame = ReadFrame(input);
                if (frame == null) break;
                Dispatch(frame.Value, nodeExecutable, shimScript);
            }
        }
        finally
        {
            foreach (var record in Launches.Values)
            {
                try { EnsureTerminal(record); } catch { }
            }
            Launches.Clear();
        }
    }

    static void Dispatch(JsonElement request, string node, string shim)
    {
        string type = request.GetProperty("type").GetString();
        long requestId = request.GetProperty("requestId").GetInt64();
        try
        {
            string supplied = request.GetProperty("controllerInstanceId").GetString();
            if (supplied != InstanceId) throw new InvalidOperationException("Controller instance mismatch.");
            if (type == "launch") HandleLaunch(request, requestId, node, shim);
            else if (type == "wait") HandleWait(request, requestId);
            else if (type == "cleanup") HandleCleanup(request, requestId);
            else throw new InvalidOperationException("Unsupported operation.");
        }
        catch (Exception error)
        {
            Write(new { requestId, action = type, controllerInstanceId = InstanceId, status = "error", reason = SafeReason(error) });
        }
    }

    static OwnershipIdentity ReadOwnership(JsonElement container)
    {
        JsonElement value = container.GetProperty("ownership");
        if (value.ValueKind != JsonValueKind.Object ||
            value.EnumerateObject().Count() != 4)
            throw new InvalidOperationException("Ownership tuple is invalid.");
        var ownership = new OwnershipIdentity {
            epoch = value.GetProperty("epoch").GetString(),
            runId = value.GetProperty("runId").GetString(),
            nonce = value.GetProperty("nonce").GetString(),
            backend = value.GetProperty("backend").GetString()
        };
        if (String.IsNullOrEmpty(ownership.epoch) ||
            String.IsNullOrEmpty(ownership.runId) ||
            String.IsNullOrEmpty(ownership.nonce) ||
            String.IsNullOrEmpty(ownership.backend))
            throw new InvalidOperationException("Ownership tuple is invalid.");
        return ownership;
    }

    static bool SameOwnership(OwnershipIdentity left, OwnershipIdentity right)
    {
        return left != null && right != null &&
            left.epoch == right.epoch &&
            left.runId == right.runId &&
            left.nonce == right.nonce &&
            left.backend == right.backend;
    }

    static void RequireOwnership(JsonElement request, OwnershipIdentity expected)
    {
        if (!SameOwnership(ReadOwnership(request), expected))
            throw new InvalidOperationException("Ownership tuple mismatch.");
    }

    static void HandleLaunch(JsonElement request, long requestId, string node, string shim)
    {
        JsonElement launch = request.GetProperty("launch");
        OwnershipIdentity ownership = ReadOwnership(launch);
        string launchId = Guid.NewGuid().ToString("N");
        string configuredFault = launch.TryGetProperty("testFault", out var configuredFaultElement) &&
            configuredFaultElement.ValueKind == JsonValueKind.String
            ? configuredFaultElement.GetString()
            : null;
        string faultPidPath = launch.TryGetProperty("faultPidFile", out var faultPidElement) &&
            faultPidElement.ValueKind == JsonValueKind.String
            ? faultPidElement.GetString()
            : null;
        var record = StartSuspended(node, shim, launchId, configuredFault, faultPidPath);
        try
        {
            record.Ownership = ownership;
            record.TestFault = configuredFault;
            if (launch.TryGetProperty("controllerPidFile", out var controllerPidFile) &&
                controllerPidFile.ValueKind == JsonValueKind.String)
                File.WriteAllText(controllerPidFile.GetString(), Environment.ProcessId.ToString());
            var options = launch.GetProperty("options");
            record.MaxBuffer = options.GetProperty("maxBuffer").GetInt64();
            record.TimeoutMs = options.TryGetProperty("timeout", out var timeout) &&
                timeout.ValueKind == JsonValueKind.Number ? timeout.GetInt32() : 0;
            record.Capture = new OutputCapture(record.MaxBuffer, () => MarkOverflow(record));
            record.StdoutDrain = DrainOutput(record, record.Output, true);
            record.StderrDrain = DrainOutput(record, record.Error, false);
            if (record.TestFault == "fail-assign")
                throw InjectedNativeFailure("AssignProcessToJobObject");
            if (!AssignProcessToJobObject(record.Job, record.Process))
                throw Win32("AssignProcessToJobObject");
            if (record.TestFault == "fail-after-assign")
                throw InjectedNativeFailure("post-AssignProcessToJobObject");
            if (ResumeThread(record.Thread) == UInt32.MaxValue)
                throw Win32("ResumeThread");
            record.Thread.Dispose();
            record.Thread = null;
            byte[] body = Encoding.UTF8.GetBytes(launch.GetRawText());
            record.Input.Write(body, 0, body.Length);
            record.Input.Dispose();
            record.Input = null;
            record.Completion = WaitRootCompletion(record);
            var handshake = WaitForTargetPidFile(record, 3000);
            record.TargetPid = handshake.Pid ?? 0;
            record.SpawnError = handshake.Error;
            Task.Run(() => MonitorJob(record));
            if (!Launches.TryAdd(launchId, record))
                throw new InvalidOperationException("Duplicate launch id.");
            if (launch.TryGetProperty("testFault", out var exitFault) &&
                exitFault.ValueKind == JsonValueKind.String &&
                exitFault.GetString() == "exit-after-launch")
                Environment.Exit(23);
            if (launch.TryGetProperty("testFault", out var fault) &&
                fault.ValueKind == JsonValueKind.String &&
                fault.GetString() == "drop-launch-ack") return;
            Write(new {
                requestId, action = "launch", status = "ok", controllerInstanceId = InstanceId,
                launchId,
                ownership,
                pid = record.SpawnError == null ? (int?)record.TargetPid : null,
                spawnError = record.SpawnError
            });
        }
        catch
        {
            try
            {
                if (record.Process != null && !record.Process.IsInvalid)
                    TerminateRetainedProcess(record.Process, "launch-failure shim");
            }
            finally { record.Dispose(); }
            throw;
        }
    }

    static Task DrainOutput(LaunchRecord record, FileStream stream, bool isStdout)
    {
        return Task.Run(() => {
            try { record.Capture.Drain(stream, stream.SafeFileHandle, isStdout); }
            catch (ObjectDisposedException) { }
        });
    }

    static Task<ShimResult> WaitRootCompletion(LaunchRecord record)
    {
        return Task.Run(() =>
        {
            uint waited = WaitForSingleObject(record.Process, UInt32.MaxValue);
            if (waited != WAIT_OBJECT_0)
                throw new InvalidOperationException("Shim wait failed: " + waited);
            if (!GetExitCodeProcess(record.Process, out uint exitCode))
                throw Win32("GetExitCodeProcess");
            record.RootSnapshot = record.Capture.FreezeRoot(
                record.Output.SafeFileHandle,
                record.Error.SafeFileHandle,
                3000);
            var result = new ShimResult {
                status = record.SpawnError == null ? (long?)exitCode : null,
                signal = null,
                error = record.SpawnError
            };
            record.RootComplete = true;
            return result;
        });
    }

    static void MarkOverflow(LaunchRecord record)
    {
        record.Overflow = true;
        TerminateJobOnce(record);
    }

    static void TerminateJobOnce(LaunchRecord record)
    {
        lock (record.Gate)
        {
            if (record.State != LaunchState.Active) return;
            record.State = LaunchState.Terminating;
            if (!TerminateJobObject(record.Job, 1))
                throw Win32("TerminateJobObject");
        }
    }

    static void MarkTimedOut(LaunchRecord record)
    {
        record.TimedOut = true;
        TerminateJobOnce(record);
    }

    static void MonitorJob(LaunchRecord record)
    {
        long deadline = record.TimeoutMs > 0
            ? Environment.TickCount64 + record.TimeoutMs
            : Int64.MaxValue;
        while (true)
        {
            uint active;
            try { active = ActiveProcesses(record.Job); }
            catch (ObjectDisposedException) { return; }
            if (active == 0) return;
            bool timedOut = Environment.TickCount64 >= deadline;
            if (timedOut)
            {
                MarkTimedOut(record);
                return;
            }
            Thread.Sleep(10);
        }
    }

    static void HandleWait(JsonElement request, long requestId)
    {
        string launchId = request.GetProperty("launchId").GetString();
        if (!Launches.TryGetValue(launchId, out var record))
            throw new InvalidOperationException("Unknown launch.");
        RequireOwnership(request, record.Ownership);
        if (record.TestFault == "drop-wait-ack") return;
        if (record.TestFault == "malformed-wait-frame")
        {
            WriteMalformedFrame(false);
            return;
        }
        if (record.TestFault == "oversize-wait-frame")
        {
            WriteMalformedFrame(true);
            return;
        }
        if (record.TestFault == "unknown-chunk-request" ||
            record.TestFault == "duplicate-output-chunk" ||
            record.TestFault == "mismatched-chunk-instance" ||
            record.TestFault == "mismatched-chunk-action" ||
            record.TestFault == "noncanonical-chunk-base64")
        {
            WriteOutputFault(requestId, record.TestFault);
            return;
        }
        if (record.TestFault == "raw-oversize-output-chunk")
        {
            WriteRawOversizeOutputChunk(requestId);
            return;
        }
        if (record.TestFault == "oversized-error-reason")
        {
            Write(new {
                requestId, action = "wait", controllerInstanceId = InstanceId,
                status = "error", reason = new string('x', MaxFrame * 2)
            });
            return;
        }
        Task.Run(async () =>
        {
            try
            {
                var result = await record.Completion.ConfigureAwait(false);
                object error = result.error;
                long? status = result.status;
                if (record.SpawnError != null)
                {
                    status = null;
                    error = record.SpawnError;
                }
                else if (record.RootSnapshot.Overflow)
                {
                    status = null;
                    error = new { message = "stdout or stderr exceeded maxBuffer", code = "ENOBUFS" };
                }
                else if (record.TimedOut)
                {
                    status = null;
                    error = new { message = "process timed out", code = "ETIMEDOUT" };
                }
                WriteOutputChunks(requestId, record.RootSnapshot);
                Write(new { requestId, action = "wait", controllerInstanceId = InstanceId, status = "ok", result = new {
                    record.Ownership.epoch, record.Ownership.runId,
                    record.Ownership.nonce, record.Ownership.backend,
                    status, result.signal, error,
                    stdout = OutputProof(record.RootSnapshot.Stdout, record.TestFault, "stdout"),
                    stderr = OutputProof(record.RootSnapshot.Stderr, record.TestFault, "stderr")
                }});
            }
            catch (Exception error)
            {
                if (record.RootSnapshot != null || record.Overflow || record.TimedOut)
                {
                    var snapshot = record.RootSnapshot ?? new OutputSnapshot {
                        Stdout = new byte[0], Stderr = new byte[0], Overflow = record.Overflow
                    };
                    WriteOutputChunks(requestId, snapshot);
                    Write(new { requestId, action = "wait", controllerInstanceId = InstanceId, status = "ok", result = new {
                        record.Ownership.epoch, record.Ownership.runId,
                        record.Ownership.nonce, record.Ownership.backend,
                        status = (long?)null,
                        signal = (string)null,
                        error = record.Overflow
                            ? (object)new { message = "stdout or stderr exceeded maxBuffer", code = "ENOBUFS" }
                            : new { message = "process timed out", code = "ETIMEDOUT" },
                        stdout = OutputProof(snapshot.Stdout, record.TestFault, "stdout"),
                        stderr = OutputProof(snapshot.Stderr, record.TestFault, "stderr")
                    }});
                }
                else Write(new { requestId, action = "wait", controllerInstanceId = InstanceId, status = "error", reason = SafeReason(error) });
            }
        });
    }

    static void HandleCleanup(JsonElement request, long requestId)
    {
        string launchId = request.GetProperty("launchId").GetString();
        if (Tombstones.TryGetValue(launchId, out var tombstone))
        {
            RequireOwnership(request, tombstone.Ownership);
            Write(new { requestId, action = "cleanup", controllerInstanceId = InstanceId, status = "ok", result = tombstone.Proof });
            return;
        }
        if (!Launches.TryGetValue(launchId, out var record))
            throw new InvalidOperationException("Unknown launch.");
        RequireOwnership(request, record.Ownership);
        if (record.TestFault == "drop-cleanup-ack") return;
        if (record.TestFault == "invalid-cleanup-proof")
        {
            Write(new { requestId, action = "cleanup", controllerInstanceId = InstanceId, status = "ok", result = new {
                record.Ownership.epoch, record.Ownership.runId,
                record.Ownership.nonce, record.Ownership.backend,
                controllerInstanceId = InstanceId,
                controllerPid = Environment.ProcessId + 1,
                launchId,
                status = "stopped",
                activeProcesses = 1,
                tombstone = false
            }});
            return;
        }
        if (record.TestFault == "mismatched-controller-pid-proof")
        {
            Write(new { requestId, action = "cleanup", controllerInstanceId = InstanceId, status = "ok", result = new {
                record.Ownership.epoch, record.Ownership.runId,
                record.Ownership.nonce, record.Ownership.backend,
                controllerInstanceId = InstanceId,
                controllerPid = Environment.ProcessId + 1,
                launchId,
                status = "stopped",
                activeProcesses = 0,
                tombstone = true,
                errorCode = (string)null
            }});
            return;
        }
        Task.Run(() =>
        {
            try
            {
                Write(new { requestId, action = "cleanup", controllerInstanceId = InstanceId, status = "ok", result = EnsureTerminal(record) });
            }
            catch (Exception error)
            {
                Write(new { requestId, action = "cleanup", controllerInstanceId = InstanceId, status = "error", reason = SafeReason(error) });
            }
        });
    }

    static object EnsureTerminal(LaunchRecord record)
    {
        Task<object> terminal;
        lock (record.Gate)
        {
            if (record.TerminalTask == null)
                record.TerminalTask = Task.Run<object>(() => TerminateAndProve(record));
            terminal = record.TerminalTask;
        }
        return terminal.GetAwaiter().GetResult();
    }

    static object TerminateAndProve(LaunchRecord record)
    {
        lock (record.Gate)
        {
            if (record.State == LaunchState.Active)
            {
                record.State = LaunchState.Terminating;
                if (!TerminateJobObject(record.Job, 1))
                    throw Win32("TerminateJobObject");
            }
        }
        uint waited = WaitForSingleObject(record.Process, 5000);
        if (waited != WAIT_OBJECT_0)
            throw new InvalidOperationException(waited == WAIT_TIMEOUT
                ? "Cleanup deadline expired waiting for shim."
                : "Cleanup shim wait failed: " + waited);
        try { record.Completion.GetAwaiter().GetResult(); } catch { }
        var deadline = Environment.TickCount64 + 5000;
        uint active;
        do {
            active = ActiveProcesses(record.Job);
            if (active == 0) break;
            Thread.Sleep(20);
        } while (Environment.TickCount64 < deadline);
        if (active != 0) throw new InvalidOperationException("Cleanup retained active processes.");
        if (!Task.WaitAll(new[] { record.StdoutDrain, record.StderrDrain }, 3000))
            throw new InvalidOperationException("Cleanup output-drain deadline expired.");
        lock (record.Gate) record.State = LaunchState.Terminal;
        var proof = new TerminalProof {
            epoch = record.Ownership.epoch,
            runId = record.Ownership.runId,
            nonce = record.Ownership.nonce,
            backend = record.Ownership.backend,
            controllerInstanceId = InstanceId,
            controllerPid = Environment.ProcessId,
            launchId = record.Id,
            status = "stopped",
            activeProcesses = 0,
            tombstone = true,
            errorCode = record.Overflow ? "ENOBUFS" : record.TimedOut ? "ETIMEDOUT" : null
        };
        if (record.TestFault == "mismatched-epoch-proof")
            proof.epoch += "-mismatch";
        else if (record.TestFault == "mismatched-runId-proof")
            proof.runId += "-mismatch";
        else if (record.TestFault == "mismatched-nonce-proof")
            proof.nonce += "-mismatch";
        else if (record.TestFault == "mismatched-backend-proof")
            proof.backend += "-mismatch";
        Launches.TryRemove(record.Id, out _);
        AddTombstone(record.Id, record.Ownership, proof);
        record.Dispose();
        return proof;
    }

    static void AddTombstone(
        string id,
        OwnershipIdentity ownership,
        TerminalProof proof)
    {
        lock (TombstoneGate)
        {
            Tombstones[id] = new TombstoneRecord {
                Ownership = ownership,
                Proof = proof
            };
            TombstoneOrder.Enqueue(id);
            while (TombstoneOrder.Count > 128)
                Tombstones.TryRemove(TombstoneOrder.Dequeue(), out _);
        }
    }

    static LaunchRecord StartSuspended(
        string node,
        string shim,
        string id,
        string fault,
        string faultPidPath)
    {
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES {
            nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = true
        };
        SafeFileHandle stdinRead = null, stdinWrite = null, stdoutRead = null,
            stdoutWrite = null, stderrRead = null, stderrWrite = null;
        try
        {
            CreateSafePipe(out stdinRead, out stdinWrite, ref sa);
            CreateSafePipe(out stdoutRead, out stdoutWrite, ref sa);
            CreateSafePipe(out stderrRead, out stderrWrite, ref sa);
            if (fault == "fail-set-handle")
                throw InjectedNativeFailure("SetHandleInformation");
            if (!SetHandleInformation(stdinWrite.DangerousGetHandle(), HANDLE_FLAG_INHERIT, 0))
                throw Win32("SetHandleInformation(stdin)");
            if (!SetHandleInformation(stdoutRead.DangerousGetHandle(), HANDLE_FLAG_INHERIT, 0))
                throw Win32("SetHandleInformation(stdout)");
            if (!SetHandleInformation(stderrRead.DangerousGetHandle(), HANDLE_FLAG_INHERIT, 0))
                throw Win32("SetHandleInformation(stderr)");
        }
        catch
        {
            stdinRead?.Dispose(); stdinWrite?.Dispose();
            stdoutRead?.Dispose(); stdoutWrite?.Dispose();
            stderrRead?.Dispose(); stderrWrite?.Dispose();
            throw;
        }
        IntPtr attributeList = IntPtr.Zero, attributeValue = IntPtr.Zero;
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdinRead.DangerousGetHandle();
        startup.StartupInfo.hStdOutput = stdoutWrite.DangerousGetHandle();
        startup.StartupInfo.hStdError = stderrWrite.DangerousGetHandle();
        LaunchRecord record = null;
        string targetPidDirectory = Path.Combine(
            Path.GetTempPath(), "cdx-job-target-" + id + "-" + Guid.NewGuid().ToString("N"));
        CreatePrivateDirectory(targetPidDirectory);
        string targetPidFile = Path.Combine(targetPidDirectory, "target.json");
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributeList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
                throw Win32("InitializeProcThreadAttributeList");
            IntPtr[] handles = {
                stdinRead.DangerousGetHandle(),
                stdoutWrite.DangerousGetHandle(),
                stderrWrite.DangerousGetHandle()
            };
            attributeValue = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            Marshal.Copy(handles, 0, attributeValue, handles.Length);
            if (!UpdateProcThreadAttribute(attributeList, 0,
                (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST, attributeValue,
                (IntPtr)(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero))
                throw Win32("UpdateProcThreadAttribute");
            startup.lpAttributeList = attributeList;
            PROCESS_INFORMATION pi;
            string commandLine = Quote(node) + " " + Quote(shim) + " " +
                Quote(targetPidFile);
            if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero, null, ref startup, out pi))
                throw Win32("CreateProcessW");
            record = new LaunchRecord {
                Id = id,
                Pid = (int)pi.dwProcessId,
                TargetPidDirectory = targetPidDirectory,
                TargetPidFile = targetPidFile
            };
            record.Process = new SafeFileHandle(pi.hProcess, true);
            record.Thread = new SafeFileHandle(pi.hThread, true);
            record.Input = new FileStream(stdinWrite, FileAccess.Write);
            record.Output = new FileStream(stdoutRead, FileAccess.Read);
            record.Error = new FileStream(stderrRead, FileAccess.Read);
            stdinWrite = stdoutRead = stderrRead = null;
            if (!String.IsNullOrEmpty(faultPidPath))
                File.WriteAllText(faultPidPath, record.Pid.ToString());
            if (fault == "fail-job-create")
                throw InjectedNativeFailure("CreateJobObject");
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job.IsInvalid) {
                job.Dispose();
                throw Win32("CreateJobObject");
            }
            record.Job = job;
            if (fault == "fail-job-config")
                throw InjectedNativeFailure("SetInformationJobObject");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            IntPtr info = Marshal.AllocHGlobal(length);
            try {
                Marshal.StructureToPtr(limits, info, false);
                if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, (uint)length))
                    throw Win32("SetInformationJobObject");
            } finally { Marshal.FreeHGlobal(info); }
            record.CompletionPort = CreateIoCompletionPort(
                new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            if (record.CompletionPort.IsInvalid)
                throw Win32("CreateIoCompletionPort");
            var association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT_INFO {
                CompletionKey = new IntPtr(1),
                CompletionPort = record.CompletionPort.DangerousGetHandle()
            };
            int associationLength =
                Marshal.SizeOf<JOBOBJECT_ASSOCIATE_COMPLETION_PORT_INFO>();
            IntPtr associationInfo = Marshal.AllocHGlobal(associationLength);
            try
            {
                Marshal.StructureToPtr(association, associationInfo, false);
                if (!SetInformationJobObject(
                    job,
                    JOB_OBJECT_ASSOCIATE_COMPLETION_PORT,
                    associationInfo,
                    (uint)associationLength))
                    throw Win32("SetInformationJobObject(completion port)");
            }
            finally { Marshal.FreeHGlobal(associationInfo); }
            return record;
        }
        catch
        {
            try
            {
                if (record != null && record.Process != null && !record.Process.IsInvalid)
                {
                    TerminateRetainedProcess(record.Process, "bootstrap shim");
                }
            }
            finally { record?.Dispose(); }
            throw;
        }
        finally
        {
            stdinRead?.Dispose();
            stdoutWrite?.Dispose();
            stderrWrite?.Dispose();
            stdinWrite?.Dispose();
            stdoutRead?.Dispose();
            stderrRead?.Dispose();
            if (attributeList != IntPtr.Zero) {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (attributeValue != IntPtr.Zero) Marshal.FreeHGlobal(attributeValue);
        }
    }

    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static void CreatePrivateDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        var identity = WindowsIdentity.GetCurrent().User;
        if (identity == null)
            throw new InvalidOperationException(
                "Current Windows identity has no security identifier.");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(
            identity,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        FileSystemAclExtensions.SetAccessControl(
            new DirectoryInfo(directory), security);
    }
    static void CreateSafePipe(
        out SafeFileHandle read,
        out SafeFileHandle write,
        ref SECURITY_ATTRIBUTES sa)
    {
        IntPtr rawRead, rawWrite;
        if (!CreatePipe(out rawRead, out rawWrite, ref sa, 0)) throw Win32("CreatePipe");
        read = new SafeFileHandle(rawRead, true);
        write = new SafeFileHandle(rawWrite, true);
    }
    static Exception Win32(string operation)
    { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static Exception InjectedNativeFailure(string operation)
    { return new InvalidOperationException("Injected native failure at " + operation + "."); }

    static void TerminateRetainedProcess(SafeFileHandle process, string label)
    {
        bool terminated = TerminateProcess(process, 1);
        if (!terminated)
        {
            uint alreadyExited = WaitForSingleObject(process, 0);
            if (alreadyExited != WAIT_OBJECT_0)
                throw Win32("TerminateProcess(" + label + ")");
        }
        uint waited = WaitForSingleObject(process, 3000);
        if (waited != WAIT_OBJECT_0)
            throw new InvalidOperationException(
                label + " termination was not confirmed: " + waited);
    }

    static uint ActiveProcesses(SafeFileHandle job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        uint returned;
        if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
            out info, (uint)Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), out returned))
            throw Win32("QueryInformationJobObject");
        return info.ActiveProcesses;
    }

    static TargetHandshake WaitForTargetPidFile(LaunchRecord record, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        try
        {
            while (Environment.TickCount64 < deadline)
            {
                if (File.Exists(record.TargetPidFile))
                {
                    try
                    {
                        using var document = JsonDocument.Parse(
                            File.ReadAllText(record.TargetPidFile));
                        var root = document.RootElement;
                        if (root.ValueKind != JsonValueKind.Object)
                            throw new InvalidDataException(
                                "Target PID handshake must be an object.");
                        bool hasPid = root.TryGetProperty("pid", out var pidElement);
                        bool hasParent = root.TryGetProperty(
                            "parentPid", out var parentElement);
                        bool hasError = root.TryGetProperty("error", out var errorElement);
                        int propertyCount = root.EnumerateObject().Count();
                        if (hasError && (hasPid || hasParent || propertyCount != 1) ||
                            !hasError && (!hasPid || !hasParent || propertyCount != 2))
                            throw new InvalidDataException(
                                "Target PID handshake had an invalid schema.");
                        if (hasError)
                        {
                            var error = JsonSerializer.Deserialize<SpawnErrorData>(
                                errorElement.GetRawText());
                            if (error == null || String.IsNullOrEmpty(error.message) ||
                                String.IsNullOrEmpty(error.code) ||
                                String.IsNullOrEmpty(error.path) ||
                                error.spawnargs == null)
                                throw new InvalidDataException(
                                    "Target spawn error handshake was invalid.");
                            return new TargetHandshake { Error = error };
                        }
                        if (pidElement.ValueKind != JsonValueKind.Number ||
                            !pidElement.TryGetInt32(out int pid) || pid <= 0)
                            throw new InvalidDataException(
                                "Target PID handshake did not contain a positive PID.");
                        if (parentElement.ValueKind != JsonValueKind.Number ||
                            !parentElement.TryGetInt32(out int parentPid) ||
                            parentPid != record.Pid)
                            throw new InvalidDataException(
                                "Published target PID did not bind the shim as its parent.");
                        ValidateTargetProcess(record, pid, deadline);
                        return new TargetHandshake { Pid = pid };
                    }
                    catch (IOException error) when (IsSharingOrLockViolation(error))
                    {
                        // The exclusive publisher has made the directory entry
                        // visible but has not yet closed its final handle.
                    }
                }
                Thread.Sleep(2);
            }
            throw new TimeoutException(
                "Target process PID publication deadline expired.");
        }
        finally
        {
            try { File.Delete(record.TargetPidFile); } catch { }
        }
    }

    static bool IsSharingOrLockViolation(IOException error)
    {
        int code = error.HResult & 0xffff;
        return code == 32 || code == 33;
    }

    static void ValidateTargetProcess(LaunchRecord record, int pid, long deadline)
    {
        if (pid == record.Pid)
            throw new InvalidDataException(
                "Published target PID was the shim rather than its direct child.");
        while (!record.JobProcessIds.Contains(pid) &&
               Environment.TickCount64 < deadline)
        {
            DrainJobNotifications(record, 10);
        }
        if (!record.JobProcessIds.Contains(pid))
            throw new InvalidDataException(
                "Published target PID has no retained Job membership proof.");
        SafeFileHandle process;
        int openError;
        if (record.TestFault == "pid-handshake-invalid-handle")
        {
            process = new SafeFileHandle(IntPtr.Zero, false);
            openError = ERROR_ACCESS_DENIED;
        }
        else
        {
            process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            openError = Marshal.GetLastWin32Error();
        }
        using (process)
        {
            if (process.IsInvalid)
            {
                if (openError == ERROR_INVALID_PARAMETER) return;
                throw new Win32Exception(
                    openError, "OpenProcess(target PID handshake)");
            }
            if (!IsProcessInJob(process, record.Job, out bool member))
                throw Win32("IsProcessInJob(target PID handshake)");
            if (!member)
                throw new InvalidDataException(
                    "Published target PID is not a member of the retained Job.");
            try
            {
                uint parent = ParentProcessId((uint)pid);
                if (parent != (uint)record.Pid)
                    throw new InvalidDataException(
                        "Published target PID is not the shim's direct child.");
            }
            catch (InvalidDataException)
            {
                if (!GetExitCodeProcess(process, out uint exitCode))
                    throw Win32("GetExitCodeProcess(target PID handshake)");
                if (exitCode == STILL_ACTIVE) throw;
            }
        }
    }

    static void DrainJobNotifications(LaunchRecord record, uint timeoutMs)
    {
        bool dequeued = GetQueuedCompletionStatus(
            record.CompletionPort,
            out uint message,
            out UIntPtr completionKey,
            out IntPtr overlapped,
            timeoutMs);
        if (!dequeued)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == (int)WAIT_TIMEOUT) return;
            throw new Win32Exception(error, "GetQueuedCompletionStatus");
        }
        if (message == JOB_OBJECT_MSG_NEW_PROCESS)
            record.JobProcessIds.Add(checked((int)overlapped.ToInt64()));
    }

    static uint ParentProcessId(uint pid)
    {
        using var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot.IsInvalid)
            throw Win32("CreateToolhelp32Snapshot");
        var entry = new PROCESSENTRY32 {
            dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>()
        };
        if (!Process32FirstW(snapshot, ref entry))
            throw Win32("Process32First");
        do
        {
            if (entry.th32ProcessID == pid)
                return entry.th32ParentProcessID;
        } while (Process32NextW(snapshot, ref entry));
        throw new InvalidDataException(
            "Published target PID was absent from the process snapshot.");
    }

    static JsonElement? ReadFrame(Stream stream)
    {
        byte[] header = new byte[4];
        int first = stream.Read(header, 0, 4);
        if (first == 0) return null;
        ReadExact(stream, header, first, 4 - first);
        int length = BitConverter.ToInt32(header, 0);
        if (length < 0 || length > MaxFrame) throw new InvalidDataException("Invalid frame length.");
        byte[] payload = new byte[length];
        ReadExact(stream, payload, 0, length);
        using (var document = JsonDocument.Parse(payload))
            return document.RootElement.Clone();
    }
    static void ReadExact(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0) {
            int read = stream.Read(buffer, offset, count);
            if (read == 0) throw new EndOfStreamException();
            offset += read; count -= read;
        }
    }
    static void Write(object value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length > MaxFrame)
        {
            Environment.Exit(25);
            throw new InvalidDataException("Controller response exceeds the frame limit.");
        }
        byte[] header = BitConverter.GetBytes(payload.Length);
        lock (WriteGate) {
            OutputStream.Write(header, 0, header.Length);
            OutputStream.Write(payload, 0, payload.Length);
            OutputStream.Flush();
        }
    }

    static void WriteMalformedFrame(bool oversized)
    {
        lock (WriteGate)
        {
            byte[] header = BitConverter.GetBytes(oversized ? MaxFrame + 1 : 1);
            OutputStream.Write(header, 0, header.Length);
            if (!oversized) OutputStream.WriteByte((byte)'{');
            OutputStream.Flush();
        }
    }

    static void WriteOutputFault(long requestId, string fault)
    {
        long emittedRequestId = fault == "unknown-chunk-request"
            ? requestId + 1000 : requestId;
        string instance = fault == "mismatched-chunk-instance"
            ? "wrong-controller-instance" : InstanceId;
        string action = fault == "mismatched-chunk-action" ? "cleanup" : "wait";
        string data = fault == "noncanonical-chunk-base64" ? "A===" : "";
        var frame = new {
            type = "output-chunk", requestId = emittedRequestId, action,
            controllerInstanceId = instance, stream = "stdout",
            sequence = 0, dataBase64 = data
        };
        Write(frame);
        if (fault == "duplicate-output-chunk") Write(frame);
    }

    static void WriteRawOversizeOutputChunk(long requestId)
    {
        byte[] raw = new byte[512 * 1024 + 1];
        Write(new {
            type = "output-chunk", requestId, action = "wait",
            controllerInstanceId = InstanceId, stream = "stdout",
            sequence = 0, dataBase64 = Convert.ToBase64String(raw)
        });
    }

    static object OutputProof(byte[] value, string fault, string stream)
    {
        using (var sha = SHA256.Create())
        {
            string hash = BitConverter.ToString(sha.ComputeHash(value))
                .Replace("-", "").ToLowerInvariant();
            int count = (value.Length + 524287) / 524288;
            long length = value.Length;
            if (fault == "corrupt-" + stream + "-length") length++;
            if (fault == "corrupt-" + stream + "-sha256")
                hash = new string('0', 64);
            if (fault == "corrupt-" + stream + "-chunk-count") count++;
            return new { length, sha256 = hash, chunkCount = count };
        }
    }

    static string SafeReason(Exception error)
    {
        string reason = error == null ? "controller error" : error.Message;
        if (String.IsNullOrEmpty(reason)) return "controller error";
        return reason.Length <= 4096 ? reason : reason.Substring(0, 4096);
    }

    static void WriteOutputChunks(long requestId, OutputSnapshot snapshot)
    {
        WriteOutputStream(requestId, "stdout", snapshot.Stdout);
        WriteOutputStream(requestId, "stderr", snapshot.Stderr);
    }

    static void WriteOutputStream(long requestId, string stream, byte[] value)
    {
        const int chunkSize = 512 * 1024;
        int sequence = 0;
        for (int offset = 0; offset < value.Length; offset += chunkSize)
        {
            int length = Math.Min(chunkSize, value.Length - offset);
            string encoded = Convert.ToBase64String(value, offset, length);
            Write(new {
                type = "output-chunk", requestId, action = "wait",
                controllerInstanceId = InstanceId, stream, sequence,
                dataBase64 = encoded
            });
            sequence++;
        }
    }

    static uint PipeAvailable(SafeFileHandle handle, out bool closed)
    {
        uint available;
        if (PeekNamedPipe(handle, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
        {
            closed = false;
            return available;
        }
        int error = Marshal.GetLastWin32Error();
        if (error == 109)
        {
            closed = true;
            return 0;
        }
        throw new Win32Exception(error, "PeekNamedPipe");
    }

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES
    { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO
    { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)]
        public string szExeFile;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT_INFO
    { public IntPtr CompletionKey; public IntPtr CompletionPort; }

    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(SafeFileHandle pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr left);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application,string command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateJobObjectW(IntPtr attributes,string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job,int infoClass,IntPtr info,uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(SafeFileHandle job,SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(SafeFileHandle job,uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(SafeFileHandle process,uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(SafeFileHandle process,out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(SafeFileHandle job,int infoClass,out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info,uint length,out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle CreateIoCompletionPort(IntPtr fileHandle,IntPtr existingCompletionPort,UIntPtr completionKey,uint concurrentThreads);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(SafeFileHandle completionPort,out uint bytes,out UIntPtr completionKey,out IntPtr overlapped,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,[MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags,uint processId);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(SafeFileHandle snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(SafeFileHandle snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeFileHandle handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
}
