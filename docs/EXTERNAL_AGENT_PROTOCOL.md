# External agent protocol (FR-013)

Protocol version 1 uses one process per probe or turn, JSON Lines on stdin/stdout,
and the same environment allowlist, deadlines, output limits and process-group
termination as the built-in CLI backends. No provider is discovered automatically.

Set `RESEARCH_EXTERNAL_AGENTS` to an owner-controlled UTF-8 JSON registration file:

```json
[{
  "agentId": "scripted",
  "displayName": "Scripted example agent",
  "costModel": "plan-limited",
  "toolIsolation": "enforced",
  "command": "node",
  "args": ["/absolute/repo/examples/extensions/externalProcess/scripted.ts"],
  "cwd": "/absolute/repo",
  "envKeys": []
}]
```

Metadata follows `AgentDescriptor` validation. `cwd` must be absolute. `args` are
literal arguments, never shell text. The complete child environment contains only
nonempty PATH, HOME, USER, LANG, LC_ALL, TMPDIR, TERM and the explicitly registered
`envKeys`. Declared billing and isolation are the owner's claims; the orchestrator
continues to apply its normal spend and isolation policy. Protect registration
files like executable code. Never register untrusted executables or forward secrets
unnecessarily.

`create_agent_runtimes` defaults to the five built-in backends followed by these
registrations. `RESEARCH_AGENT_SET=baseline` selects the four baseline backends;
`external-only` selects only registrations. Unknown modes are configuration errors.
The registry refuses duplicate ids.

For a probe the adapter appends `probe` to args, closes empty stdin and expects
one JSON object (only these keys):

```json
{"protocol":1,"capabilities":{"supported":["stream"]},"availability":{"status":"available"}}
```

Capabilities and availability use the strict public contracts. A nonzero exit,
invalid envelope or output, or 15-second timeout becomes `PROBE_FAILED`; ENOENT
becomes `NOT_INSTALLED`. Capture is bounded to 262144 UTF-16 units.

For a run it appends `run` and writes exactly one object, newline, then EOF:

```json
{"protocol":1,"request":{"runId":"r","conversationId":"c","prompt":"hello","permittedToolIds":[],"maxToolCalls":0,"deadline":"2030-01-01T00:00:00Z"},"context":{"scratchDirectory":null,"model":null,"effort":"medium"}}
```

The process cwd is the registration cwd. The scratch path is data in the request;
it need not exist for a backend that does not use it. Each stdout line must be an
`AgentEvent`. Stderr is bounded diagnostics and never model output. The adapter
forwards text and permitted tool requests within the request's tool-call budget,
remembers last usage, and stops on the first completed or failed event. Usage is
emitted exactly once immediately before that terminal event. `tool.result` and
`ui.command` are ignored. Invalid or unpermitted event lines count toward the
shared malformed-line budget (8 tolerated; the ninth fails). EOF without a
terminal event fails. Text is capped at 2 Mi UTF-16 units and raw output at 32 Mi.
Cancellation/deadline kills the process group; terminal events follow bounded
reaping. A consumer must call `AgentTurn::close().await` after early termination.

The executable may end immediately after its terminal event. No cancellation
message is sent. All per-instance state is lost between invocations; a future
multiplexed long-lived mode would require another protocol version.

TypeScript backends call `serveExternalAgent(runtime)` from
`examples/extensions/externalProcess/serve.ts`. The scripted example is runnable
with Node's TypeScript support. The wrapper validates requests/events, emits one
terminal event, and coalesces adjacent text deltas split between a surrogate pair
before JSON serialization. An actual lone surrogate becomes U+FFFD, matching the
Rust string representation. Wave C can wrap its own `createScriptedAgent({reply})`
without changing runner or orchestrator code.

Unix packaging must install the `research-provider-spawn` companion executable
beside `research-runner`. It calls `setsid` then execs the CLI without a shell,
using safe rustix APIs. `UnixProcessRunner::with_helper` supports another explicit
trusted installation path. A private stderr readiness handshake prevents an abort
from racing session creation; that handshake is removed before stderr capture.
The provider crate currently targets Unix, as the existing deployment does.
