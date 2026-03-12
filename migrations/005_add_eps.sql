-- Add EPS forecast columns to article_stocks table
-- 用於記錄股票的財測 EPS

ALTER TABLE article_stocks ADD COLUMN eps_2025 REAL;
ALTER TABLE article_stocks ADD COLUMN eps_2026 REAL;
ALTER TABLE article_stocks ADD COLUMN eps_2027 REAL;
