ALTER TABLE scheduled_tasks ADD COLUMN output_type TEXT NOT NULL DEFAULT 'chat' CHECK (output_type IN ('news', 'chat'));
