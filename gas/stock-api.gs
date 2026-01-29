/**
 * TWSE 股票即時報價 - Google Apps Script
 *
 * 使用方式：自訂函數（直接在儲存格輸入）
 *   =getStockPrice("2330")          → 取得現價
 *   =getStockPrice("2330", "name")  → 取得公司名稱
 *
 * 資料來源（依序嘗試）：
 *   1. Cloudflare Worker API（需先部署 worker/stock-api.js）
 *   2. 直接呼叫 TWSE API（備用）
 *
 * 安裝步驟：
 *   1. 開啟 Google Sheets
 *   2. 選單 → 擴充功能 → Apps Script
 *   3. 貼上此程式碼，儲存
 *   4. 將 WORKER_URL 替換為你的 Cloudflare Worker URL
 *   5. 在儲存格輸入 =getStockPrice("2330") 即可使用
 */

// TODO: 部署 Cloudflare Worker 後，將下方 URL 替換為你的 Worker URL
var WORKER_URL = "";

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
    // 優先透過 Cloudflare Worker
    if (WORKER_URL) {
      stock = fetchViaWorker(code);
    }
    // 備用：直接呼叫 TWSE
    if (!stock) {
      stock = fetchTWSEStock(code);
    }
    if (stock) {
      cache.put(cacheKey, JSON.stringify(stock), 60);
    }
  }

  if (!stock) return "無資料";

  field = (field || "price").toLowerCase();

  switch (field) {
    case "name":
      return stock.n || stock.name || "無資料";
    case "full_name":
      return stock.nf || stock.full_name || "無資料";
    case "price":
    default:
      return stock.price || getStockCurrentPrice(stock);
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
 * 透過 Cloudflare Worker 取得股票資料
 */
function fetchViaWorker(code) {
  try {
    var resp = UrlFetchApp.fetch(WORKER_URL + "/api/stock?code=" + code, {
      "muteHttpExceptions": true
    });
    if (resp.getResponseCode() == 200) {
      var result = JSON.parse(resp.getContentText());
      if (result.data && result.data.length > 0) {
        return result.data[0];
      }
    }
  } catch (e) {
    // fallback to direct TWSE
  }
  return null;
}

/**
 * 備用：直接抓取 TWSE 股票資料（含重試機制）
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

