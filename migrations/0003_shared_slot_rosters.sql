-- One booking per prospect, one shared Calendar event per canonical hourly slot.
ALTER TABLE customers ADD COLUMN instagram_handle TEXT;
ALTER TABLE booking_operations ADD COLUMN affected_slots TEXT;
ALTER TABLE booking_operations ADD COLUMN lease_token TEXT;
ALTER TABLE booking_operations ADD COLUMN lease_expires_at TEXT;

-- Fail migration rather than silently choosing between existing duplicate bookings.
CREATE UNIQUE INDEX idx_one_active_trial_per_customer
  ON bookings(customer_id) WHERE status IN ('pending', 'confirmed');
CREATE UNIQUE INDEX idx_one_pending_booking_operation_per_customer
  ON booking_operations(customer_id) WHERE status = 'pending';
CREATE INDEX idx_slot_roster ON bookings(calendar_id, starts_at, status);
