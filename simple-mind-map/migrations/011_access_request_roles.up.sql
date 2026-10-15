-- Adds the access-request decision fields used by the current API and permits
-- the manager role in effective room membership rows. The runtime initializer
-- remains idempotent for compatibility, but deployments should apply this
-- versioned migration before starting the updated application.
--
-- For rows approved before this migration, granted_role is inferred from
-- requested_role because the old schema did not record the actual grant. That
-- is a compatibility backfill, not proof of the historical granted role.
BEGIN;

CREATE TABLE IF NOT EXISTS room_access_requests (
  id uuid PRIMARY KEY,
  room_key text NOT NULL REFERENCES rooms(room_key) ON DELETE CASCADE,
  requester_id text NOT NULL,
  requested_role text NOT NULL DEFAULT 'viewer',
  status text NOT NULL DEFAULT 'pending',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_access_requests_role_chk CHECK (requested_role IN ('viewer', 'editor')),
  CONSTRAINT room_access_requests_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);

ALTER TABLE room_access_requests
  ADD COLUMN IF NOT EXISTS granted_role text,
  ADD COLUMN IF NOT EXISTS request_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS decision_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS requester_seen_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'room_access_requests'::regclass
      AND conname = 'room_access_requests_granted_role_chk'
  ) THEN
    ALTER TABLE room_access_requests
      ADD CONSTRAINT room_access_requests_granted_role_chk
      CHECK (granted_role IS NULL OR granted_role IN ('viewer', 'editor', 'manager'));
  ELSIF (
    SELECT pg_get_constraintdef(oid) NOT LIKE '%manager%'
    FROM pg_constraint
    WHERE conrelid = 'room_access_requests'::regclass
      AND conname = 'room_access_requests_granted_role_chk'
  ) THEN
    ALTER TABLE room_access_requests DROP CONSTRAINT room_access_requests_granted_role_chk;
    ALTER TABLE room_access_requests
      ADD CONSTRAINT room_access_requests_granted_role_chk
      CHECK (granted_role IS NULL OR granted_role IN ('viewer', 'editor', 'manager'));
  END IF;
END $$;

UPDATE room_access_requests
SET granted_role = requested_role
WHERE status = 'approved' AND granted_role IS NULL;

CREATE INDEX IF NOT EXISTS room_access_requests_requester_result_idx
  ON room_access_requests(requester_id, decided_at DESC)
  WHERE status <> 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'room_members'::regclass
      AND conname = 'room_members_role_chk'
  ) THEN
    ALTER TABLE room_members
      ADD CONSTRAINT room_members_role_chk
      CHECK (role IN ('owner', 'manager', 'editor', 'viewer'));
  ELSIF (
    SELECT pg_get_constraintdef(oid) NOT LIKE '%manager%'
    FROM pg_constraint
    WHERE conrelid = 'room_members'::regclass
      AND conname = 'room_members_role_chk'
  ) THEN
    ALTER TABLE room_members DROP CONSTRAINT room_members_role_chk;
    ALTER TABLE room_members
      ADD CONSTRAINT room_members_role_chk
      CHECK (role IN ('owner', 'manager', 'editor', 'viewer'));
  END IF;
END $$;

COMMIT;
