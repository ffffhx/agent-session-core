# agent-session-core — 设计规范

> 统一 `~/.codex` 与 `~/.claude` 会话日志的解析层。一次解析，多种投影。
> 目标：消除 agent-retro / open-token-board / codex-snapshots 三处重复且互相漂移的解析逻辑，
> 把"引擎不对称"的 bug 在一个地方修对，让 claude-hud 等下游统一吃同一份数据。

## 1. 背景：今天有几套解析器，各自怎么错

调研基于真实源码（字段级），结论：

| 项目 | 解析位置 | 它要的"投影" | 已知缺陷（本包要统一修掉） |
|---|---|---|---|
| **open-token-board** | `token-usage-collector.ts`（**正确版**）、`agent.mjs`（旧拷贝，缺修复）、`codex-rate-limits.ts`（额度，正交） | **token 事件流** + 成本 | agent.mjs 缺 reset/compaction 感知 → compaction 后整轮被归零少算 |
| **agent-retro** | `parsers/codex.mjs` + `parsers/claude.mjs` | **会话指标**（打分） | ① duration=末-首时间戳，resume 会话算成 44h ② codex `model` 恒空 ③ claude `compactions`/`reasoning` 恒 0（两条扣分对 claude 永不触发）④ codex 失败靠正则、claude 靠 `is_error`（不对称）⑤ codex token 用"末次累计快照"，compaction 后**少算** |
| **codex-snapshots** | `local-history.mts`（3079 行单文件，三引擎+搜索+装配混在一起） | **完整 transcript**（text/html/图片）+ 脱敏 + 搜索 | token 仅 codex、last-write-wins；解析三引擎各自为政；脱敏规则混在大文件里 |
| **claude-hud** | 插件，消费 token-board 落盘的 `rate_limits` 快照 | **状态栏显示**（下游） | 不重复解析，改读统一数据即可 |

**根因**：三套解析器把"同一份 JSONL"读了三遍，每套对 token 累计 / compaction / 失败判定 / 引擎差异各写一份，必然漂移。

## 2. 原始格式（已采样确认）

**Codex** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，每行信封：
```
{ timestamp, type: "session_meta"|"turn_context"|"event_msg"|"response_item", payload: {...} }
```
- token：`type==="event_msg" && payload.type==="token_count"`，用量在 `payload.info.total_token_usage`
  （**累计快照**：`{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`），
  额度在 `payload.info.rate_limits`（token-board 专属，本包不碰）。
- 消息：`response_item` + `payload.type==="message"|"function_call"|"function_call_output"|"web_search_call"|"reasoning"`。
- 模型/cwd：`session_meta`/`turn_context` 的 `payload.model` / `payload.cwd`。

**Claude** `~/.claude/projects/<slug-cwd>/<uuid>.jsonl`，每行是 `{type, ...}`：
- `type: "user"|"assistant"|"system"|"mode"|"permission-mode"|"attachment"|"last-prompt"|"ai-title"|"file-history-snapshot"|"agent-name"|...`
- token：`assistant` 行的 `message.usage`（**per-message 增量**：`{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`）。
- 模型：`assistant.message.model`；标题：`ai-title` / `last-prompt` / 首条 user。

## 3. 架构：一次解析 → 多投影

```
discovery (共享 walk)  ──►  parse (engine→NormalizedSession)  ──►  projections
  ~/.codex                    events: 统一时间线                     ├─ toTokenEvents  → open-token-board
  ~/.claude                   (message/tool/token_usage/...)         ├─ toMetrics      → agent-retro
                                                                     └─ toSnapshot     → codex-snapshots
                                                                          (+ privacy/render, 重量级, 后续)
```

### NormalizedSession（解析层唯一产物）
```
{
  engine: 'codex'|'claude', id, filePath, cwd, model, version, gitBranch,
  startedAt, endedAt, mtimeMs, sizeBytes, title,
  events: NormalizedEvent[]      // 按时间顺序
}
```

### NormalizedEvent（判别联合 — 统一时间线）
```
{ kind:'message',     ts, role:'user'|'assistant'|'system', text, isSidechain?, isMeta? }
{ kind:'tool_call',   ts, name, args, callId? }
{ kind:'tool_result', ts, callId?, ok:boolean }
{ kind:'token_usage', ts, usage:{ input, cached, output, reasoning } }  // 见下：已归一
{ kind:'compaction',  ts }
{ kind:'web_search',  ts }
{ kind:'reasoning',   ts }
```

