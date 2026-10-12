-- M10. A mutation that changes nothing, which is finding P2-02 of the fourth
-- independent challenge run as a red proof of the HOOK rather than of a law.
-- Before this round the hook printed this file, applied it, ran every suite,
-- and reported EXIT_* 0 — a mutation run that measured the clean tree. The
-- hook now digests the DDL-visible state before and after and must refuse:
-- the expected outcome of this file is EXIT 4, not a green run.
SELECT 1;
