-- User-selected date/time and phone availability must survive separate DM turns.
ALTER TABLE conversations ADD COLUMN booking_intake TEXT;
