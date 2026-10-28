# Smoke cases

What Teire must do on real repositories, written down before each walk so the walk checks against it rather than describing whatever happened.

- `forks/`: one file per fork of a real, unmodified open-source repository (testing organisation `teire-lab`, until it exists `teire-dev`). Each lists the baseline Teire must reproduce, the upgrades Teire should propose, what the bare version bump does to the repo's own checks (it must fail where the code breaks, R-P37), and the pull request or named stop Teire should end with.
- The resolver cases (`dependabot test` inputs with recorded events) join here in S14; the nightly suite runs both in S21.

A result that differs from its file is either a Teire bug or a wrong expectation. Fix the one that is wrong and say which in the commit.
