/**
 * Cloudflare Worker - 股票即時報價 API
 *
 * 資料來源：
 *   - 上市/上櫃：TWSE API (mis.twse.com.tw)
 *   - 興櫃：Fugle API (api.fugle.tw)
 *
 * 環境變數（在 Cloudflare Dashboard 設定）：
 *   - FUGLE_API_KEY: Fugle API 金鑰（興櫃股票用）
 *   - ADMIN_KEY: 管理員密碼
 *   - VERCEL_AI_KEY: Vercel AI Gateway 金鑰
 *
 * D1 Database:
 *   - DB: 儲存文章與股票標記 (SQLite)
 *
 * API 用法：
 *   單支股票：  /api/stock?code=2330
 *   多支股票：  /api/stock?code=2330,2303,6826
 *   文章管理：  /api/articles (GET/POST)
 *   股票文章：  /api/stock-articles?code=2308
 *
 * 回傳格式：
 *   { "data": [{ "code": "2330", "name": "台積電", "price": 1810.00 }], "time": "..." }
 */

// 興櫃股票清單
var EMERGING_STOCKS = ["6826", "7822", "7853"];

// 股票分割記錄 (用於調整歷史價格)
// 0050 在 2025/06/18 恢復交易（分割後），分割前 188.65 → 分割後 47.16，比例為 4
var STOCK_SPLITS = {
    "0050": [
        { date: 20250618, ratio: 4 }
    ]
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 處理 CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // 路由
    if (url.pathname === "/api/stock") {
      return corsResponse(await handleStock(url, env));
    }

    if (url.pathname === "/api/history") {
      return corsResponse(await handleHistory(url));
    }

    // Fugle 歷史 K 線查詢
    if (url.pathname === "/api/fugle-candles") {
      return corsResponse(await handleFugleCandles(url, env));
    }

    // 文章 API
    if (url.pathname === "/api/articles") {
      if (request.method === "GET") {
        return corsResponse(await handleGetArticles(url, env));
      }
      if (request.method === "POST") {
        return corsResponse(await handleCreateArticle(request, env));
      }
    }

    // 單篇文章
    if (url.pathname.match(/^\/api\/articles\/\d+$/)) {
      var articleId = url.pathname.split("/").pop();
      if (request.method === "GET") {
        return corsResponse(await handleGetArticle(articleId, env));
      }
      if (request.method === "DELETE") {
        return corsResponse(await handleDeleteArticle(articleId, request, env));
      }
    }

    // 股票相關文章
    if (url.pathname === "/api/stock-articles") {
      return corsResponse(await handleStockArticles(url, env));
    }

    // 系統狀態檢查
    if (url.pathname === "/api/status") {
      return corsResponse(jsonResponse({
        status: "ok",
        env: {
          VERCEL_AI_KEY: env.VERCEL_AI_KEY ? "已設定" : "未設定",
          FUGLE_API_KEY: env.FUGLE_API_KEY ? "已設定" : "未設定",
          DB: env.DB ? "已連接" : "未連接"
        }
      }));
    }

    // AI 標記測試（支援 GET）
    if (url.pathname === "/api/test-ai") {
      try {
        var testContent = url.searchParams.get("q") || "國巨於2026年3月調漲鉭質電容報價15~20%。台半、德微預計調漲產品報價。";
        var result = await testAITagging(testContent, env.VERCEL_AI_KEY);
        return corsResponse(jsonResponse(result));
      } catch (e) {
        return corsResponse(jsonResponse({ error: e.message }, 500));
      }
    }

    return corsResponse(new Response(
      JSON.stringify({ error: "請使用 /api/stock?code=2330" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    ));
  }
};

/**
 * 處理歷史價格查詢
 * 用法：/api/history?code=0050&date=20260102
 * 如果指定日期為假日，會自動找尋上一個交易日的收盤價
 */
async function handleHistory(url) {
  var code = url.searchParams.get("code");
  var dateParam = url.searchParams.get("date");

  if (!code) {
    return jsonResponse({ error: "請提供 code 參數" }, 400);
  }
  if (!dateParam || dateParam.length !== 8) {
    return jsonResponse({ error: "請提供 date 參數，格式為 YYYYMMDD" }, 400);
  }

  var year = parseInt(dateParam.substring(0, 4));
  var month = parseInt(dateParam.substring(4, 6));
  var day = parseInt(dateParam.substring(6, 8));
  var targetDateNum = year * 10000 + month * 100 + day;

  // 最多往前查 3 個月
  for (var monthOffset = 0; monthOffset < 3; monthOffset++) {
    var queryYear = year;
    var queryMonth = month - monthOffset;

    // 處理跨年
    while (queryMonth < 1) {
      queryMonth += 12;
      queryYear -= 1;
    }

    var queryDate = queryYear.toString() +
      (queryMonth < 10 ? "0" : "") + queryMonth + "01";

    // 查詢 TWSE 歷史資料（該月份的每日成交資料）
    var twseUrl = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=" + queryDate + "&stockNo=" + code;

    try {
      var resp = await fetch(twseUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!resp.ok) continue;

      var data = await resp.json();

      if (data && data.stat === "OK" && data.data && data.data.length > 0) {
        // 找到小於等於目標日期的最近交易日
        var closestRow = null;
        var closestDateNum = 0;

        for (var i = 0; i < data.data.length; i++) {
          var row = data.data[i];
          // row[0] 是民國年格式的日期 "114/01/02"
          var parts = row[0].split("/");
          var rowYear = parseInt(parts[0]) + 1911;
          var rowMonth = parseInt(parts[1]);
          var rowDay = parseInt(parts[2]);
          var rowDateNum = rowYear * 10000 + rowMonth * 100 + rowDay;

          // 找小於等於目標日期的最大日期
          if (rowDateNum <= targetDateNum && rowDateNum > closestDateNum) {
            closestDateNum = rowDateNum;
            closestRow = row;
          }
        }

        if (closestRow) {
          var closePrice = parseFloat(closestRow[6].replace(/,/g, ""));
          if (!isNaN(closePrice)) {
            var foundYear = Math.floor(closestDateNum / 10000);
            var foundMonth = Math.floor((closestDateNum % 10000) / 100);
            var foundDay = closestDateNum % 100;

            // 調整股票分割
            var adjustedPrice = adjustForSplits(code, closestDateNum, closePrice);

            return jsonResponse({
              code: code,
              date: foundYear + "-" + (foundMonth < 10 ? "0" : "") + foundMonth + "-" + (foundDay < 10 ? "0" : "") + foundDay,
              price: adjustedPrice,
              rawPrice: closePrice !== adjustedPrice ? closePrice : undefined
            });
          }
        }
      } else if (monthOffset === 0) {
        // 嘗試 OTC (上櫃) API
        var result = await fetchOTCHistory(code, year, month, day, targetDateNum);
        if (result) return jsonResponse(result);
      }

    } catch (e) {
      // 繼續嘗試下一個月
    }
  }

  return jsonResponse({ error: "找不到該日期之前的交易資料" }, 404);
}

/**
 * 查詢上櫃股票歷史價格
 */
async function fetchOTCHistory(code, year, month, day, targetDateNum) {
  // 最多往前查 3 個月
  for (var monthOffset = 0; monthOffset < 3; monthOffset++) {
    var queryYear = year;
    var queryMonth = month - monthOffset;

    while (queryMonth < 1) {
      queryMonth += 12;
      queryYear -= 1;
    }

    var otcUrl = "https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=" +
      (queryYear - 1911) + "/" + (queryMonth < 10 ? "0" : "") + queryMonth + "&stkno=" + code;

    try {
      var otcResp = await fetch(otcUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!otcResp.ok) continue;

      var otcData = await otcResp.json();

      if (otcData && otcData.aaData && otcData.aaData.length > 0) {
        var closestRow = null;
        var closestDateNum = 0;

        for (var i = 0; i < otcData.aaData.length; i++) {
          var row = otcData.aaData[i];
          // row[0] 是民國年格式 "114/01/02"
          var parts = row[0].split("/");
          var rowYear = parseInt(parts[0]) + 1911;
          var rowMonth = parseInt(parts[1]);
          var rowDay = parseInt(parts[2]);
          var rowDateNum = rowYear * 10000 + rowMonth * 100 + rowDay;

          if (rowDateNum <= targetDateNum && rowDateNum > closestDateNum) {
            closestDateNum = rowDateNum;
            closestRow = row;
          }
        }

        if (closestRow) {
          var closePrice = parseFloat(closestRow[6].replace(/,/g, ""));
          if (!isNaN(closePrice)) {
            var foundYear = Math.floor(closestDateNum / 10000);
            var foundMonth = Math.floor((closestDateNum % 10000) / 100);
            var foundDay = closestDateNum % 100;

            // 調整股票分割
            var adjustedPrice = adjustForSplits(code, closestDateNum, closePrice);

            return {
              code: code,
              date: foundYear + "-" + (foundMonth < 10 ? "0" : "") + foundMonth + "-" + (foundDay < 10 ? "0" : "") + foundDay,
              price: adjustedPrice,
              rawPrice: closePrice !== adjustedPrice ? closePrice : undefined
            };
          }
        }
      }
    } catch (e) {
      // 繼續嘗試
    }
  }

  return null;
}

async function handleStock(url, env) {
  var codeParam = url.searchParams.get("code");
  if (!codeParam) {
    return jsonResponse({ error: "請提供 code 參數，例如 ?code=2330" }, 400);
  }

  var codes = codeParam.split(",").map(function(c) { return c.trim(); }).filter(Boolean);
  if (codes.length === 0) {
    return jsonResponse({ error: "股票代號不可為空" }, 400);
  }
  if (codes.length > 100) {
    return jsonResponse({ error: "一次最多查詢 100 支股票" }, 400);
  }

  // 分離興櫃和非興櫃股票
  var emergingCodes = [];
  var regularCodes = [];
  for (var i = 0; i < codes.length; i++) {
    if (EMERGING_STOCKS.indexOf(codes[i]) !== -1) {
      emergingCodes.push(codes[i]);
    } else {
      regularCodes.push(codes[i]);
    }
  }

  var stockMap = {};

  // 查詢非興櫃股票 (TWSE API)
  if (regularCodes.length > 0) {
    var tseExCh = regularCodes.map(function(code) { return "tse_" + code + ".tw"; }).join("|");
    var otcExCh = regularCodes.map(function(code) { return "otc_" + code + ".tw"; }).join("|");

    var tseUrl = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + tseExCh;
    var otcUrl = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + otcExCh;

    var [tseData, otcData] = await Promise.all([
      fetchTWSE(tseUrl),
      fetchTWSE(otcUrl)
    ]);

    if (otcData && otcData.msgArray) {
      for (var i = 0; i < otcData.msgArray.length; i++) {
        var stock = otcData.msgArray[i];
        if (stock.c && hasValidPrice(stock)) {
          stockMap[stock.c] = {
            code: stock.c,
            name: stock.n || "",
            full_name: stock.nf || "",
            price: getPrice(stock)
          };
        }
      }
    }

    if (tseData && tseData.msgArray) {
      for (var i = 0; i < tseData.msgArray.length; i++) {
        var stock = tseData.msgArray[i];
        if (stock.c && hasValidPrice(stock)) {
          stockMap[stock.c] = {
            code: stock.c,
            name: stock.n || "",
            full_name: stock.nf || "",
            price: getPrice(stock)
          };
        }
      }
    }
  }

  // 查詢興櫃股票 (Fugle API)
  if (emergingCodes.length > 0 && env && env.FUGLE_API_KEY) {
    var fuglePromises = emergingCodes.map(function(code) {
      return fetchFugle(code, env.FUGLE_API_KEY);
    });
    var fugleResults = await Promise.all(fuglePromises);

    for (var i = 0; i < fugleResults.length; i++) {
      var result = fugleResults[i];
      if (result) {
        stockMap[result.code] = result;
      }
    }
  }

  // 按原始順序輸出
  var result = [];
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    if (stockMap[code]) {
      result.push(stockMap[code]);
    }
  }

  if (result.length === 0) {
    return jsonResponse({ error: "無法取得股票資料" }, 502);
  }

  return jsonResponse({
    data: result,
    time: new Date().toISOString()
  });
}

