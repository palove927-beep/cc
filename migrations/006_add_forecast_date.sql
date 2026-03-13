-- Add forecast date column to article_stocks table
-- 記錄財測日期（文章發表日期）

ALTER TABLE article_stocks ADD COLUMN forecast_date DATE;
