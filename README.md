# Autonomous Memory · qq-bridge Plugin

> Full installation / usage / troubleshooting: **[USAGE.zh-CN.md](./USAGE.zh-CN.md)**.
> This file is the quick reference.

Gives the agent a chance to **write down what it considers important before the bridge
stops**, and **compensates on the next start** if the previous stop was unclean
(system shutdown, crash, kill).

- Bridge stops gracefully → the agent gets one nudge: "before you go, anything worth
  remembering?" It writes a memo if it wants, or does nothing.
- Bridge died unexpectedly → on the next start it gets a "you never finished last time,
  anything to catch up on?" nudge.
- Diaries are untouched: the agent may still write them whenever it likes.

Each memo is a **new file** under the configured memo directory
(`备忘-YYYYMMDD-HHmmss.md`), so nothing is ever overwritten.

## How it fits

```
QQ client ──► OneBot gateway ──► qq-bridge ──► DSH agent
                                     ▲
                         this plugin runs here
```

It is a **qq-bridge plugin**, so it only runs while the bridge runs. It does not appear
in the DSH plugin marketplace.

## Hook points

| Trigger | Behaviour |
|---|---|
| Graceful stop (`POST /api/plugin/memory/shutdown`, SIGINT, SIGTERM) | Deliver a wrap-up nudge, wait `shutdownWaitMs`, then exit |
| Next start, previous stop recorded | Silent (logs "clean previous exit") |
| Next start, previous stop missing | Deliver a catch-up nudge |

## Install

1. Copy this directory next to your bridge, e.g. `qq-bridge/plugins/autonomous-memory/`.
2. Import it in `src/bridge.js`:

   ```js
   import { createAutonomousMemory } from '../plugins/autonomous-memory/index.js';
   ```

3. Create the instance after the DSH session plumbing is available:

   ```js
   const memoryPlugin = createAutonomousMemory({
     getConfig: () => ({ ...(cfg.memoryPlugin || {}), ownerQQ: cfg.ownerQQ }),
     deliverPrompt: (key, text) => deliverPrompt(key, text, {}),
     getAgentToken: (key) => String(getSocialV2State(key)?.agentToken || ''),
     readState: readMemoryState,
     writeState: writeMemoryState,
     log,
     appendActivity
   });
   memoryPlugin.start();
   setTimeout(() => { void memoryPlugin.onStartup(); }, 20000);
   ```

4. Expose a graceful-stop endpoint and call `memoryPlugin.onShutdown()` before exiting;
   also wire `SIGINT` / `SIGTERM` to the same handler (keep the instance in a module-level
   variable, otherwise the signal handler cannot see it).
5. Provide a `qq_memo_append` tool (or any tool the agent can call to persist a memo).

## Configuration (`config.json` → `memoryPlugin`)

| Key | Meaning | Default |
|---|---|---|
| `enabled` | Enable the plugin | `true` |
| `shutdownWaitMs` | How long to wait for the agent to write, 1s–60s | `12000` |
| `includeDiary` | Also mention the diary in the nudge | `true` |
| `targetKey` | Conversation to nudge | `""` = `private:<ownerQQ>` |

## State

`state/autonomous-memory.json`:

```json
{ "cleanExit": false, "lastStartAt": 1793515435888, "lastStopAt": 1793515392619, "lastDeliverOk": true }
```

A start counts as "dirty" only when `lastStartAt` is newer than `lastStopAt`
— comparing `cleanExit` alone would re-trigger on every start.

## Caveats

- **Hard kill / power loss cannot be caught.** That case is covered by the catch-up nudge
  on the next start, not by a real "before shutdown" write.
- On Windows, `SIGTERM` is not delivered by most kill paths; use the HTTP endpoint
  (the bundled stop script does this) or `process.kill` from Node.

## License

MIT
