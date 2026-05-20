-- Generated from dry-run of clone/clone-tbo-demo-user.js on 2026-03-21.
-- Idempotent-style insert: no-op if target useremail already exists.

INSERT INTO dvi_users (
  guide_id,
  vendor_id,
  staff_id,
  agent_id,
  usertoken,
  user_profile,
  username,
  useremail,
  password,
  roleID,
  google_auth_code,
  userlogtime,
  userlogkey,
  last_loggedon,
  userapproved,
  userbanned,
  createdby,
  createdon,
  status,
  deleted
)
SELECT
  0,
  0,
  0,
  0,
  '4a3865528d0cf0de6c6da2cc9463d960',
  NULL,
  'tbo_demo',
  'tbo_demo@dvi.travel',
  '$2b$10$X1Y9fDZOWP3kIwpNFec42u/85sqvgbO6ng3sbRxZWz/EftV5.GSDi',
  1,
  NULL,
  NULL,
  NULL,
  NULL,
  1,
  0,
  1,
  '2026-03-21 02:55:16.810',
  1,
  0
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM dvi_users WHERE useremail = 'tbo_demo@dvi.travel'
);
