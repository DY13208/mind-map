-- Rollback is intentionally guarded. Do not silently erase manager grants or
-- access-request data collected after 011. Export/resolve those values first.
--
-- The up migration infers granted_role for old approved rows from
-- requested_role; the prior schema had no actual-grant column, so that
-- historical distinction cannot be reconstructed after rollback.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM room_members
    WHERE role = 'manager'
       OR direct_role = 'manager'
       OR team_role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 011: room manager grants must be removed or migrated first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM room_access_requests
    WHERE granted_role = 'manager'
       OR request_reason <> ''
       OR decision_reason <> ''
       OR requester_seen_at IS NOT NULL
       OR (status = 'approved' AND granted_role IS DISTINCT FROM requested_role)
       OR (status <> 'approved' AND granted_role IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 011: access-request values would be lost; export or resolve them first';
  END IF;
END $$;

DROP INDEX IF EXISTS room_access_requests_requester_result_idx;
ALTER TABLE room_access_requests
  DROP CONSTRAINT IF EXISTS room_access_requests_granted_role_chk,
  DROP COLUMN IF EXISTS granted_role,
  DROP COLUMN IF EXISTS request_reason,
  DROP COLUMN IF EXISTS decision_reason,
  DROP COLUMN IF EXISTS requester_seen_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'room_members'::regclass
      AND conname = 'room_members_role_chk'
  ) THEN
    ALTER TABLE room_members
      ADD CONSTRAINT room_members_role_chk
      CHECK (role IN ('owner', 'editor', 'viewer'));
  ELSIF (
    SELECT pg_get_constraintdef(oid) LIKE '%manager%'
    FROM pg_constraint
    WHERE conrelid = 'room_members'::regclass
      AND conname = 'room_members_role_chk'
  ) THEN
    ALTER TABLE room_members DROP CONSTRAINT room_members_role_chk;
    ALTER TABLE room_members
      ADD CONSTRAINT room_members_role_chk
      CHECK (role IN ('owner', 'editor', 'viewer'));
  END IF;
END $$;

COMMIT;
