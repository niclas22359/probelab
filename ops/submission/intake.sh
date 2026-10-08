#!/bin/bash
# ---------------------------------------------------------------------------
# Lab submission intake (docs/SUBMISSION.md, state "checking").
#
#   ops/submission/intake.sh <source repo url> <tag> <name>
#
# Takes a COPY of one tagged commit of the builder's repository into
# beyondles-ai/<name>: creates the repository on the first run (private,
# `develop` default, rulesets mirrored from beyondles-lab, team `developers`
# with push, squash and rebase merge off), pushes the tag as `develop` and
# `main` on the first run, and on later runs merges the new tag into
# `develop` with a merge commit (history kept). CI runs on the push; the
# result decides the next state (red = changes_requested).
#
# Needs: gh (signed in as an org admin), git, read access to the source repo
# (collaborator or public). Never pushes to the source. Never uses --admin.
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${1:?source repo url}"
TAG="${2:?tag}"
NAME="${3:?lab name}"
ORG="beyondles-ai"
TEMPLATE="beyondles-ai/beyondles-lab"

[[ "$NAME" =~ ^[a-z]+lab$ ]] || { echo "name must be lower-case letters ending in 'lab'"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { echo "[intake $(date '+%F %T')] $*"; }

say "clone $SRC at $TAG"
git clone --quiet --branch "$TAG" --depth 1 "$SRC" "$WORK/src"
cd "$WORK/src"
SUBMITTED="$(git rev-parse HEAD)"

say "verify the copy still carries the frame"
test -f CLAUDE.md && test -f scripts/check-frame.mjs && test -f docs/HANDOVER.md || { echo "not a Lab from the template (frame files missing)"; exit 1; }
grep -q "LAB_KEY = \"$NAME\"" src/lib/lab.ts || { echo "src/lib/lab.ts does not declare LAB_KEY = \"$NAME\" — run npm run rename first"; exit 1; }
grep -q '^## Not tested' docs/HANDOVER.md || { echo "docs/HANDOVER.md has no 'Not tested' section"; exit 1; }

if gh repo view "$ORG/$NAME" >/dev/null 2>&1; then
  say "repository exists — merging $TAG into develop"
  git clone --quiet "https://github.com/$ORG/$NAME.git" "$WORK/dst"
  cd "$WORK/dst"
  git checkout --quiet develop
  git remote add src "$WORK/src"
  git fetch --quiet src
  git checkout --quiet -b "submission/$TAG"
  git merge --no-ff --allow-unrelated-histories -m "submission: $TAG ($SUBMITTED) from $SRC" src/HEAD
  git push --quiet origin "submission/$TAG"
  gh pr create --repo "$ORG/$NAME" --base develop --head "submission/$TAG" \
    --title "Submission $TAG" \
    --body "Copy of $SRC at tag $TAG ($SUBMITTED). Review with the frame checklist, start at docs/HANDOVER.md 'Not tested'." >/dev/null
  say "PR opened; CI decides the next state"
  exit 0
fi

say "first submission — creating $ORG/$NAME"
rm -rf .git
git init --quiet -b develop
git add -A
git commit --quiet -m "submission: $TAG ($SUBMITTED) from $SRC"
gh repo create "$ORG/$NAME" --private --source . --remote origin --push \
  --description "Lab submitted from $SRC (tag $TAG)" >/dev/null
git push --quiet origin develop:main
gh repo edit "$ORG/$NAME" --default-branch develop >/dev/null
gh api -X PATCH "repos/$ORG/$NAME" -F allow_squash_merge=false -F allow_rebase_merge=false >/dev/null
gh api -X PUT "orgs/$ORG/teams/developers/repos/$ORG/$NAME" -f permission=push

say "mirroring rulesets from $TEMPLATE"
for id in $(gh api "repos/$TEMPLATE/rulesets" --jq '.[].id'); do
  gh api "repos/$TEMPLATE/rulesets/$id" \
    --jq '{name, target, enforcement, conditions, rules, bypass_actors: (.bypass_actors // [])}' \
    > "$WORK/rs.json"
  gh api -X POST "repos/$ORG/$NAME/rulesets" --input "$WORK/rs.json" --jq '"ruleset: \(.name)"'
done

say "done: https://github.com/$ORG/$NAME — CI running on develop; next: review, then /lab-pipeline phases 4-8"
