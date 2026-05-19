// ==UserScript==
// @name         Codex Quota Compass (Visual Edition)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Codex 配额分析：按 token-based rate card 估算 Credits / 金额
// @author       Jun Zhao / fixed by ChatGPT
// @match        https://chatgpt.com/codex/cloud/settings/analytics*
// @grant        GM_addStyle
// @source       https://linux.do/t/topic/2138324
// @note         打开 https://chatgpt.com/codex/cloud/settings/analytics#usage 页面使用
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    // 你原脚本里的换算：$40 / 1000 credits = $0.04 / credit
    USD_PER_CREDIT: 40 / 1000,

    // 默认按 Codex 代码审查/常见 Codex 模型 GPT-5.3-Codex 估算
    // 如果你实际主要用 GPT-5.5 / GPT-5.4，可以在面板顶部切换
    DEFAULT_MODEL: "gpt-5.5",

    DEBUG: true,
  };

  // OpenAI Codex token-based rate card：credits per 1M tokens
  // 来源：Codex rate card
  const RATE_CARDS = {
    "gpt-5.5": {
      label: "GPT-5.5",
      input: 125,
      cached: 12.5,
      output: 750,
    },
    "gpt-5.4": {
      label: "GPT-5.4",
      input: 62.5,
      cached: 6.25,
      output: 375,
    },
    "gpt-5.4-mini": {
      label: "GPT-5.4-Mini",
      input: 18.75,
      cached: 1.875,
      output: 113,
    },
    "gpt-5.3-codex": {
      label: "GPT-5.3-Codex",
      input: 43.75,
      cached: 4.375,
      output: 350,
    },
    "gpt-5.2": {
      label: "GPT-5.2",
      input: 43.75,
      cached: 4.375,
      output: 350,
    },
  };

  let currentModel = localStorage.getItem("codex-compass-model") || CONFIG.DEFAULT_MODEL;

  const safeNum = (v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const cleaned = v.replace(/[$,\s]/g, "");
      const matched = cleaned.match(/-?\d+(\.\d+)?/);
      if (!matched) return 0;
      const parsed = Number(matched[0]);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const num = Number(v);
    return Number.isFinite(num) ? num : 0;
  };

  const fmtNum = (n) => {
    n = safeNum(n);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toLocaleString();
  };

  const fmtUsd = (n) => {
    n = safeNum(n);
    if (n > 0 && n < 0.01) return "$ " + n.toFixed(4);
    return "$ " + n.toFixed(2);
  };

  const fmtCredits = (n) => {
    n = safeNum(n);
    if (n >= 1000) return n.toFixed(1);
    if (n >= 100) return n.toFixed(2);
    return n.toFixed(3);
  };

  function isObj(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  function deepSumByKeys(obj, keyTester, seen = new WeakSet()) {
    if (!isObj(obj) || seen.has(obj)) return 0;
    seen.add(obj);

    let sum = 0;

    for (const [key, value] of Object.entries(obj)) {
      if (keyTester(String(key).toLowerCase())) {
        sum += safeNum(value);
      }

      if (isObj(value)) {
        sum += deepSumByKeys(value, keyTester, seen);
      }
    }

    return sum;
  }

  function deepPickFirstNumber(obj, keyTester, seen = new WeakSet()) {
    if (!isObj(obj) || seen.has(obj)) return null;
    seen.add(obj);

    for (const [key, value] of Object.entries(obj)) {
      if (keyTester(String(key).toLowerCase())) {
        const num = safeNum(value);
        if (num !== 0) return num;
      }
    }

    for (const value of Object.values(obj)) {
      if (isObj(value)) {
        const found = deepPickFirstNumber(value, keyTester, seen);
        if (found !== null) return found;
      }
    }

    return null;
  }

  function getDate(row = {}) {
    return (
      row.date ||
      row.day ||
      row.start_date ||
      row.created_date ||
      row.bucket ||
      row.period_start ||
      "-"
    );
  }

  function getTurns(row = {}) {
    const direct =
      safeNum(row.turns) ||
      safeNum(row?.totals?.turns) ||
      safeNum(row.total_turns) ||
      safeNum(row?.totals?.total_turns) ||
      safeNum(row.requests) ||
      safeNum(row?.totals?.requests);

    if (direct) return direct;

    return (
      deepPickFirstNumber(row, (k) =>
        ["turns", "total_turns", "requests", "request_count", "count"].includes(k),
      ) || 0
    );
  }

  function getTokenParts(row = {}) {
    const cached =
      safeNum(row.cached_text_input_tokens) ||
      safeNum(row?.totals?.cached_text_input_tokens) ||
      safeNum(row.cached_input_tokens) ||
      safeNum(row?.totals?.cached_input_tokens) ||
      deepSumByKeys(row, (k) =>
        k.includes("cached") &&
        k.includes("token") &&
        !k.includes("uncached") &&
        !k.includes("total"),
      );

    const uncached =
      safeNum(row.uncached_text_input_tokens) ||
      safeNum(row?.totals?.uncached_text_input_tokens) ||
      safeNum(row.uncached_input_tokens) ||
      safeNum(row?.totals?.uncached_input_tokens) ||
      safeNum(row.text_input_tokens) ||
      safeNum(row?.totals?.text_input_tokens) ||
      safeNum(row.input_tokens) ||
      safeNum(row?.totals?.input_tokens) ||
      safeNum(row.prompt_tokens) ||
      safeNum(row?.totals?.prompt_tokens) ||
      deepSumByKeys(row, (k) =>
        (
          k.includes("uncached") ||
          k === "input_tokens" ||
          k === "text_input_tokens" ||
          k === "prompt_tokens"
        ) &&
        k.includes("token") &&
        !k.includes("cached_text")
      );

    const output =
      safeNum(row.text_output_tokens) ||
      safeNum(row?.totals?.text_output_tokens) ||
      safeNum(row.output_tokens) ||
      safeNum(row?.totals?.output_tokens) ||
      safeNum(row.completion_tokens) ||
      safeNum(row?.totals?.completion_tokens) ||
      deepSumByKeys(row, (k) =>
        (
          k.includes("output") ||
          k.includes("completion")
        ) &&
        k.includes("token")
      );

    let total =
      safeNum(row.text_total_tokens) ||
      safeNum(row?.totals?.text_total_tokens) ||
      safeNum(row.total_tokens) ||
      safeNum(row?.totals?.total_tokens) ||
      safeNum(row.tokens) ||
      safeNum(row?.totals?.tokens);

    if (!total) total = cached + uncached + output;

    return {
      cached,
      uncached,
      output,
      total,
    };
  }

  function estimateCredits(row = {}) {
    const rate = RATE_CARDS[currentModel] || RATE_CARDS[CONFIG.DEFAULT_MODEL];
    const parts = getTokenParts(row);

    const credits =
      (parts.uncached / 1_000_000) * rate.input +
      (parts.cached / 1_000_000) * rate.cached +
      (parts.output / 1_000_000) * rate.output;

    return credits;
  }

  function estimateUsd(row = {}) {
    return estimateCredits(row) * CONFIG.USD_PER_CREDIT;
  }

  function getUsedPercent(secondary = {}) {
    return (
      safeNum(secondary.used_percent) ||
      safeNum(secondary.usage_percent) ||
      safeNum(secondary.percent_used) ||
      0
    );
  }

  GM_addStyle(`
    #codex-compass-root {
      position: fixed;
      top: 5%;
      left: 50%;
      transform: translateX(-50%);
      width: 820px;
      max-height: 90vh;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 10px 50px rgba(0,0,0,0.3);
      z-index: 10001;
      padding: 24px;
      display: none;
      flex-direction: column;
      border: 1px solid #e5e5e5;
      color: #333;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }

    .compass-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .compass-title {
      font-size: 18px;
      font-weight: 600;
    }

    .compass-close {
      cursor: pointer;
      font-size: 28px;
      color: #999;
      line-height: 1;
    }

    .compass-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
      padding: 10px 12px;
      background: #f8f8f8;
      border: 1px solid #eee;
      border-radius: 8px;
      font-size: 12px;
    }

    .compass-toolbar select {
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid #ddd;
      background: white;
      font-size: 12px;
    }

    .compass-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }

    .compass-card {
      background: #f9f9f9;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #eee;
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
    }

    .table-container {
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid #eee;
      border-radius: 6px;
      margin-bottom: 15px;
    }

    .compass-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .compass-table thead {
      position: sticky;
      top: 0;
      background: #f5f5f5;
      z-index: 1;
    }

    .compass-table th {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid #eee;
      color: #666;
      white-space: nowrap;
    }

    .compass-table td {
      padding: 8px;
      border-bottom: 1px solid #f0f0f0;
      white-space: nowrap;
    }

    .compass-footer-row {
      background: #fafafa;
      font-weight: bold;
      position: sticky;
      bottom: 0;
      border-top: 2px solid #eee;
    }

    .compass-note {
      font-size: 11px;
      color: #777;
      line-height: 1.5;
      background: #fafafa;
      border: 1px solid #eee;
      border-radius: 8px;
      padding: 10px 12px;
    }

    #codex-compass-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      padding: 10px 20px;
      background: #10a37f;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0,0,0,0.18);
    }

    #codex-compass-btn:hover {
      background: #0d8c6d;
    }

    #codex-compass-btn:disabled {
      opacity: .7;
      cursor: not-allowed;
    }
  `);

  async function apiGet(path, token) {
    const res = await fetch(path, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();

    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`接口返回不是 JSON：HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(json?.detail || json?.message || `HTTP ${res.status}`);
    }

    return json;
  }

  function calcStats(list) {
    return list.reduce(
      (acc, row) => {
        const parts = getTokenParts(row);
        const credits = estimateCredits(row);
        const usd = credits * CONFIG.USD_PER_CREDIT;

        acc.cached += parts.cached;
        acc.uncached += parts.uncached;
        acc.output += parts.output;
        acc.tokens += parts.total;
        acc.turns += getTurns(row);
        acc.credits += credits;
        acc.usd += usd;

        return acc;
      },
      {
        cached: 0,
        uncached: 0,
        output: 0,
        tokens: 0,
        turns: 0,
        credits: 0,
        usd: 0,
      },
    );
  }

  function renderModelSelect() {
    return `
      <select id="codex-model-select">
        ${Object.entries(RATE_CARDS)
          .map(([key, value]) => {
            return `
              <option value="${key}" ${key === currentModel ? "selected" : ""}>
                ${value.label}
              </option>
            `;
          })
          .join("")}
      </select>
    `;
  }

  function showPanel(data) {
    const root = document.getElementById("codex-compass-root");
    const { secondary, dailyList, cycleStartDate } = data;

    const currentCycleList = [];
    const historyList = [];

    dailyList.forEach((item) => {
      const date = getDate(item);

      if (date !== "-" && new Date(date) < new Date(cycleStartDate)) {
        historyList.push(item);
      } else {
        currentCycleList.push(item);
      }
    });

    const currentStats = calcStats(currentCycleList);
    const historyStats = calcStats(historyList);
    const allStats = calcStats(dailyList);

    const usedPercent = getUsedPercent(secondary);
    const rate = RATE_CARDS[currentModel] || RATE_CARDS[CONFIG.DEFAULT_MODEL];

    let historyRangeTitle = "⏳ 历史记录";
    if (historyList.length > 0) {
      const sortedHistory = [...historyList].sort(
        (a, b) => new Date(getDate(a)) - new Date(getDate(b)),
      );

      historyRangeTitle = `⏳ 历史记录 (${getDate(sortedHistory[0])} 至 ${getDate(
        sortedHistory[sortedHistory.length - 1],
      )})`;
    }

    const renderTable = (list, stats) => `
      <div class="table-container">
        <table class="compass-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>Input</th>
              <th>Cached</th>
              <th>Output</th>
              <th>Total</th>
              <th>Credits估算</th>
              <th>金额估算</th>
              <th>轮数</th>
            </tr>
          </thead>
          <tbody>
            ${
              list.length
                ? [...list]
                    .reverse()
                    .map((row) => {
                      const parts = getTokenParts(row);
                      const credits = estimateCredits(row);
                      const usd = credits * CONFIG.USD_PER_CREDIT;

                      return `
                        <tr>
                          <td>${getDate(row)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.uncached)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.cached)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.output)}</td>
                          <td style="font-family:monospace">${fmtNum(parts.total)}</td>
                          <td style="font-family:monospace">${fmtCredits(credits)}</td>
                          <td style="font-family:monospace">${fmtUsd(usd)}</td>
                          <td>${getTurns(row)}</td>
                        </tr>
                      `;
                    })
                    .join("")
                : `
                  <tr>
                    <td colspan="8" style="text-align:center; color:#999; padding:14px;">
                      暂无数据
                    </td>
                  </tr>
                `
            }
          </tbody>
          <tfoot>
            <tr class="compass-footer-row">
              <td>合计</td>
              <td style="font-family:monospace">${fmtNum(stats.uncached)}</td>
              <td style="font-family:monospace">${fmtNum(stats.cached)}</td>
              <td style="font-family:monospace">${fmtNum(stats.output)}</td>
              <td style="font-family:monospace">${fmtNum(stats.tokens)}</td>
              <td style="font-family:monospace">${fmtCredits(stats.credits)}</td>
              <td style="color:#10a37f; font-family:monospace">${fmtUsd(stats.usd)}</td>
              <td>${stats.turns}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    root.innerHTML = `
      <div class="compass-header">
        <div class="compass-title">📊 Codex 配额深度分析 (V2.0)</div>
        <div class="compass-close" id="compass-close-btn">&times;</div>
      </div>

      <div class="compass-toolbar">
        <div>
          当前估算模型：
          ${renderModelSelect()}
        </div>
        <div>
          费率：Input ${rate.input} / Cached ${rate.cached} / Output ${rate.output} credits per 1M tokens
        </div>
      </div>

      <div class="compass-grid">
        <div class="compass-card">
          <div class="card-label">已用比例</div>
          <div class="card-value">${usedPercent}%</div>
        </div>

        <div class="compass-card">
          <div class="card-label">本周期 Credits估算</div>
          <div class="card-value">
            ${fmtCredits(currentStats.credits)}
          </div>
        </div>

        <div class="compass-card highlight">
          <div class="card-label">本周期金额估算</div>
          <div class="card-value">
            ${fmtUsd(currentStats.usd)}
          </div>
        </div>

        <div class="compass-card">
          <div class="card-label">近30天金额估算</div>
          <div class="card-value">
            ${fmtUsd(allStats.usd)}
          </div>
        </div>
      </div>

      <div style="font-weight:600; margin-bottom:8px; font-size:13px;">
        📅 本周期明细 (始于 ${cycleStartDate})
      </div>
      ${renderTable(currentCycleList, currentStats)}

      ${
        historyList.length > 0
          ? `
            <div style="font-weight:600; margin-bottom:8px; font-size:13px; color:#666; margin-top:5px;">
              ${historyRangeTitle}
            </div>
            ${renderTable(historyList, historyStats)}
          `
          : ""
      }

      <div class="compass-note">
        说明：你的接口日志里 credits 和 usd 都是 0，说明 daily usage 接口没有直接返回金额。
        这版改为按 token 类型估算：uncached input / cached input / output tokens × Codex rate card。
        金额使用你原脚本的换算：1000 credits = $40，即 1 credit = $0.04。
        如果你主要用 GPT-5.5 或 GPT-5.4，请在上方切换模型，表格会自动重算。
      </div>
    `;

    root.style.display = "flex";

    document.getElementById("compass-close-btn").onclick = () => {
      root.style.display = "none";
    };

    document.getElementById("codex-model-select").onchange = (e) => {
      currentModel = e.target.value;
      localStorage.setItem("codex-compass-model", currentModel);
      showPanel(data);
    };
  }

  async function run() {
    const btn = document.getElementById("codex-compass-btn");

    const bootstrapData =
      document.getElementById("client-bootstrap")?.textContent || "";

    const token = bootstrapData.match(
      /[\w-]{30,}\.[\w-]{30,}\.[\w-]{30,}/,
    )?.[0];

    if (!token) {
      alert("令牌获取失败，请确保已登录 ChatGPT。");
      return;
    }

    btn.innerText = "分析中...";
    btn.disabled = true;

    try {
      const usage = await apiGet("/backend-api/wham/usage", token);

      const secondary =
        usage?.rate_limit?.secondary_window ||
        usage?.rate_limit?.primary_window ||
        usage?.secondary_window ||
        usage?.primary_window ||
        {};

      const endDate = new Date(Date.now() + 86400000)
        .toISOString()
        .split("T")[0];

      const startDate = new Date(Date.now() - 30 * 86400000)
        .toISOString()
        .split("T")[0];

      const resetAt = safeNum(secondary.reset_at);
      const limitWindowSeconds = safeNum(secondary.limit_window_seconds);

      const cycleStartDate =
        resetAt > 0 && limitWindowSeconds > 0
          ? new Date((resetAt - limitWindowSeconds) * 1000)
              .toISOString()
              .split("T")[0]
          : startDate;

      const dailyData = await apiGet(
        `/backend-api/wham/analytics/daily-workspace-usage-counts?start_date=${startDate}&end_date=${endDate}&group_by=day`,
        token,
      );

      const dailyList =
        Array.isArray(dailyData?.data)
          ? dailyData.data
          : Array.isArray(dailyData?.items)
            ? dailyData.items
            : Array.isArray(dailyData?.results)
              ? dailyData.results
              : [];

      if (CONFIG.DEBUG) {
        console.group("[Codex Quota Compass] 调试信息 V2.0");
        console.log("usage 原始数据:", usage);
        console.log("dailyData 原始数据:", dailyData);
        console.table(
          dailyList.map((row) => {
            const parts = getTokenParts(row);
            const credits = estimateCredits(row);

            return {
              date: getDate(row),
              input_tokens: parts.uncached,
              cached_tokens: parts.cached,
              output_tokens: parts.output,
              total_tokens: parts.total,
              estimated_credits: credits,
              estimated_usd: credits * CONFIG.USD_PER_CREDIT,
              turns: getTurns(row),
            };
          }),
        );
        console.groupEnd();
      }

      showPanel({
        secondary,
        dailyList,
        cycleStartDate,
      });
    } catch (e) {
      console.error("[Codex Quota Compass] 错误:", e);
      alert("错误: " + (e?.message || e));
    } finally {
      btn.innerText = "📊 运行用量分析";
      btn.disabled = false;
    }
  }

  function init() {
    if (document.getElementById("codex-compass-btn")) return;

    const btn = document.createElement("button");
    btn.id = "codex-compass-btn";
    btn.innerText = "📊 运行用量分析";
    btn.onclick = run;
    document.body.appendChild(btn);

    const root = document.createElement("div");
    root.id = "codex-compass-root";
    document.body.appendChild(root);
  }

  init();
})();