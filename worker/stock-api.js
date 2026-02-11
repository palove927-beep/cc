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

// 股票分割記錄 (用於調整歷史價格)
var STOCK_SPLITS = {
    "0050": [
        { date: 20241023, ratio: 2 }  // 2024/10/23 進行 1:1 分割
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
 * 有分割記錄的股票會自動調整價格
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
