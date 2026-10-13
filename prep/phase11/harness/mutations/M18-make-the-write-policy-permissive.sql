-- M18 (round 6). THE red proof of the plant defence, and it exists because
-- M15's first stated expectation was WRONG and the measurement said so.
--
-- M15 drops the own-transaction write policy outright. I predicted that the
-- plant (PA6-L2) would then succeed and that case would red. It does not: on a
-- table with ENABLE + FORCE row-level security, dropping the only INSERT
-- policy means NO insert is permitted at all, so the recorder itself can no
-- longer write and every lawful write breaks. That is fail-closed and broken,
-- not a hole, and M15's file now says so.
--
-- To actually reach the planted state the policy must be REPLACED by a
-- permissive one rather than removed. That is this file.
--
-- Expected: PA6-L2 goes red -- the row planted for a future transaction id is
-- accepted where the real policy refuses it by name. Nothing else should
-- change: unanimity means a planted row can only cause a refusal, never a
-- pass, so what the policy protects is AVAILABILITY. M19 then removes the
-- `xmin` filter as well, which is the only arrangement in which a planted row
-- is actually counted.
DROP POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger;
CREATE POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger
  FOR INSERT WITH CHECK (true);