**token_usage 的统一语义（关键）**——两引擎归一到同一含义，total 一律 = input+output：
- `input` = 完整输入（含 cache）。codex: Δinput_tokens；claude: input_tokens + cache_read + cache_creation。
- `cached` = 折扣缓存读子集。codex: Δcached_input_tokens；claude: cache_read_input_tokens。
- `output`：codex Δoutput_tokens；claude output_tokens。
- `reasoning`：codex Δreasoning_output_tokens；claude 0（API 不单列，已含在 output）。
- **codex 用 reset-aware Δ**（移植自 token-board collector 的正确实现）：
  `isReset = total_tokens < prev.total_tokens ? 整轮全计 : 逐字段 max(0, cur-prev)`，
  避免 compaction 后那一轮被归零——这正是 agent-retro 和 agent.mjs 今天的少算 bug。

投影层把每个 `token_usage` 事件**求和**即得会话总量（对两引擎都正确）；token-board 把每个事件映射成一条 `TokenUsageEvent`。

## 4. 落地的统一修复（迁移后自动生效）
1. **duration**：metrics 投影按事件时间相邻间隙拆活跃区间，不再用首末差 → 修 resume=44h。
2. **codex model**：parse 阶段从 session_meta/turn_context 赋值 → 不再恒空。
3. **claude reasoning/compaction**：统一事件流里有 `compaction`/`reasoning` 事件，两引擎对称。
4. **失败判定**：codex `function_call_output` 仍需启发式，但与 claude `is_error` 统一成 `tool_result.ok`。
5. **token 少算**：codex 全量走 reset-aware Δ。

## 5. 包形态与迁移
- **零运行时依赖的 ESM（`.mjs`）+ 手写 `index.d.ts`**：可直接 `node` 跑（像 agent-retro），TS 消费方拿到类型，npx agent 可直接打包内联（解决它"无法 import TS"的根因，不再 copy-paste）。
- 重量级的 html 渲染 / 图片 / 搜索（codex-snapshots 专属）作为**可选子导出**，core 保持纯净。
- 脱敏（privacy）从 codex-snapshots 抽出（其 `privacy.ts` 本就零依赖），作为 `agent-session-core/privacy` 子导出。

### 迁移顺序（每步都有 parity 兜底，数字不许悄悄变）
1. ✅ **core + token 投影**：真实日志验证 reset-aware（508/508 无 reset 会话与末快照精确相等）。
2. ✅ **metrics 投影**：金标准 parity——import agent-retro 真实 parser+analyze 逐字段 diff，
   200 会话 turns/toolCount/toolFails/cacheRate/failRate/durationMs/score/grade **全部一致**；
   并修复 codex webSearches（恢复 265 次，agent-retro 恒 0）、duration 虚高（整体 17.5×）、codex model 恒空。
3. ~~接 agent-retro~~：**agent-retro 已于 2026-06-28 删除**（用户认为无用）。metrics 投影作为已测能力保留，暂无消费方。
4. **接 token-board**（下一步候选）：collector/agent 改调本包，删三套重复解析；parity diff 对齐。
5. **snapshot 投影**（✅ 已完成 3a）：事件流加丰富度（codex 消息改 response_item 源、带 images/goalObjective/工具输出；claude 带 images/工具输出），新增零依赖 `toSnapshot` 投影——html/脱敏/风险检测以**可注入回调**传入，保持零依赖。已在真实 codex+claude 会话验证（图片内联、工具 turn、tokenUsage、developer 预置消息过滤均正确）。
   **待办 3b**：实际改写 codex-snapshots/src/sources/local-history.mts，把 codex/claude 的 load/list 内部换成调本包（dispatch 壳 + trae + 搜索 + privacy + html 保留）；移植 stripAppDirectives（零依赖正则）；补轻量 listing summary 路径（列表不应全量解析）；claude subagents 保留在 codex-snapshots 侧。
6. **claude-hud**：改读统一数据。

事件流现已"无损"：messages 带 images/internal、tool_result 带 outputText、web_search 带 query、session 带 goalObjective——足以无损重建 transcript，维持"一次解析多投影"。

> claude compaction marker 在真实数据里未出现（agent-retro 也恒 0）；保留 best-effort 检测，
> 待确认 schema 再坐实——不虚报"已修"。codex 的 patch_apply/mcp_tool_call 暂未计入 toolCalls（与 agent-retro 对齐）。

> 命名/scope/是否发 npm 暂未定；当前为本地仓库，可随时改。
