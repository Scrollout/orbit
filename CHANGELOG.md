# Changelog

## 0.10.0
- Optional pull requests per project: the profile's `Pull requests: yes` makes the coder open a PR after the push, reviewers start on a PR only after CI is green on its head SHA, the operator posts each review summary as a PR comment and uses its id in the review trailer. Default and fallback is the issue-comment flow (`no`); the merge is the verified local `--no-ff` merge in both modes, never the GitHub merge button.
- Profile templates carry the new `Pull requests` field.
