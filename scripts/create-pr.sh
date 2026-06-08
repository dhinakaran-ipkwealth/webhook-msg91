#!/usr/bin/env bash
set -e

BRANCH=refactor/clean-architecture
git checkout -b "$BRANCH"
git add .
git commit -m "refactor: Clean Architecture for webhook & electron; add tests"
echo "Created branch $BRANCH and committed changes."
echo "Push with: git push -u origin $BRANCH"
