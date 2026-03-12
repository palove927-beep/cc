-- Add position column to article_stocks table
-- 用於記錄股票在文章中出現的位置順序

ALTER TABLE article_stocks ADD COLUMN position INTEGER DEFAULT 0;
