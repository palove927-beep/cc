-- Articles Database Schema
-- 文章與股票標記資料表

-- 文章主表
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    publish_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文章×股票 標記表（多對多）
CREATE TABLE IF NOT EXISTS article_stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    paragraph TEXT,
    FOREIGN KEY (article_id) REFERENCES articles(id),
    UNIQUE(article_id, stock_code)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_articles_publish_date ON articles(publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_as_stock ON article_stocks(stock_code);
CREATE INDEX IF NOT EXISTS idx_as_article ON article_stocks(article_id);
