-- Stock Notes Database Schema
-- 股票週報筆記資料表

-- 個股筆記（每次週報更新一筆）
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_code TEXT NOT NULL,
    status TEXT DEFAULT 'neutral' CHECK(status IN ('positive', 'neutral', 'negative')),
    summary TEXT,
    content TEXT,
    report_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 索引：加速查詢
CREATE INDEX IF NOT EXISTS idx_notes_stock_code ON notes(stock_code);
CREATE INDEX IF NOT EXISTS idx_notes_report_date ON notes(report_date);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);

-- 複合索引：查詢某股票最新筆記
CREATE INDEX IF NOT EXISTS idx_notes_stock_date ON notes(stock_code, report_date DESC);
