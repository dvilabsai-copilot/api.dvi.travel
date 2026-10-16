-- Agent-owned staff accounts must use the Staff role.  Role 4 is the
-- parent Agent role and makes /agents/profile writable for the staff login.
UPDATE dvi_staff_details
SET roleID = 3,
    updatedon = NOW()
WHERE deleted = 0
  AND staff_id > 0
  AND roleID = 4;

UPDATE dvi_users
SET roleID = 3,
    updatedon = NOW()
WHERE deleted = 0
  AND staff_id > 0
  AND roleID = 4;
