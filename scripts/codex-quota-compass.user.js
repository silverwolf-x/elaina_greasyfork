// ==UserScript==
// @name         Codex Quota Compass (Visual Edition)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  人性化展示 Codex 配额，强化 Credits 标注，增加历史合计及动态日期范围（Token 以 M 为单位）
// @author       Jun Zhao
// @match        https://chatgpt.com/codex/cloud/settings/analytics*
// @grant        GM_addStyle
// @source       https://linux.do/t/topic/2138324
// @note         打开 https://chatgpt.com/codex/cloud/settings/analytics#usage 页面使用
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    USD_PER_CREDIT: 40 / 1000,
  };

  // 修改：将中文的“亿/万”单位替换为国际标准的“M/K”单位
  const fmtNum = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toLocaleString();
  };

  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tokenTotal = (obj = {}) =>
    n(obj.text_total_tokens) ||
    n(obj.cached_text_input_tokens) +
      n(obj.uncached_text_input_tokens) +
      n(obj.text_output_tokens);

  GM_addStyle(`
        #codex-compass-root {
            position: fixed; top: 5%; left: 50%; transform: translateX(-50%);
            width: 720px; max-height: 90vh; background: #fff;
            border-radius: 12px; box-shadow: 0 10px 50px rgba(0,0,0,0.3);
            z-index: 10001; padding: 24px; display: none;
            flex-direction: column; border: 1px solid #e5e5e5; color: #333;
            font-family: -apple-system, system-ui, sans-serif;
        }
        .compass-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .compass-title { font-size: 18px; font-weight: 600; }
        .compass-close { cursor: pointer; font-size: 28px; color: #999; line-height: 1; }
        .compass-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
        .compass-card { background: #f9f9f9; padding: 12px; border-radius: 8px; border: 1px solid #eee; }
        .compass-card.highlight { background: #eefaf5; border-color: #d1f2e1; }
        .card-label { font-size: 12px; color: #666; margin-bottom: 4px; }
        .card-value { font-size: 15px; font-weight: bold; color: #10a37f; white-space: nowrap; }

        .table-container {
            max-height: 220px; overflow-y: auto; border: 1px solid #eee;
            border-radius: 6px; margin-bottom: 15px;
        }
        .compass-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .compass-table thead { position: sticky; top: 0; background: #f5f5f5; z-index: 1; }
        .compass-table th { text-align: left; padding: 8px; border-bottom: 1px solid #eee; color: #666; }
        .compass-table td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
        .compass-footer-row { background: #fafafa; font-weight: bold; position: sticky; bottom: 0; border-top: 2px solid #eee; }

        #codex-compass-btn {
            position: fixed; bottom: 20px; right: 20px; z-index: 10000;
            padding: 10px 20px; background: #10a37f; color: white;
            border: none; border-radius: 8px; cursor: pointer; font-weight: 600;
        }
    `);

  async function apiGet(path, token) {
    const res = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  }

  const showPanel = (data) => {
    const root = document.getElementById("codex-compass-root");
    const { secondary, dailyList, cycleStartDate } = data;

    // 1. 数据切分
    const currentCycleList = [];
    const historyList = [];
    dailyList.forEach((item) => {
      if (new Date(item.date) >= new Date(cycleStartDate)) {
        currentCycleList.push(item);
      } else {
        historyList.push(item);
      }
    });

    // 2. 统计计算辅助函数
    const getStats = (list) => {
      const credits = list.reduce(
        (sum, d) => sum + (d.totals?.credits || 0),
        0,
      );
      const turns = list.reduce((sum, d) => sum + (d.totals?.turns || 0), 0);
      const tokens = list.reduce((sum, d) => sum + tokenTotal(d.totals), 0);
      return { credits, turns, tokens, usd: credits * CONFIG.USD_PER_CREDIT };
    };

    const currentStats = getStats(currentCycleList);
    const historyStats = getStats(historyList);

    const ratio = (secondary?.used_percent || 0) / 100;
    const estCredits =
      ratio > 0 ? (currentStats.credits / ratio).toFixed(1) : "0";

    // 3. 历史记录日期范围计算
    let historyRangeTitle = "⏳ 历史记录 (本周期外)";
    if (historyList.length > 0) {
      const sortedHistory = [...historyList].sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
      const startStr = sortedHistory[0].date;
      const endStr = sortedHistory[sortedHistory.length - 1].date;
      historyRangeTitle = `⏳ 历史记录 (本周期外 ${endStr} 至 ${startStr})`;
    }

    const renderTable = (list, stats) => `
            <div class="table-container">
                <table class="compass-table">
                    <thead>
                        <tr><th>日期</th><th>Credits</th><th>Tokens</th><th>金额</th><th>轮数</th></tr>
                    </thead>
                    <tbody>
                        ${[...list]
                          .reverse()
                          .map(
                            (row) => `
                            <tr>
                                <td>${row.date}</td>
                                <td style="font-family:monospace">${(row.totals?.credits || 0).toFixed(3)}</td>
                                <td style="font-family:monospace">${fmtNum(tokenTotal(row.totals))}</td>
                                <td>$ ${((row.totals?.credits || 0) * CONFIG.USD_PER_CREDIT).toFixed(2)}</td>
                                <td>${row.totals?.turns || 0}</td>
                            </tr>
                        `,
                          )
                          .join("")}
                    </tbody>
                    <tfoot>
                        <tr class="compass-footer-row">
                            <td>合计</td>
                            <td>${stats.credits.toFixed(3)}</td>
                            <td style="font-family:monospace">${fmtNum(stats.tokens)}</td>
                            <td style="color:#10a37f">$ ${stats.usd.toFixed(2)}</td>
                            <td>${stats.turns}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;

    root.innerHTML = `
            <div class="compass-header">
                <div class="compass-title">📊 Codex 配额深度分析 (V1.8)</div>
                <div class="compass-close" id="compass-close-btn">&times;</div>
            </div>
            <div class="compass-grid">
                <div class="compass-card">
                    <div class="card-label">已用比例</div>
                    <div class="card-value">${secondary?.used_percent || 0}%</div>
                </div>
                <div class="compass-card">
                    <div class="card-label">本周已用</div>
                    <div class="card-value">${currentStats.credits.toFixed(1)} <span style="font-size:10px; font-weight:normal">Credits</span></div>
                </div>
                <div class="compass-card highlight">
                    <div class="card-label">推算总额</div>
                    <div class="card-value">${estCredits} <span style="font-size:10px; font-weight:normal">Credits</span></div>
                </div>
                <div class="compass-card">
                    <div class="card-label">周价值 (估算)</div>
                    <div class="card-value">$ ${(estCredits * CONFIG.USD_PER_CREDIT).toFixed(2)}</div>
                </div>
            </div>

            <div style="font-weight:600; margin-bottom:8px; font-size:13px;">📅 本周期明细 (始于 ${cycleStartDate})</div>
            ${renderTable(currentCycleList, currentStats)}

            ${
              historyList.length > 0
                ? `
            <div style="font-weight:600; margin-bottom:8px; font-size:13px; color: #666; margin-top: 5px;">${historyRangeTitle}</div>
            ${renderTable(historyList, historyStats)}
            `
                : ""
            }
        `;

    root.style.display = "flex";
    document.getElementById("compass-close-btn").onclick = () =>
      (root.style.display = "none");
  };

  const run = async () => {
    const btn = document.getElementById("codex-compass-btn");
    const bootstrapData =
      document.getElementById("client-bootstrap")?.textContent;
    const token = bootstrapData?.match(
      /[\w-]{30,}\.[\w-]{30,}\.[\w-]{30,}/,
    )?.[0];
    if (!token) return alert("令牌获取失败，请确保已登录。");

    btn.innerText = "分析中...";
    try {
      const usage = await apiGet("/backend-api/wham/usage", token);
      const secondary =
        usage?.rate_limit?.secondary_window ||
        usage?.rate_limit?.primary_window;

      const endDate = new Date(Date.now() + 86400000)
        .toISOString()
        .split("T")[0];
      const startDate = new Date(Date.now() - 30 * 86400000)
        .toISOString()
        .split("T")[0];
      const cycleStartDate = secondary
        ? new Date((secondary.reset_at - secondary.limit_window_seconds) * 1000)
            .toISOString()
            .split("T")[0]
        : startDate;

      const dailyData = await apiGet(
        `/backend-api/wham/analytics/daily-workspace-usage-counts?start_date=${startDate}&end_date=${endDate}&group_by=day`,
        token,
      );

      showPanel({ secondary, dailyList: dailyData.data || [], cycleStartDate });
    } catch (e) {
      alert("错误: " + e.message);
    } finally {
      btn.innerText = "📊 运行用量分析";
    }
  };

  const btn = document.createElement("button");
  btn.id = "codex-compass-btn";
  btn.innerText = "📊 运行用量分析";
  btn.onclick = run;
  document.body.appendChild(btn);

  const root = document.createElement("div");
  root.id = "codex-compass-root";
  document.body.appendChild(root);
})();