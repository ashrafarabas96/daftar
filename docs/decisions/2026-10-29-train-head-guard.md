# Train head guard (DR-62 item 3)

`npm run check:train-heads -- <branch> [<branch> ...]` compares, for each named
branch, the head in this checkout with the head on `origin` (`git ls-remote`),
on full object names, and fails on any difference.

Run it with the members of a merge train or seal branch before building it, and
again before merging it.

## Why

A train once took a PR at its published head while the commits an owner decision
required sat unpushed locally, on a base that predated `gh pr update-branch`.
Nothing failed. A reviewer found it by reading a recorded decision against the
tree. The check turns that into a failure.

## Behaviour

| Verdict | Meaning | Fails |
| --- | --- | --- |
| `same` | identical full object names | no |
| `local-behind` | local head is an ancestor of origin's | yes |
| `local-ahead` | origin's head is an ancestor of local | yes |
| `diverged` | neither is an ancestor of the other | yes |
| `unknown-origin-object` | origin's head is not in the local object store | yes |
| `absent-on-origin` / `absent-locally` | the branch does not exist there | yes |

Naming no branch fails. A failing `ls-remote` (network, auth) fails the run; it
is never read as "absent". Only `--exit-code` status 2 means absent.

`local-behind` is not the dangerous direction by itself (nothing unpushed), but
a train built on a stale local head does not carry what origin carries, so it
fails too. The verdict names the direction so the fix is obvious.

## Controls

`--self-test` runs ten controls: identical, different, two objects sharing a
seven-character prefix (must not be `same`), each direction, a missing object,
both absent cases, and an abbreviated name (must be rejected). A comparator that
looks at an abbreviation reports everything different, or everything the same;
the prefix control is what makes either mistake fail the self-test.

The same controls run under `tests/guards/train-heads-guard.test.ts`.

## Not covered

The script reads two refs. It does not know which branches belong to a train;
the caller names them. It does not check that a PR's recorded base or required
commits are on the branch, only that this checkout and origin agree.