/**
 * 透過 Fugle API 查詢興櫃股票
 */
async function fetchFugle(code, apiKey) {
  try {
    var resp = await fetch(
      "https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/" + code,
      {
        headers: {
          "X-API-KEY": apiKey
        }
      }
    );
    if (resp.ok) {
      var data = await resp.json();
      if (data) {
        // Fugle API 回傳格式處理
        var price = null;
        if (data.lastPrice) {
          price = data.lastPrice;
        } else if (data.closePrice) {
          price = data.closePrice;
        } else if (data.openPrice) {
          price = data.openPrice;
        }

        return {
          code: code,
          name: data.name || "",
          full_name: data.name || "",
          price: price,
          source: "fugle"
        };
      }
    }
  } catch (e) {
    // Fugle API 錯誤
  }
  return null;
}

function hasValidPrice(stock) {
  if (stock.z && stock.z !== "-") return true;
  if (stock.b && stock.b !== "-") return true;
  if (stock.a && stock.a !== "-") return true;
  // 漲停/跌停時可能只有昨收或漲跌停價
  if (stock.y && stock.y !== "-") return true;
  if (stock.u && stock.u !== "-") return true;
  return false;
}

async function fetchTWSE(url) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(function(r) { setTimeout(r, 500 * attempt); });
      }
      var resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (resp.ok) {
        var data = await resp.json();
        if (data && data.msgArray) return data;
      }
    } catch (e) {
      // 重試
    }
  }
  return null;
}

