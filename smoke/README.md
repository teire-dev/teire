# Smoke cases

What Teire must do on real repositories, written down before each walk so the walk checks against it rather than describing whatever happened.
- `forks/`: one file per fork of a real, unmodified open-source repository (testing organisation `teire-lab`, until it exists `teire-dev`). Each lists the baseline Teire must reproduce, the upgrades Teire should propose, what the bare version bump does to the repo's own checks (it must fail where the code breaks, R-P37), and the pull request or named stop Teire should end with.
- `resolver/`: the resolver pilot (2026-10-28), each batch's cases and what the updater returned for every package manager, the negatives, security jobs and the Cargo pre-step. The nightly suite (S21) runs these and the forks.

A result that differs from its file is either a Teire bug or a wrong expectation. Fix the one that is wrong and say which in the commit.
