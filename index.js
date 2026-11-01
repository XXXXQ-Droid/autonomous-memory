// 自主记忆 —— qq-bridge 插件（ESM 模块）
//
// 作用：
//   1. 桥正常停止 / 重启前，给 Agent 一次机会把自己觉得重要的事写进「备忘录」（新文件）。
//   2. 若上次没有正常收尾（系统关机、崩溃、强杀），下次启动时提醒它补记。
//   3. 觉得好玩的、值得留的事，仍可写进日记（由 Agent 自己决定）。
//
// 依赖全部由宿主注入，插件只负责「什么时候提醒」，不碰文件。

export const PLUGIN_NAME = 'autonomous-memory';
export const PLUGIN_VERSION = '1.0.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 收尾提醒：正常停止/重启前。 */
export function buildShutdownPrompt(key = '', token = '', includeDiary = true) {
  const lines = [
    '【收尾备忘】桥马上就要停下来了（重启或关机）。',
    '如果你觉得这次相处里有重要、不能忘的事（约定、承诺、重要的话、心情转折），用 qq_memo_append 记一条备忘；',
    '如果没什么值得记的，就什么都不用做。'
  ];
  if (includeDiary) lines.push('有好玩或喜欢的也可以顺手写进日记（qq_diary_append），不想写就算了。');
  if (key) lines.push(`· 你当前所在会话：${key}`);
  if (token) lines.push(`· 【会话令牌】${token}`);
  lines.push('不要复述这条提醒，也不要把令牌发出去。');
  return lines.join('\n');
}

/** 启动补记：上次没正常收尾时。 */
export function buildStartupPrompt(key = '', token = '', includeDiary = true) {
  const lines = [
    '【补记备忘】上次桥没有正常结束（可能是关机或崩溃），现在重新起来了。',
    '如果还记得有重要的事没来得及记，用 qq_memo_append 补一条；没有就算了，不用解释。'
  ];
  if (includeDiary) lines.push('有想写的也可以补进日记（qq_diary_append）。');
  if (key) lines.push(`· 你当前所在会话：${key}`);
  if (token) lines.push(`· 【会话令牌】${token}`);
  lines.push('不要复述这条提醒，也不要把令牌发出去。');
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig          { enabled, shutdownWaitMs, includeDiary, targetKey }
 * @param {(key: string, text: string) => Promise<any>} deps.deliverPrompt
 * @param {(key: string) => string} deps.getAgentToken
 * @param {() => object} deps.readState
 * @param {(o: object) => void} deps.writeState
 * @param {(m: string) => void} [deps.log]
 * @param {(m: string) => void} [deps.appendActivity]
 */
export function createAutonomousMemory(deps) {
  const {
    getConfig = () => ({}),
    deliverPrompt,
    getAgentToken = () => '',
    readState = () => ({}),
    writeState = () => {},
    log = () => {},
    appendActivity = () => {}
  } = deps || {};

  function targetKeyOf(config) {
    return String(config.targetKey || `private:${config.ownerQQ ?? ''}`);
  }

  async function deliver(prefix, promptFn, reason) {
    const config = getConfig() || {};
    const key = targetKeyOf(config);
    if (!key || key === 'private:') {
      log(`[memory] 跳过（${reason}）：没有可用会话`);
      return { ok: false, error: '没有可用会话' };
    }
    try {
      const token = String(getAgentToken(key) || '');
      const text = promptFn(key, token, config.includeDiary !== false);
      const result = await deliverPrompt(key, text);
      if (result && result.ok === false) {
        log(`[memory] ${prefix}投递失败 ${key}：${result.error ?? ''}`);
        return { ok: false, error: result.error ?? '投递失败' };
      }
      appendActivity(`${key} [memory] ${prefix}已投递（${reason}）`);
      log(`[memory] ${prefix}已投递 ${key}（${reason}）`);
      return { ok: true, key };
    } catch (error) {
      log(`[memory] ${prefix}异常：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 启动：标记 running；若上次不干净，触发补记。 */
  async function onStartup() {
    const config = getConfig() || {};
    const st = readState() || {};
    // 判定「上次不干净」：上次启动过、但没有对应的正常停止记录。
    // 只看 cleanExit 会误判——本次启动刚把 cleanExit 写成 false，就会自己触发补记。
    const startedAt = Number(st.lastStartAt) || 0;
    const stoppedAt = Number(st.lastStopAt) || 0;
    const wasDirty = st.cleanExit === false && startedAt > 0 && stoppedAt < startedAt;
    writeState({ ...st, cleanExit: false, lastStartAt: Date.now(), lastStopAt: stoppedAt });
    if (!config.enabled) return { ok: false, skipped: 'disabled' };
    if (!wasDirty) return { ok: true, skipped: 'clean previous exit' };
    return deliver('补记备忘', buildStartupPrompt, 'dirty-start');
  }

  /** 停止：给一次收尾机会，最多等 shutdownWaitMs。 */
  async function onShutdown() {
    const config = getConfig() || {};
    const st0 = readState() || {};
    if (!config.enabled) {
      writeState({ ...st0, cleanExit: true, lastStopAt: Date.now() });
      return { ok: false, skipped: 'disabled' };
    }
    const delivered = await deliver('收尾备忘', buildShutdownPrompt, 'shutdown');
    const waitMs = Math.min(60000, Math.max(1000, Number(config.shutdownWaitMs) || 12000));
    // 给 Agent 一点时间真正把工具调用发出去（无法精确知道写完，只能等一个窗口）
    await sleep(delivered.ok ? waitMs : 0);
    writeState({
      ...(readState() || {}),
      cleanExit: delivered.ok,
      lastStopAt: Date.now(),
      lastDeliverOk: delivered.ok === true
    });
    return { ...delivered, waitedMs: delivered.ok ? waitMs : 0 };
  }

  function start() {
    log(`[memory] 插件已加载 v${PLUGIN_VERSION}`);
  }

  return {
    start,
    onStartup,
    onShutdown,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION
  };
}
