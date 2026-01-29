/**
 * TWSE 股票即時報價 - Google Apps Script
 *
 * 使用方式一：自訂函數（直接在儲存格輸入）
 *   =getStockPrice("2330")          → 取得現價
 *   =getStockPrice("2330", "name")  → 取得公司名稱
 *
 * 使用方式二：部署為 Web App API
 *   https://script.google.com/macros/s/xxx/exec?code=2330
 *   https://script.google.com/macros/s/xxx/exec?code=2330&field=name
 *
 * 安裝步驟：
 *   1. 開啟 Google Sheets
 *   2. 選單 → 擴充功能 → Apps Script
 *   3. 貼上此程式碼，儲存
 *   4. 在儲存格輸入 =getStockPrice("2330") 即可使用
 *
 * 部署為 API：
 *   1. Apps Script 編輯器 → 部署 → 新增部署作業
 *   2. 類型選「網頁應用程式」
 *   3. 存取權限設為「所有人」
 *   4. 部署後取得 URL
 */

/**
 * 取得股票現價
 * @param {string} code - 股票代號（如 2330）
 * @param {string} [field] - 回傳欄位：price（預設）、name、full_name
 * @return {number|string} 股價或名稱
 * @customfunction
 */
function getStockPrice(code, field) {
  if (!code) return "請輸入股票代號";

  var cache = CacheService.getScriptCache();
  var cacheKey = "stock_" + code;
  var cached = cache.get(cacheKey);

  var stock;

  if (cached) {
    stock = JSON.parse(cached);
  } else {
    stock = fetchTWSEStock(code);
    if (stock) {
      cache.put(cacheKey, JSON.stringify(stock), 60);
    }
  }

  if (!stock) return "無資料";

  field = (field || "price").toLowerCase();

  switch (field) {
    case "name":
      return stock.n || "無資料";
    case "full_name":
      return stock.nf || "無資料";
    case "price":
    default:
      return getStockCurrentPrice(stock);
  }
}

/**
 * 從 API 回傳資料中取得現價
 * 優先順序：z（成交價）→ b 第一個（最新買價）→ a 第一個（最新賣價）
 */
function getStockCurrentPrice(stock) {
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
  return "無報價";
}

/**
 * 抓取 TWSE 股票資料（含重試機制）
 */
function fetchTWSEStock(code) {
  var options = {
    "method": "get",
    "headers": { "User-Agent": "Mozilla/5.0" },
    "muteHttpExceptions": true
  };

  // 先嘗試上市 (tse)，失敗再嘗試上櫃 (otc)
  var exchanges = ["tse", "otc"];

  for (var e = 0; e < exchanges.length; e++) {
    var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch="
      + exchanges[e] + "_" + code + ".tw";

    for (var i = 0; i < 3; i++) {
      try {
        if (i > 0) Utilities.sleep(1000 * i);

        var response = UrlFetchApp.fetch(url, options);
        if (response.getResponseCode() == 200) {
          var data = JSON.parse(response.getContentText());
          if (data.msgArray && data.msgArray.length > 0) {
            return data.msgArray[0];
          }
        }
      } catch (err) {
        // 重試
      }
    }
  }

  return null;
}

/**
 * Web App API endpoint
 * GET ?code=2330 → {"code":"2330","name":"台積電","price":1810}
 * GET ?code=2330&field=name → {"code":"2330","name":"台積電"}
 */
function doGet(e) {
  var code = e.parameter.code;
  if (!code) {
    return jsonResponse({ error: "請提供 code 參數，例如 ?code=2330" });
  }

  var field = e.parameter.field || "all";
  var cache = CacheService.getScriptCache();
  var cacheKey = "stock_" + code;
  var cached = cache.get(cacheKey);

  var stock;
  if (cached) {
    stock = JSON.parse(cached);
  } else {
    stock = fetchTWSEStock(code);
    if (stock) {
      cache.put(cacheKey, JSON.stringify(stock), 60);
    }
  }

  if (!stock) {
    return jsonResponse({ error: "無資料", code: code });
  }

  var result = { code: code };

  if (field === "all" || field === "name") {
    result.name = stock.n || "";
    result.full_name = stock.nf || "";
  }
  if (field === "all" || field === "price") {
    result.price = getStockCurrentPrice(stock);
  }

  return jsonResponse(result);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
