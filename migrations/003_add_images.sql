-- Add images column to articles table
-- 用於儲存文章附加圖片的 URL（JSON 陣列格式）

ALTER TABLE articles ADD COLUMN images TEXT;
