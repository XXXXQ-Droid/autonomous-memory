# 使用说明 · 自主记忆插件（qq-bridge）

> 本插件是 **qq-bridge（桥）的插件**，不是 DSH 插件。
> 它由桥进程加载，**只在桥运行时工作**；装进 DSH 不会生效，也不会出现在 DSH 插件市场。

---

## 一、它工作在整条链路的哪一层

```
QQ 客户端
   │
   ▼
OneBot 网关（如 SnowLuma，HTTP + WebSocket）
   │
   ▼
qq-bridge（桥，提供控制台与工具）   ◄── ★ 本插件挂在这一层
   │
   ▼
DSH（DeepSeek Harness）上的 Agent
```

| 组件 | 职责 |
|---|---|
| QQ 客户端 | 登录账号、收发消息 |
| OneBot 网关 | 把 QQ 协议翻译成 OneBot v11 |
| **qq-bridge（桥）** | 会话映射、权限、工具暴露、生命周期钩子 |
| DSH | 真正跑模型的宿主 |

**为什么必须在桥这一层**：它要监听桥的**停止事件**（收尾）和**启动事件**（补记），这两件事只有桥自己知道。

---

## 二、它做什么

给 Agent 两个「顺带记录」的机会：

1. **桥正常停止 / 重启前** —— 投一条「收尾备忘」提醒：
   如果这次相处里有重要、不能忘的事（约定、承诺、重要的话、心情转折），用备忘工具记一条；没有就什么都不用做。
2. **下次启动时** —— 若检测到上次没有正常收尾（系统关机、崩溃、强杀），投一条「补记备忘」提醒：
   如果还记得有重要的事没记，补一条；没有就算了。

另外：觉得好玩的、值得留的，仍可以写进日记（日记功能不受本插件影响，由 Agent 自己决定写不写）。

**每条备忘都是一个新文件**（`备忘-YYYYMMDD-HHmmss.md`），不会覆盖旧内容。

---

## 三、安装步骤

### 1. 放置文件

```
qq-bridge/
└─ plugins/
   └─ autonomous-memory/
      ├─ index.js
      ├─ package.json
      └─ ...
```

### 2. 在桥里 import

编辑 `src/bridge.js` 顶部：

```js
import { createAutonomousMemory } from '../plugins/autonomous-memory/index.js';
```

> 若插件放在桥目录之外，使用 `file:///` 绝对 URL，并对中文路径做 URL 编码。

### 3. 创建实例并启动

在 `main()` 内、DSH 会话相关设施就绪之后：

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
// 等 DSH 就绪后再做启动检查
setTimeout(() => { void memoryPlugin.onStartup(); }, 20000);
```

### 4. 暴露优雅停止接口

```js
if (url.pathname === '/api/plugin/memory/shutdown' && req.method === 'POST') {
  sendJson({ ok: true, accepted: true });
  setTimeout(() => { void gracefulShutdown('http-stop'); }, 300);
  return;
}
```

### 5. 把实例存到模块级变量

信号处理器在模块顶层，拿不到 `main()` 里的局部变量：

```js
let memoryPluginRef = null;   // 顶层
// main() 里：
memoryPluginRef = memoryPlugin;
// 处理器里：
const r = await memoryPluginRef.onShutdown();
```

### 6. 提供备忘工具

Agent 需要一个能落盘的工具，例如 `qq_memo_append`：

- 每次调用新建一个文件
- 文件名带时间戳
- 内容带写入时间与原因

---

## 四、配置项（`config.json` → `memoryPlugin`）

| 字段 | 含义 | 默认 | 范围 |
|---|---|---|---|
| `enabled` | 是否启用 | `true` | 布尔 |
| `shutdownWaitMs` | 收尾时最多等多久让它写完 | `12000` | 1000~60000 |
| `includeDiary` | 提醒里是否顺带提日记 | `true` | 布尔 |
| `targetKey` | 提醒投递给哪个会话 | 空 = `private:<ownerQQ>` | `private:<id>` / `group:<id>` |

---

## 五、运行时行为

| 触发 | 行为 |
|---|---|
| 优雅停止（HTTP 接口 / SIGINT / SIGTERM） | 投「收尾备忘」→ 等待 `shutdownWaitMs` → 退出 |
| 下次启动，上次有正常停止记录 | 静默，日志写 `clean previous exit` |
| 下次启动，上次没有停止记录 | 投「补记备忘」 |

判定「上次不干净」的条件是：

```
cleanExit === false  且  lastStartAt > lastStopAt
```

> 只比较 `cleanExit` 会误判——本次启动刚把它写成 `false`，会导致每次启动都触发补记。

状态写入 `state/autonomous-memory.json`：

```json
{
  "cleanExit": false,
  "lastStartAt": 1793515435888,
  "lastStopAt": 1793515392619,
  "lastDeliverOk": true
}
```

---

## 六、常见问题

**关机时能保证记下来吗？**
不能保证。系统关机/断电/强杀会直接杀进程，没有等待模型写完的时间。这种情况由**下次启动的补记提醒**兜底。

**Windows 上 SIGTERM 不触发？**
多数强杀路径不会投递 SIGTERM。请使用 HTTP 停止接口（自带的停止脚本就是这么做的），或从 Node 进程内 `process.kill`。

**日志显示已投递，但没有生成备忘文件？**
说明 Agent 判断「没有值得记的事」，这是设计允许的行为，不是故障。

**会不会每次启动都补记一次？**
不会，见上面的判定条件；正常退出后启动是静默的。

**和日记功能冲突吗？**
不冲突。本插件只增加备忘录相关的提醒，日记仍由 Agent 自己决定写不写。

**Token 消耗**
每次停止/启动各触发一轮模型调用，单轮约 3–8k token；写备忘本身只是一次工具调用（几百 token）。

---

## 七、文件说明

| 文件 | 用途 |
|---|---|
| `index.js` | 插件主体（ESM，依赖由桥注入） |
| `package.json` | 插件元数据 |
| `README.md` | 英文速查 |
| `USAGE.zh-CN.md` | 本文件 |
| `LICENSE` | MIT |
