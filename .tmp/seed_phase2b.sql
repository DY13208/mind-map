DELETE FROM room_members WHERE user_id IN ('phase2b-user-a','phase2b-user-b','phase2b-user-c');
INSERT INTO room_members (room_key, user_id, role) VALUES
 ('room-2yaz570x','phase2b-user-a','viewer'),
 ('room-6b5wc9z3','phase2b-user-b','viewer'),
 ('room-2yaz570x','phase2b-user-c','viewer'),
 ('room-6b5wc9z3','phase2b-user-c','viewer')
ON CONFLICT (room_key, user_id) DO UPDATE SET role = EXCLUDED.role;
SELECT user_id, room_key, role FROM room_members WHERE user_id LIKE 'phase2b-user-%' ORDER BY 1,2;
