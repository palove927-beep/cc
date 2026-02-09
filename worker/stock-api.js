/**
 * Cloudflare Worker - 股票即時報價 API
 *
 * 資料來源：
 *   - 上市/上櫃：TWSE API (mis.twse.com.tw)
 *   - 興櫃：Fugle API (api.fugle.tw)
 *
 * 環境變數（在 Cloudflare Dashboard 設定）：
 *   - FUGLE_API_KEY: Fugle API 金鑰（興櫃股票用）
 *
 * API 用法：
 *   單支股票：  /api/stock?code=2330
 *   多支股票：  /api/stock?code=2330,2303,6826
 *
 * 回傳格式：
 *   { "data": [{ "code": "2330", "name": "台積電", "price": 1810.00 }], "time": "..." }
 */

// 興櫃股票清單
var EMERGING_STOCKS = ["6826", "7822", "7853"];

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

    return corsResponse(new Response(
      JSON.stringify({ error: "請使用 /api/stock?code=2330" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    ));
  }
};

/**
 * 處理歷史價格查詢
 * 用法：/api/history?code=0050&date=20260102
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

  var year = dateParam.substring(0, 4);
  var month = dateParam.substring(4, 6);
  var day = dateParam.substring(6, 8);
  var targetDate = year + "/" + month + "/" + day;

  // 查詢 TWSE 歷史資料（該月份的每日成交資料）
  var twseUrl = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=" + dateParam + "&stockNo=" + code;

  try {
    var resp = await fetch(twseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!resp.ok) {
      return jsonResponse({ error: "無法取得歷史資料" }, 502);
    }

    var data = await resp.json();

    if (!data || data.stat !== "OK" || !data.data || data.data.length === 0) {
      // 嘗試 OTC (上櫃) API
      var otcUrl = "https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=" +
        (parseInt(year) - 1911) + "/" + month + "&stkno=" + code;

      var otcResp = await fetch(otcUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (otcResp.ok) {
        var otcData = await otcResp.json();
        if (otcData && otcData.aaData && otcData.aaData.length > 0) {
          var rocDate = (parseInt(year) - 1911) + "/" + month + "/" + day;
          for (var i = 0; i < otcData.aaData.length; i++) {
            var row = otcData.aaData[i];
            if (row[0] === rocDate) {
              var closePrice = parseFloat(row[6].replace(/,/g, ""));
              if (!isNaN(closePrice)) {
                return jsonResponse({
                  code: code,
                  date: year + "-" + month + "-" + day,
                  price: closePrice
                });
              }
            }
          }
        }
      }

      return jsonResponse({ error: "找不到該日期的交易資料，可能為假日或無資料" }, 404);
    }

    // 在該月份資料中找到指定日期
    for (var i = 0; i < data.data.length; i++) {
      var row = data.data[i];
      // row[0] 是民國年格式的日期 "114/01/02"
      var parts = row[0].split("/");
      var rowYear = parseInt(parts[0]) + 1911;
      var rowMonth = parts[1];
      var rowDay = parts[2];
      var rowDate = rowYear + "/" + rowMonth + "/" + rowDay;

      if (rowDate === targetDate) {
        // row[6] 是收盤價
        var closePrice = parseFloat(row[6].replace(/,/g, ""));
        if (!isNaN(closePrice)) {
          return jsonResponse({
            code: code,
            date: year + "-" + month + "-" + day,
            price: closePrice
          });
        }
      }
    }

    return jsonResponse({ error: "找不到該日期的交易資料，可能為假日" }, 404);

  } catch (e) {
    return jsonResponse({ error: "查詢歷史資料失敗: " + e.message }, 500);
  }
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