/**
 * 取得現價：z（成交價）→ b（最新買價）→ a（最新賣價）→ u（漲停價）→ w（跌停價）→ y（昨收）
 * 漲停時：z 可能有值或為 "-"，b 應該是漲停價，a 通常為 "-"
 * 跌停時：z 可能有值或為 "-"，a 應該是跌停價，b 通常為 "-"
 */
function getPrice(stock) {
  // 1. 成交價
  if (stock.z && stock.z !== "-") {
    var val = parseFloat(stock.z);
    if (!isNaN(val) && val > 0) return val;
  }
  // 2. 最佳買價（漲停時買盤掛在漲停價）
  if (stock.b && stock.b !== "-") {
    var first = stock.b.split("_")[0];
    var val = parseFloat(first);
    if (!isNaN(val) && val > 0) return val;
  }
  // 3. 最佳賣價（跌停時賣盤掛在跌停價）
  if (stock.a && stock.a !== "-") {
    var first = stock.a.split("_")[0];
    var val = parseFloat(first);
    if (!isNaN(val) && val > 0) return val;
  }
  // 4. 漲停價（無成交時的參考價）
  if (stock.u && stock.u !== "-") {
    var val = parseFloat(stock.u);
    if (!isNaN(val) && val > 0) return val;
  }
  // 5. 跌停價
  if (stock.w && stock.w !== "-") {
    var val = parseFloat(stock.w);
    if (!isNaN(val) && val > 0) return val;
  }
  // 6. 昨收（最後手段）
  if (stock.y && stock.y !== "-") {
    var val = parseFloat(stock.y);
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
}

/**
 * Fugle 歷史 K 線查詢
 * 用法：/api/fugle-candles?code=0050&from=2025-01-01&to=2026-02-11
 */
async function handleFugleCandles(url, env) {
  var code = url.searchParams.get("code");
  var from = url.searchParams.get("from");
  var to = url.searchParams.get("to");

  if (!code) {
    return jsonResponse({ error: "請提供 code 參數" }, 400);
  }
  if (!env || !env.FUGLE_API_KEY) {
    return jsonResponse({ error: "未設定 FUGLE_API_KEY" }, 500);
  }

  // 預設日期範圍
  if (!to) {
    to = new Date().toISOString().split("T")[0];
  }
  if (!from) {
    var d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    from = d.toISOString().split("T")[0];
  }

  try {
    var fugleUrl = "https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/" + code +
      "?from=" + from + "&to=" + to + "&timeframe=D";

    var resp = await fetch(fugleUrl, {
      headers: { "X-API-KEY": env.FUGLE_API_KEY }
    });

    if (!resp.ok) {
      var errText = await resp.text();
      return jsonResponse({ error: "Fugle API 錯誤", status: resp.status, detail: errText }, resp.status);
    }

    var data = await resp.json();
    return jsonResponse({
      source: "fugle",
      code: code,
      from: from,
      to: to,
      data: data
    });
  } catch (e) {
    return jsonResponse({ error: "查詢失敗", message: e.message }, 500);
  }
}

/**
 * 調整股票分割後的歷史價格
 * 將分割前的價格調整為等效的分割後價格
 */
function adjustForSplits(code, dateNum, price) {
  var splits = STOCK_SPLITS[code];
  if (!splits) return price;

  var adjustedPrice = price;
  for (var i = 0; i < splits.length; i++) {
    var split = splits[i];
    // 如果查詢日期在分割日之前，則需要調整價格
    if (dateNum < split.date) {
      adjustedPrice = adjustedPrice / split.ratio;
    }
  }

  // 四捨五入到小數點後兩位
  return Math.round(adjustedPrice * 100) / 100;
}

/**
 * 取得文章列表
 * GET /api/articles
 * GET /api/articles?code=2308 (篩選含特定股票的文章)
 */
async function handleGetArticles(url, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "D1 尚未設定" }, 500);
  }

  try {
    var code = url.searchParams.get("code");
    var result;

    if (code) {
      // 查詢含特定股票的文章
      result = await env.DB.prepare(`
        SELECT DISTINCT a.id, a.title, a.publish_date, a.created_at
        FROM articles a
        INNER JOIN article_stocks ast ON a.id = ast.article_id
        WHERE ast.stock_code = ?
        ORDER BY a.publish_date DESC
      `).bind(code).all();
    } else {
      // 查詢所有文章
      result = await env.DB.prepare(
        "SELECT id, title, publish_date, created_at FROM articles ORDER BY publish_date DESC"
      ).all();
    }

    return jsonResponse({ articles: result.results });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * 取得單篇文章
 * GET /api/articles/:id
 */
async function handleGetArticle(id, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "D1 尚未設定" }, 500);
  }

  try {
    var article = await env.DB.prepare(
      "SELECT * FROM articles WHERE id = ?"
    ).bind(id).first();

    if (!article) {
      return jsonResponse({ error: "文章不存在" }, 404);
    }

    // 取得該文章的股票標記
    var stocks = await env.DB.prepare(
      "SELECT stock_code, stock_name, paragraph FROM article_stocks WHERE article_id = ? ORDER BY stock_code"
    ).bind(id).all();

    return jsonResponse({
      article: article,
      stocks: stocks.results
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * 新增文章並用 AI 標記股票
 * POST /api/articles
 */
async function handleCreateArticle(request, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "D1 尚未設定" }, 500);
  }

  try {
    var body = await request.json();
    var title = body.title;
    var content = body.content;
    var publishDate = body.publish_date || new Date().toISOString().split("T")[0];

    if (!content) {
      return jsonResponse({ error: "請提供文章內容" }, 400);
    }

    // 1. 用 AI 標記股票
    var stockTags = [];
    if (env.VERCEL_AI_KEY) {
      stockTags = await tagStocksWithAI(content, env.VERCEL_AI_KEY);
    } else {
      // fallback: 用 regex 解析 "股票名(代號)" 格式
      stockTags = parseStocksFromContent(content);
    }

    // 2. 儲存文章
    var result = await env.DB.prepare(`
      INSERT INTO articles (title, content, publish_date)
      VALUES (?, ?, ?)
    `).bind(
      title || "週報 " + publishDate,
      content,
      publishDate
    ).run();

    var articleId = result.meta.last_row_id;

    // 3. 儲存股票標記
    for (var i = 0; i < stockTags.length; i++) {
      var tag = stockTags[i];
      await env.DB.prepare(`
        INSERT OR IGNORE INTO article_stocks (article_id, stock_code, stock_name, paragraph)
        VALUES (?, ?, ?, ?)
      `).bind(articleId, tag.code, tag.name, tag.paragraph || "").run();
    }

    return jsonResponse({
      success: true,
      id: articleId,
      stocks_tagged: stockTags.length,
      stocks: stockTags
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * 刪除文章
 * DELETE /api/articles/:id
 */
async function handleDeleteArticle(id, request, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "D1 尚未設定" }, 500);
  }

  try {
    await env.DB.prepare("DELETE FROM article_stocks WHERE article_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
    return jsonResponse({ success: true, deleted: id });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * 查詢某股票的所有相關文章段落
 * GET /api/stock-articles?code=2308
 */
async function handleStockArticles(url, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "D1 尚未設定" }, 500);
  }

  var code = url.searchParams.get("code");
  if (!code) {
    return jsonResponse({ error: "請提供 code 參數" }, 400);
  }

  try {
    var result = await env.DB.prepare(`
      SELECT
        ast.stock_code, ast.stock_name, ast.paragraph,
        a.id as article_id, a.title, a.publish_date
      FROM article_stocks ast
      INNER JOIN articles a ON ast.article_id = a.id
      WHERE ast.stock_code = ?
      ORDER BY a.publish_date DESC
    `).bind(code).all();

    return jsonResponse({
      stock_code: code,
      articles: result.results
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/**
 * 用 AI 標記文章中的股票
 * 辨識所有 "股票名(代號)" 格式的股票
 */
async function tagStocksWithAI(content, apiKey) {
  try {
    var resp = await fetch("https://gateway.ai.vercel.app/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash",
        messages: [{
          role: "user",
          content: `你是台灣股票文章標記助手。請從以下文章中找出所有提及的台灣上市櫃公司。

## 辨識規則
1. 明確格式：「公司名(代號)」或「公司名（代號）」，如：台達電(2308)、聯發科(2454)
2. 純公司名稱：即使沒有附帶代號，也要辨識出來並查出正確代號

## 常見台股公司對照表（供參考）
國巨=2327, 台半=5425, 德微=3675, 富鼎=8261, 大中=6435, 尼克森=3317
台積電=2330, 鴻海=2317, 聯發科=2454, 台達電=2308, 廣達=2382
緯創=3231, 和碩=4938, 華碩=2357, 宏碁=2353, 技嘉=2376
金居=8358, 台玻=1802, 建榮=5765, 泰山=1527
華邦電=2344, 旺宏=2337, 南亞科=2408, 力積電=6770
日月光=3711, 矽品=2325, 欣興=3037, 景碩=3189, 南電=8046

## 輸出格式
回傳 JSON 陣列，每個元素包含：
- code: 股票代號（4-6位數字）
- name: 股票名稱
- paragraph: 包含該股票的相關段落摘要

注意：
- 只回傳 JSON 陣列，不要其他文字
- 跳過外國公司（AWS、NVIDIA、Google、Samsung 等）
- 如果沒找到任何台灣股票，回傳空陣列 []

## 文章內容
${content}`
        }],
        max_tokens: 16000
      })
    });

    if (!resp.ok) {
      console.error("AI API error:", resp.status);
      return parseStocksFromContent(content);
    }

    var data = await resp.json();
    var text = data.choices[0].message.content.trim();

    // 清理可能的 markdown code block
    if (text.startsWith("```")) {
      text = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }

    return JSON.parse(text);
  } catch (e) {
    console.error("AI tagging error:", e);
    return parseStocksFromContent(content);
  }
}

/**
 * 測試 AI 標記功能（debug 用）
 */
async function testAITagging(content, apiKey) {
  if (!apiKey) {
    return { error: "VERCEL_AI_KEY 未設定" };
  }

  try {
    var resp = await fetch("https://gateway.ai.vercel.app/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash",
        messages: [{
          role: "user",
          content: `請從以下文字找出台灣股票，回傳 JSON 陣列 [{code, name}]：

常見台股：國巨=2327, 台半=5425, 德微=3675, 富鼎=8261, 大中=6435, 尼克森=3317

文字內容：${content}`
        }],
        max_tokens: 2000
      })
    });

    var status = resp.status;
    var responseText = await resp.text();

    return {
      status: status,
      ok: resp.ok,
      raw_response: responseText,
      parsed: null
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Fallback: 用 regex 解析股票
 */
function parseStocksFromContent(content) {
  var stocks = [];
  var seen = {};

  // 匹配 "股票名(代號)" 或 "股票名（代號）" 格式
  var regex = /([^\s\d\(\)（）]{2,10})[（\(](\d{4,6})[）\)]/g;
  var match;

  while ((match = regex.exec(content)) !== null) {
    var name = match[1];
    var code = match[2];

    if (!seen[code]) {
      seen[code] = true;

      // 找出包含該股票的段落
      var para = extractParagraph(content, match.index);

      stocks.push({
        code: code,
        name: name,
        paragraph: para
      });
    }
  }

  return stocks;
}

/**
 * 擷取包含指定位置的段落
 */
function extractParagraph(content, position) {
  // 找段落開頭（數字. 開頭或文章開頭）
  var start = content.lastIndexOf("\n", position);
  if (start === -1) start = 0;

  // 往前找到段落編號開頭
  var beforeStart = content.substring(0, start);
  var numMatch = beforeStart.match(/\n(\d+\.\s)/g);
  if (numMatch) {
    var lastNum = beforeStart.lastIndexOf(numMatch[numMatch.length - 1]);
    if (lastNum !== -1 && position - lastNum < 5000) {
      start = lastNum + 1;
    }
  }

  // 找段落結尾（下一個數字. 或文章結尾）
  var afterPos = content.substring(position);
  var endMatch = afterPos.match(/\n\d+\.\s/);
  var end;
  if (endMatch) {
    end = position + endMatch.index;
  } else {
    end = content.length;
  }

  var para = content.substring(start, end).trim();

  // 限制長度
  if (para.length > 3000) {
    para = para.substring(0, 3000) + "...";
  }

  return para;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

function corsResponse(response) {
  var headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  return new Response(response.body, {
    status: response.status,
    headers: headers
  });
}
