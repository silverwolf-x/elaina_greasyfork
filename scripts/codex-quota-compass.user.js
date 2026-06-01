// ==UserScript==
// @name         Codex Quota Compass (GPT-5.5 Token Pricing)
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  人性化展示 Codex 配额；按 GPT-5.5 token 单价估算；本周期每日模型调用次数矩阵；按后端 daily API 原始天数据展示
// @author       Jun Zhao, Canxin, loongphy, OpenAI
// @match        https://chatgpt.com/codex/cloud/settings/analytics*
// @grant        GM_addStyle
// @source       https://linux.do/t/topic/2138324
// @note         打开 https://chatgpt.com/codex/cloud/settings/analytics#usage 页面使用
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.__codexQuotaCompassInjected) return;
  window.__codexQuotaCompassInjected = true;

  const CONFIG = {
    HISTORY_DAYS: 30,
    TARGET_WINDOW_SECONDS: 7 * 24 * 60 * 60,
    DAY_MS: 24 * 60 * 60 * 1000,
    USE_UTC_DAY: true,
    EPS: 1e-9,

    GPT55_PRICE_PER_1M: {
      uncachedInput: 5.0,
      cachedInput: 0.5,
      output: 30.0,
    },
  };

  const HTML_ESCAPE = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);

  const n = (value) => {
    if (typeof value === "string") value = value.replace(/,/g, "").trim();
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, n(value)));

  const trimFixed = (value, digits = 2) => {
    const str = n(value).toFixed(digits);
    return str.replace(/\.?0+$/, "");
  };

  const firstFinite = (...values) => {
    for (const value of values) {
      const num = n(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  };

  const asArray = (value) => (Array.isArray(value) ? value : []);

  const fmtNum = (value) => {
    const num = n(value);
    const abs = Math.abs(num);
    const sign = num < 0 ? "-" : "";
    if (abs >= 1e12) return sign + trimFixed(abs / 1e12, 2) + "T";
    if (abs >= 1e9) return sign + trimFixed(abs / 1e9, 2) + "B";
    if (abs >= 1e6) return sign + trimFixed(abs / 1e6, 2) + "M";
    if (abs >= 1e3) return sign + trimFixed(abs / 1e3, 2) + "K";
    return num.toLocaleString();
  };

  const fmtUsd = (value) => `$ ${n(value).toFixed(2)}`;

  const fmtTurns = (value) => {
    const num = n(value);
    return Math.abs(num - Math.round(num)) < 1e-9
      ? String(Math.round(num))
      : num.toFixed(1);
  };

  const tokenParts = (obj = {}) => ({
    uncachedInput: n(obj.uncached_text_input_tokens),
    cachedInput: n(obj.cached_text_input_tokens),
    output: n(obj.text_output_tokens),
  });

  const tokenTotal = (obj = {}) => {
    const total = n(obj.text_total_tokens);
    const parts = tokenParts(obj);
    const derived = parts.uncachedInput + parts.cachedInput + parts.output;
    return total > 0 ? total : derived;
  };

  const estimateGpt55Usd = (obj = {}) => {
    const p = CONFIG.GPT55_PRICE_PER_1M;
    const parts = tokenParts(obj);

    return (
      (parts.uncachedInput / 1_000_000) * p.uncachedInput +
      (parts.cachedInput / 1_000_000) * p.cachedInput +
      (parts.output / 1_000_000) * p.output
    );
  };

  const pad2 = (value) => String(value).padStart(2, "0");

  const dateKeyFromMs = (ms) => {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return "";
    if (CONFIG.USE_UTC_DAY) return d.toISOString().slice(0, 10);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const dayStartMs = (dateKey) => {
    const [year, month, day] = String(dateKey || "")
      .slice(0, 10)
      .split("-")
      .map(Number);
    if (!year || !month || !day) return NaN;
    return CONFIG.USE_UTC_DAY
      ? Date.UTC(year, month - 1, day)
      : new Date(year, month - 1, day).getTime();
  };

  const formatDateTime = (ms) => {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return "未知";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  };

    const formatCycleDateTime = (ms) => {
      const d = new Date(ms);
      if (!Number.isFinite(d.getTime())) return "未知";

      return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(
        d.getDate(),
      )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

  const formatDuration = (seconds) => {
    const s = n(seconds);
    if (!s) return "当前周期";
    const days = s / 86400;
    if (days >= 1) {
      const rounded = Math.round(days);
      return Math.abs(days - rounded) < 1e-6
        ? `${rounded} 天周期`
        : `${days.toFixed(1)} 天周期`;
    }
    return `${trimFixed(s / 3600, 1)} 小时周期`;
  };

  const formatPercentFromRatio = (ratio) => {
    const pct = clamp(ratio) * 100;
    return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;
  };

  async function getAccessToken() {
    const bootstrapData =
      document.getElementById("client-bootstrap")?.textContent || "";

    const jwtCandidates =
      bootstrapData.match(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g) ||
      bootstrapData.match(/[\w-]{30,}\.[\w-]{30,}\.[\w-]{30,}/g) ||
      [];

    if (jwtCandidates.length > 0) return jwtCandidates[0];

    try {
      const res = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return null;
      const session = await res.json();
      return (
        session?.accessToken ||
        session?.access_token ||
        session?.token ||
        null
      );
    } catch {
      return null;
    }
  }

  async function apiGet(path, token) {
    const res = await fetch(path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      credentials: "include",
      cache: "no-store",
    });

    const text = await res.text();
    let json = null;

    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // ignore parse error
      }
    }

    if (!res.ok) {
      const detail =
        json?.detail ||
        json?.message ||
        (typeof json?.error === "string" ? json.error : json?.error?.message) ||
        text.slice(0, 200);

      throw new Error(
        `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }

    if (json === null) throw new Error("接口返回的不是 JSON。");
    return json;
  }

  const getRateLimitObject = (usage = {}) =>
    usage?.rate_limit ||
    usage?.rateLimit ||
    usage?.rate_limits ||
    usage?.rateLimits ||
    usage?.limits ||
    {};

  const looksLikeWindow = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return [
      "limit_window_seconds",
      "window_seconds",
      "duration_seconds",
      "reset_at",
      "resetAt",
      "used_percent",
      "usedPercent",
      "used_ratio",
      "remaining",
      "limit",
      "used",
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
  };

  const rateLimitWindows = (rateLimit = {}) => {
    const windows = [];

    if (Array.isArray(rateLimit?.windows)) {
      rateLimit.windows.forEach((value, index) => {
        if (looksLikeWindow(value)) {
          windows.push({
            ...value,
            _window_name: value.name || value.window_name || `window_${index + 1}`,
          });
        }
      });
    }

    Object.entries(rateLimit || {}).forEach(([key, value]) => {
      if (looksLikeWindow(value)) {
        windows.push({
          ...value,
          _window_name: key,
        });
      }
    });

    return windows;
  };

  const getWindowDurationSeconds = (quotaWindow) =>
    firstFinite(
      quotaWindow?.limit_window_seconds,
      quotaWindow?.window_seconds,
      quotaWindow?.duration_seconds,
    );

  const pickQuotaWindow = (rateLimit = {}) => {
    const windows = rateLimitWindows(rateLimit);
    if (windows.length === 0 && looksLikeWindow(rateLimit)) {
      return { ...rateLimit, _window_name: "rate_limit" };
    }
    if (windows.length === 0) return null;

    const withDuration = windows.filter((w) => getWindowDurationSeconds(w) > 0);
    if (withDuration.length > 0) {
      return [...withDuration].sort(
        (a, b) =>
          Math.abs(getWindowDurationSeconds(a) - CONFIG.TARGET_WINDOW_SECONDS) -
          Math.abs(getWindowDurationSeconds(b) - CONFIG.TARGET_WINDOW_SECONDS),
      )[0];
    }

    if (rateLimit.secondary_window) {
      return { ...rateLimit.secondary_window, _window_name: "secondary_window" };
    }

    return windows[0];
  };

  const toEpochMs = (secondsOrMsOrIso) => {
    if (typeof secondsOrMsOrIso === "string") {
      const trimmed = secondsOrMsOrIso.trim();
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 1e12 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : NaN;
    }

    const value = n(secondsOrMsOrIso);
    if (!value) return NaN;
    return value > 1e12 ? value : value * 1000;
  };

  const cycleRangeFromWindow = (quotaWindow) => {
    const resetMs = toEpochMs(
      quotaWindow?.reset_at ||
        quotaWindow?.resetAt ||
        quotaWindow?.resets_at ||
        quotaWindow?.end_at ||
        quotaWindow?.window_end,
    );

    const durationMs = getWindowDurationSeconds(quotaWindow) * 1000;
    const nowMs = Date.now();

    if (Number.isFinite(resetMs) && durationMs > 0) {
      return {
        cycleStartMs: resetMs - durationMs,
        cycleEndMs: resetMs,
      };
    }

    return {
      cycleStartMs: nowMs - CONFIG.TARGET_WINDOW_SECONDS * 1000,
      cycleEndMs: nowMs + CONFIG.TARGET_WINDOW_SECONDS * 1000,
    };
  };

  const usedRatioFromWindow = (quotaWindow) => {
    if (!quotaWindow) return 0;

    const rawRatio = firstFinite(
      quotaWindow.used_ratio,
      quotaWindow.usedRatio,
      quotaWindow.fraction_used,
    );
    if (rawRatio > 0) return clamp(rawRatio);

    const rawPercent = firstFinite(quotaWindow.used_percent, quotaWindow.usedPercent);
    if (rawPercent > 0) return clamp(rawPercent / 100);

    const limit = firstFinite(
      quotaWindow.limit,
      quotaWindow.credit_limit,
      quotaWindow.credits_limit,
      quotaWindow.max,
    );

    const used = firstFinite(
      quotaWindow.used,
      quotaWindow.used_credits,
      quotaWindow.consumed,
      quotaWindow.consumed_credits,
    );

    const remaining = firstFinite(
      quotaWindow.remaining,
      quotaWindow.remaining_credits,
      quotaWindow.available,
      quotaWindow.available_credits,
    );

    if (limit > 0 && used > 0) return clamp(used / limit);
    if (limit > 0 && remaining > 0) return clamp((limit - remaining) / limit);

    return 0;
  };

  const usedPercentTextFromWindow = (quotaWindow) => {
    const rawPercent = firstFinite(quotaWindow?.used_percent, quotaWindow?.usedPercent);
    if (rawPercent > 0) return `${trimFixed(rawPercent, 2)}%`;

    const ratio = usedRatioFromWindow(quotaWindow);
    return ratio > CONFIG.EPS ? formatPercentFromRatio(ratio) : "未知";
  };

  const extractDailyList = (payload) => {
    if (Array.isArray(payload)) return payload;

    const candidates = [
      payload?.data,
      payload?.items,
      payload?.results,
      payload?.daily,
      payload?.daily_usage,
      payload?.dailyWorkspaceUsageCounts,
      payload?.daily_workspace_usage_counts,
      payload?.workspace_usage_counts,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }

    return [];
  };

  const makeDailyRow = (item) => {
    const dateKey = String(item?.date || "").slice(0, 10);
    return {
      ...item,
      totals: item?.totals || item || {},
      clients: asArray(item?.clients),
      models: asArray(item?.models),
      _displayDate: dateKey,
      _dateKey: dateKey,
      _sortTs: dayStartMs(dateKey),
    };
  };

  const splitDailyBuckets = (
    dailyList,
    cycleStartMs,
    cycleEndMs,
    nowMs = Date.now(),
  ) => {
    const currentCycleList = [];
    const historyList = [];

    const cycleStartDayMs = dayStartMs(dateKeyFromMs(cycleStartMs));
    const effectiveCycleEndMs = Math.min(cycleEndMs, nowMs);
    const cycleEndDayMs = dayStartMs(dateKeyFromMs(effectiveCycleEndMs));

    asArray(dailyList).forEach((item) => {
      const dateKey = String(item?.date || "").slice(0, 10);
      const bucketStart = dayStartMs(dateKey);
      if (!Number.isFinite(bucketStart)) return;
      if (bucketStart > nowMs) return;

      const row = makeDailyRow(item);

      if (bucketStart >= cycleStartDayMs && bucketStart <= cycleEndDayMs) {
        currentCycleList.push(row);
      } else {
        historyList.push(row);
      }
    });

    const byTime = (a, b) => a._sortTs - b._sortTs;

    return {
      currentCycleList: currentCycleList.sort(byTime),
      historyList: historyList.sort(byTime),
    };
  };

  const getStats = (list) => {
    return list.reduce(
      (acc, row) => {
        const totals = row.totals || {};
        const parts = tokenParts(totals);

        acc.credits += n(totals.credits);
        acc.turns += n(totals.turns);
        acc.threads += n(totals.threads);
        acc.tokens += tokenTotal(totals);
        acc.uncachedInputTokens += parts.uncachedInput;
        acc.cachedInputTokens += parts.cachedInput;
        acc.outputTokens += parts.output;
        acc.gpt55Usd += estimateGpt55Usd(totals);

        return acc;
      },
      {
        credits: 0,
        turns: 0,
        threads: 0,
        tokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        gpt55Usd: 0,
      },
    );
  };

  const aggregateBreakdown = (list, keyName) => {
    const map = new Map();

    asArray(list).forEach((row) => {
      asArray(row?.[keyName]).forEach((item) => {
        const name =
          item.client_id ||
          item.model ||
          item.model_id ||
          item.name ||
          item.id ||
          item[keyName.replace(/s$/, "_id")] ||
          "UNKNOWN";

        const current =
          map.get(name) || {
            name,
            credits: 0,
            turns: 0,
            threads: 0,
            tokens: 0,
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            gpt55Usd: 0,
          };

        const parts = tokenParts(item);

        current.credits += n(item.credits);
        current.turns += n(item.turns);
        current.threads += n(item.threads);
        current.tokens += tokenTotal(item);
        current.uncachedInputTokens += parts.uncachedInput;
        current.cachedInputTokens += parts.cachedInput;
        current.outputTokens += parts.output;
        current.gpt55Usd += estimateGpt55Usd(item);

        map.set(name, current);
      });
    });

    return [...map.values()]
      .filter(
        (item) =>
          item.gpt55Usd > CONFIG.EPS ||
          item.tokens > CONFIG.EPS ||
          item.turns > CONFIG.EPS ||
          item.threads > CONFIG.EPS ||
          item.credits > CONFIG.EPS,
      )
      .sort(
        (a, b) =>
          b.gpt55Usd - a.gpt55Usd ||
          b.tokens - a.tokens ||
          b.turns - a.turns ||
          b.credits - a.credits,
      );
  };

  const getModelDisplayName = (item = {}) =>
    item.model || item.model_id || item.name || item.id || "UNKNOWN";

  const getModelTurnCount = (item = {}) =>
    firstFinite(item.turns, item.calls, item.count, item.requests, item.messages);

  const renderTable = (list, stats) => {
    const rows = [...list].sort((a, b) => b._sortTs - a._sortTs);

    return `
      <div class="table-container wide">
        <table class="compass-table wide-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>价格</th>
              <th>总 Tokens</th>
              <th>未缓存输入</th>
              <th>缓存输入</th>
              <th>输出</th>
              <th>轮数</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length === 0
                ? `<tr><td colspan="7" style="color:#777; text-align:center; padding:14px;">暂无数据</td></tr>`
                : rows
                    .map((row) => {
                      const totals = row.totals || {};
                      const parts = tokenParts(totals);

                      return `
                        <tr>
                          <td>${escapeHtml(row._displayDate || row.date)}</td>
                          <td style="font-family:monospace; color:#10a37f; font-weight:600;">
                            ${fmtUsd(estimateGpt55Usd(totals))}
                          </td>
                          <td style="font-family:monospace">${fmtNum(tokenTotal(totals))}</td>
                          <td style="font-family:monospace">${fmtNum(parts.uncachedInput)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.cachedInput)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.output)}</td>
                          <td>${fmtTurns(totals.turns)}</td>
                        </tr>
                      `;
                    })
                    .join("")
            }
          </tbody>
          <tfoot>
            <tr class="compass-footer-row">
              <td>合计</td>
              <td style="color:#10a37f">${fmtUsd(stats.gpt55Usd)}</td>
              <td style="font-family:monospace">${fmtNum(stats.tokens)}</td>
              <td style="font-family:monospace">${fmtNum(stats.uncachedInputTokens)}</td>
              <td style="font-family:monospace">${fmtNum(stats.cachedInputTokens)}</td>
              <td style="font-family:monospace">${fmtNum(stats.outputTokens)}</td>
              <td>${fmtTurns(stats.turns)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  };

  const renderBreakdown = (title, rows, totalUsd, totalTokens, totalTurns, note = "") => {
    const top = rows.slice(0, 8);
    if (top.length === 0) return "";

    const hasCost = top.some((row) => row.gpt55Usd > CONFIG.EPS);
    const ratioBase =
      totalUsd > CONFIG.EPS ? "cost" : totalTokens > CONFIG.EPS ? "tokens" : "turns";

    return `
      <section class="compass-section">
        <div class="compass-section-title">
          ${escapeHtml(title)}
          ${
            note
              ? `<span class="section-title-note">${escapeHtml(note)}</span>`
              : ""
          }
        </div>

        <div class="table-container compact">
          <table class="compass-table breakdown-table">
            <thead>
              <tr>
                <th>名称</th>
                ${hasCost ? "<th>价格</th>" : ""}
                <th>Tokens</th>
                <th>轮数</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              ${top
                .map((row) => {
                  let ratio = 0;
                  if (ratioBase === "cost") ratio = row.gpt55Usd / totalUsd;
                  else if (ratioBase === "tokens") ratio = row.tokens / totalTokens;
                  else if (totalTurns > CONFIG.EPS) ratio = row.turns / totalTurns;

                  return `
                    <tr>
                      <td title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</td>
                      ${
                        hasCost
                          ? `<td style="font-family:monospace">${fmtUsd(row.gpt55Usd)}</td>`
                          : ""
                      }
                      <td style="font-family:monospace">${fmtNum(row.tokens)}</td>
                      <td>${fmtTurns(row.turns)}</td>
                      <td>${formatPercentFromRatio(ratio)}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  };

  const renderDailyModelTurnsTable = (list) => {
    const rows = [...asArray(list)]
      .map((row) => {
        const counts = new Map();
        let totalTurns = 0;

        asArray(row?.models).forEach((item) => {
          const modelName = getModelDisplayName(item);
          const turns = getModelTurnCount(item);
          if (turns <= CONFIG.EPS) return;

          counts.set(modelName, n(counts.get(modelName)) + turns);
          totalTurns += turns;
        });

        return { row, counts, totalTurns };
      })
      .filter((item) => item.totalTurns > CONFIG.EPS)
      .sort((a, b) => b.row._sortTs - a.row._sortTs);

    if (rows.length === 0) {
      return `
        <section class="compass-section">
          <div class="compass-section-title">🤖 本周期模型列表</div>
          <div class="compass-note">
            当前接口未返回可识别的模型级调用次数。
          </div>
        </section>
      `;
    }

    const modelTotals = new Map();

    rows.forEach(({ counts }) => {
      counts.forEach((turns, modelName) => {
        modelTotals.set(modelName, n(modelTotals.get(modelName)) + turns);
      });
    });

    const modelNames = [...modelTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([modelName]) => modelName);

    const grandTotal = [...modelTotals.values()].reduce(
      (sum, turns) => sum + n(turns),
      0,
    );

    return `
      <section class="compass-section">
        <div class="compass-section-title">
          🤖 本周期模型列表
        </div>

        <div class="table-container model-turns-table-container">
          <table class="compass-table model-turns-table">
            <thead>
              <tr>
                <th>日期</th>
                ${modelNames
                  .map(
                    (modelName) =>
                      `<th title="${escapeHtml(modelName)}">${escapeHtml(
                        modelName,
                      )}</th>`,
                  )
                  .join("")}
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(({ row, counts, totalTurns }) => {
                  return `
                    <tr>
                      <td>${escapeHtml(row._displayDate || row.date)}</td>
                      ${modelNames
                        .map((modelName) => {
                          const turns = n(counts.get(modelName));
                          return `<td style="font-family:monospace">${
                            turns > CONFIG.EPS ? fmtTurns(turns) : "-"
                          }</td>`;
                        })
                        .join("")}
                      <td style="font-family:monospace; font-weight:600;">
                        ${fmtTurns(totalTurns)}
                      </td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
            <tfoot>
              <tr class="compass-footer-row">
                <td>合计</td>
                ${modelNames
                  .map(
                    (modelName) =>
                      `<td style="font-family:monospace">${fmtTurns(
                        modelTotals.get(modelName),
                      )}</td>`,
                  )
                  .join("")}
                <td style="font-family:monospace">${fmtTurns(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    `;
  };

  const showPanel = (data) => {
    const root = document.getElementById("codex-compass-root");
    if (!root) return;

    const { quotaWindow, dailyList, cycleStartMs, cycleEndMs, nowMs } = data;

    const { currentCycleList, historyList } = splitDailyBuckets(
      dailyList,
      cycleStartMs,
      cycleEndMs,
      nowMs,
    );

    const currentStats = getStats(currentCycleList);
    const historyStats = getStats(historyList);

    const usedRatio = usedRatioFromWindow(quotaWindow);
    const usedPercentText = usedPercentTextFromWindow(quotaWindow);

    const estCycleUsd =
      usedRatio > CONFIG.EPS && currentStats.gpt55Usd > 0
        ? currentStats.gpt55Usd / usedRatio
        : NaN;

    const estCycleUsdText =
      Number.isFinite(estCycleUsd) && estCycleUsd > 0 ? fmtUsd(estCycleUsd) : "未知";

    const estTokens =
      usedRatio > CONFIG.EPS && currentStats.tokens > 0
        ? currentStats.tokens / usedRatio
        : NaN;

    const estTokensText =
      Number.isFinite(estTokens) && estTokens > 0 ? fmtNum(estTokens) : "未知";

    const cycleRangeText = `${formatCycleDateTime(cycleStartMs)} → ${formatCycleDateTime(
      cycleEndMs,
    )}`;

    const clientBreakdown = aggregateBreakdown(currentCycleList, "clients");

    let historyRangeTitle = "⏳ 历史记录（本周期外）";
    if (historyList.length > 0) {
      const sortedHistory = [...historyList].sort((a, b) => a._sortTs - b._sortTs);
      const startStr = sortedHistory[0]._dateKey || sortedHistory[0].date;
      const endStr =
        sortedHistory[sortedHistory.length - 1]._dateKey ||
        sortedHistory[sortedHistory.length - 1].date;

      historyRangeTitle = `⏳ 历史记录（本周期外 ${startStr} 至 ${endStr}）`;
    }

    root.innerHTML = `
      <div class="compass-header">
        <div class="compass-header-main">
          <div class="compass-title">
            ${escapeHtml(cycleRangeText)}
          </div>
        </div>

        <div class="compass-header-right">
          <div class="compass-product-title">📊 Codex 配额深度分析 (V2.7)</div>
          <div class="compass-close" id="compass-close-btn">&times;</div>
        </div>
      </div>

      <div class="compass-grid">
        <div class="compass-card">
          <div class="card-label">已用比例</div>
          <div class="card-value">${escapeHtml(usedPercentText)}</div>
        </div>
        <div class="compass-card highlight">
          <div class="card-label">GPT-5.5 估算金额</div>
          <div class="card-value">${fmtUsd(currentStats.gpt55Usd)}</div>
        </div>
        <div class="compass-card">
          <div class="card-label">本周期 Tokens</div>
          <div class="card-value">${fmtNum(currentStats.tokens)}</div>
        </div>
        <div class="compass-card">
          <div class="card-label">本周期轮数</div>
          <div class="card-value">${fmtTurns(currentStats.turns)}</div>
        </div>
      </div>

      <div class="compass-grid">
        <div class="compass-card">
          <div class="card-label">未缓存输入</div>
          <div class="card-value">${fmtNum(currentStats.uncachedInputTokens)}</div>
        </div>
        <div class="compass-card">
          <div class="card-label">缓存输入</div>
          <div class="card-value">${fmtNum(currentStats.cachedInputTokens)}</div>
        </div>
        <div class="compass-card">
          <div class="card-label">输出 Tokens</div>
          <div class="card-value">${fmtNum(currentStats.outputTokens)}</div>
        </div>
        <div class="compass-card highlight">
          <div class="card-label">推算周期金额</div>
          <div class="card-value">${escapeHtml(estCycleUsdText)}</div>
        </div>
      </div>

      <div class="compass-note pricing">
        <div>无法区分每个模型 token，统一使用 GPT-5.5 定价。</div>
        <div>
          GPT-5.5 估算公式：未缓存输入 × $5/1M + 缓存输入 × $0.50/1M + 输出 × $30/1M。
          推算周期 Tokens：${escapeHtml(estTokensText)}。该金额是按公开 API token 单价估算，不等同于 Codex/订阅/内部额度的真实账单。
        </div>
      </div>

      <section class="compass-section">
        <div class="compass-section-title">
          📅 本周期明细
        </div>
        ${renderTable(currentCycleList, currentStats)}
      </section>

      ${renderBreakdown(
        "🧭 本周期客户端分布",
        clientBreakdown,
        currentStats.gpt55Usd,
        currentStats.tokens,
        currentStats.turns,
      )}

      ${renderDailyModelTurnsTable(currentCycleList)}

      ${
        historyList.length > 0
          ? `
            <section class="compass-section">
              <div class="compass-section-title muted">
                ${escapeHtml(historyRangeTitle)}
              </div>
              ${renderTable(historyList, historyStats)}
            </section>
          `
          : ""
      }
    `;

    root.style.display = "block";

    document.getElementById("compass-close-btn").onclick = () => {
      root.style.display = "none";
    };
  };

  const run = async () => {
    const btn = document.getElementById("codex-compass-btn");
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.innerText = "分析中...";

    try {
      const token = await getAccessToken();
      if (!token) {
        alert("令牌获取失败，请确保已登录，或刷新页面后重试。");
        return;
      }

      const usage = await apiGet("/backend-api/wham/usage", token);
      const rateLimit = getRateLimitObject(usage);
      const quotaWindow = pickQuotaWindow(rateLimit);

      const { cycleStartMs, cycleEndMs } = cycleRangeFromWindow(quotaWindow);
      const nowMs = Date.now();

      const historyStartMs = nowMs - CONFIG.HISTORY_DAYS * CONFIG.DAY_MS;
      const queryStartMs = Math.min(historyStartMs, cycleStartMs - CONFIG.DAY_MS);
      const startDate = dateKeyFromMs(queryStartMs);
      const endDate = dateKeyFromMs(nowMs + CONFIG.DAY_MS);

      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        group_by: "day",
      });

      const dailyData = await apiGet(
        `/backend-api/wham/analytics/daily-workspace-usage-counts?${params.toString()}`,
        token,
      );

      const dailyList = extractDailyList(dailyData);

      if (dailyList.length === 0) {
        console.warn("[Codex Quota Compass] Unexpected daily payload:", dailyData);
        throw new Error(
          "daily usage 接口没有返回可识别的数据数组。请打开控制台查看接口 payload。",
        );
      }

      showPanel({
        quotaWindow,
        dailyList,
        cycleStartMs,
        cycleEndMs,
        nowMs,
      });
    } catch (e) {
      console.error("[Codex Quota Compass]", e);
      alert("错误: " + (e?.message || String(e)));
    } finally {
      btn.disabled = false;
      btn.innerText = "📊 运行用量分析";
    }
  };

  GM_addStyle(`
  #codex-compass-root {
    position: fixed;
    top: 4%;
    left: 50%;
    transform: translateX(-50%);
    width: min(1180px, calc(100vw - 24px));
    max-height: 92vh;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 10px 50px rgba(0,0,0,0.3);
    z-index: 2147483647;
    padding: 20px;
    display: none;
    border: 1px solid #e5e5e5;
    color: #333;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    overflow: auto !important;
    box-sizing: border-box;
  }

  #codex-compass-root * {
    box-sizing: border-box;
  }

  .compass-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 15px;
  }

  .compass-header-main {
    min-width: 0;
    flex: 1 1 auto;
  }

  .compass-header-right {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    gap: 10px;
    flex: 0 0 auto;
    max-width: 42%;
  }

  .compass-title {
    font-size: 18px;
    font-weight: 600;
    line-height: 1.35;
    word-break: break-word;
  }

  .compass-product-title {
    font-size: 12px;
    color: #777;
    margin-top: 3px;
    line-height: 1.4;
    text-align: right;
    word-break: break-word;
  }

  .compass-close {
    cursor: pointer;
    font-size: 28px;
    color: #999;
    line-height: 1;
    user-select: none;
    flex-shrink: 0;
  }

  .compass-close:hover {
    color: #333;
  }

  .compass-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
  }

  .compass-card {
    background: #f9f9f9;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #eee;
    min-width: 0;
  }

  .compass-card.highlight {
    background: #eefaf5;
    border-color: #d1f2e1;
  }

  .card-label {
    font-size: 12px;
    color: #666;
    margin-bottom: 4px;
  }

  .card-value {
    font-size: 15px;
    font-weight: bold;
    color: #10a37f;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .compass-note {
    font-size: 12px;
    color: #6b7280;
    background: #f8fafc;
    border: 1px solid #e5e7eb;
    padding: 8px 10px;
    border-radius: 8px;
    margin-bottom: 14px;
    line-height: 1.45;
  }

  .compass-note.pricing {
    color: #065f46;
    background: #ecfdf5;
    border-color: #a7f3d0;
  }

  .compass-section {
    display: block !important;
    clear: both !important;
    margin: 16px 0 18px 0 !important;
    padding: 0 !important;
  }

  .compass-section-title {
    display: block !important;
    clear: both !important;
    margin: 0 0 8px 0 !important;
    padding: 0 !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    line-height: 1.5 !important;
    color: #333 !important;
  }

  .compass-section-title.muted {
    color: #666 !important;
  }

  .section-title-note {
    font-weight: 400 !important;
    color: #777 !important;
    margin-left: 6px !important;
  }

  .table-container {
    display: block !important;
    width: max-content !important;
    min-width: 100% !important;
    max-width: none !important;
    height: auto !important;
    max-height: none !important;
    min-height: 0 !important;
    overflow: visible !important;
    border: 1px solid #eee;
    border-radius: 6px;
    margin: 0 0 15px 0;
    background: #fff;
    clear: both !important;
  }

  .table-container::after {
    content: "";
    display: block;
    clear: both;
  }

  .table-container.wide,
  .table-container.compact,
  .table-container.model-turns-table-container {
    display: block !important;
    overflow: visible !important;
    height: auto !important;
    max-height: none !important;
    clear: both !important;
  }

  .compass-table {
    width: 100% !important;
    min-width: 760px !important;
    border-collapse: collapse !important;
    border-spacing: 0 !important;
    table-layout: auto !important;
    font-size: 12px !important;
    display: table !important;
  }

  .wide-table {
    min-width: 820px !important;
  }

  .breakdown-table {
    min-width: 640px !important;
  }

  .model-turns-table {
    width: max-content !important;
    min-width: 100% !important;
  }

  .compass-table thead {
    display: table-header-group !important;
    position: static !important;
    visibility: visible !important;
    opacity: 1 !important;
    background: #f5f5f5;
  }

  .compass-table tbody {
    display: table-row-group !important;
    visibility: visible !important;
    opacity: 1 !important;
  }

  .compass-table tfoot {
    display: table-footer-group !important;
    position: static !important;
    visibility: visible !important;
    opacity: 1 !important;
  }

  .compass-table tr {
    display: table-row !important;
    visibility: visible !important;
    opacity: 1 !important;
    height: auto !important;
    position: static !important;
  }

  .compass-table th,
  .compass-table td {
    display: table-cell !important;
    padding: 8px !important;
    border-bottom: 1px solid #f0f0f0 !important;
    vertical-align: middle !important;
    white-space: nowrap !important;
    visibility: visible !important;
    opacity: 1 !important;
    height: auto !important;
    line-height: 1.35 !important;
    position: static !important;
  }

  .compass-table th {
    text-align: left !important;
    color: #666 !important;
    background: #f5f5f5 !important;
    font-weight: 600 !important;
  }

  .compass-table td:first-child,
  .compass-table th:first-child {
    min-width: 140px !important;
    white-space: normal !important;
  }

  .model-turns-table th,
  .model-turns-table td {
    text-align: right !important;
  }

  .model-turns-table th:first-child,
  .model-turns-table td:first-child {
    text-align: left !important;
  }

  .compass-footer-row {
    background: #fafafa !important;
    font-weight: bold !important;
    position: static !important;
    border-top: 2px solid #eee !important;
  }

  #codex-compass-btn {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483646;
    padding: 10px 20px;
    background: #10a37f;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,0.16);
  }

  #codex-compass-btn:disabled {
    opacity: 0.72;
    cursor: wait;
  }

  @media (max-width: 1100px) {
    .compass-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .wide-table {
      min-width: 820px !important;
    }
  }

  @media (max-width: 720px) {
    #codex-compass-root {
      top: 12px;
      width: calc(100vw - 16px);
      max-height: calc(100vh - 24px);
      padding: 14px;
    }

    .compass-header {
      flex-direction: column;
      gap: 6px;
    }

    .compass-header-right {
      width: 100%;
      max-width: none;
      justify-content: space-between;
      align-items: center;
    }

    .compass-product-title {
      text-align: left;
    }

    .compass-grid {
      grid-template-columns: 1fr;
    }

    .compass-table {
      font-size: 11px !important;
      min-width: 760px !important;
    }

    .compass-table th,
    .compass-table td {
      padding: 6px !important;
    }

    .compass-table td:first-child,
    .compass-table th:first-child {
      min-width: 130px !important;
    }
  }
`);

  const mount = () => {
    if (document.getElementById("codex-compass-btn")) return;

    const btn = document.createElement("button");
    btn.id = "codex-compass-btn";
    btn.innerText = "📊 运行用量分析";
    btn.onclick = run;
    document.body.appendChild(btn);

    const root = document.createElement("div");
    root.id = "codex-compass-root";
    document.body.appendChild(root);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();