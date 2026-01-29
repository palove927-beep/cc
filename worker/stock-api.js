/**
 * Cloudflare Worker - TWSE 股票即時報價 API
 *
 * 部署步驟：
 *   1. 登入 https://dash.cloudflare.com
 *   2. 左側選單 → Workers & Pages → Create
 *   3. 選 "Create Worker" → 貼上此程式碼 → Deploy
 *   4. 部署後取得 URL，例如：https://stock-api.你的帳號.workers.dev
 *
 * API 用法：
 *   單支股票：  /api/stock?code=2330
 *   多支股票：  /api/stock?code=2330,2303,2049
 *
 * 回傳格式：
 *   { "data": [{ "code": "2330", "name": "台積電", "price": 1810.00 }], "time": "..." }
 *
 * CORS：允許所有來源，GitHub Pages 和 Google Sheets 都能直接呼叫
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 處理 CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // 路由
    if (url.pathname === "/api/stock") {
      return corsResponse(await handleStock(url));
    }

    return corsResponse(new Response(
      JSON.stringify({ error: "請使用 /api/stock?code=2330" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    ));
  }
};

async function handleStock(url) {
  var codeParam = url.searchParams.get("code");
  if (!codeParam) {
    return jsonResponse({ error: "請提供 code 參數，例如 ?code=2330" }, 400);
  }

  var codes = codeParam.split(",").map(function(c) { return c.trim(); }).filter(Boolean);
  if (codes.length === 0) {
    return jsonResponse({ error: "股票代號不可為空" }, 400);
  }
  if (codes.length > 20) {
    return jsonResponse({ error: "一次最多查詢 20 支股票" }, 400);
  }

  // 組合查詢字串（預設上市 tse，可用 otc_ 前綴指定上櫃）
  var exCh = codes.map(function(code) {
    if (code.startsWith("otc_")) {
      return "otc_" + code.slice(4) + ".tw";
    }
    return "tse_" + code + ".tw";
  }).join("|");

  var twseUrl = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + exCh;

  var data = null;
  // 重試機制
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(function(r) { setTimeout(r, 1000 * attempt); });
      }
      var resp = await fetch(twseUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (resp.ok) {
        data = await resp.json();
        if (data && data.msgArray && data.msgArray.length > 0) break;
      }
    } catch (e) {
      // 重試
    }
    data = null;
  }

  if (!data || !data.msgArray || data.msgArray.length === 0) {
    return jsonResponse({ error: "無法取得 TWSE 資料，請稍後再試" }, 502);
  }

  var result = data.msgArray.map(function(stock) {
    return {
      code: stock.c,
      name: stock.n || "",
      full_name: stock.nf || "",
      price: getPrice(stock)
    };
  });

  return jsonResponse({
    data: result,
    time: new Date().toISOString()
  });
}

/**
 * 取得現價：z（成交價）→ b 第一個（最新買價）→ a 第一個（最新賣價）
 */
function getPrice(stock) {
  if (stock.z && stock.z !== "-") {
    var val = parseFloat(stock.z);
    if (!isNaN(val) && val > 0) return val;
  }
  if (stock.b && stock.b !== "-") {
    var first = stock.b.split("_")[0];
    var val = parseFloat(first);
    if (!isNaN(val) && val > 0) return val;
  }
  if (stock.a && stock.a !== "-") {
    var first = stock.a.split("_")[0];
    var val = parseFloat(first);
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
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
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    headers: headers
  });
}
