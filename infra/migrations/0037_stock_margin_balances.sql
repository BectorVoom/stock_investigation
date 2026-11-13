-- Add outstanding margin buying/selling share counts (信用買残・信用売残).
-- Existing stocks keep all data; unknown balances remain NULL, never zero-filled.
-- Rollback: restore the pre-migration backup; dropping these columns loses balances.
ALTER TABLE stock_directory ADD COLUMN margin_buying_balance INTEGER
    CHECK (margin_buying_balance IS NULL OR (typeof(margin_buying_balance) = 'integer' AND margin_buying_balance >= 0));
ALTER TABLE stock_directory ADD COLUMN margin_selling_balance INTEGER
    CHECK (margin_selling_balance IS NULL OR (typeof(margin_selling_balance) = 'integer' AND margin_selling_balance >= 0));
