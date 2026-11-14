-- Keep unconfirmed profile names separate from the confirmed customer name.
ALTER TABLE conversations ADD COLUMN instagram_profile TEXT;
