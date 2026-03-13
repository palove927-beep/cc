-- Stock Forecasts Table
-- 股票財測記錄（獨立追蹤）

CREATE TABLE IF NOT EXISTS stock_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    forecast_date DATE NOT NULL,
    eps_2025 REAL,
    eps_2026 REAL,
    eps_2027 REAL,
    article_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (article_id) REFERENCES articles(id),
    UNIQUE(stock_code, forecast_date)
);

CREATE INDEX IF NOT EXISTS idx_forecasts_stock ON stock_forecasts(stock_code);
CREATE INDEX IF NOT EXISTS idx_forecasts_date ON stock_forecasts(forecast_date DESC);
