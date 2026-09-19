#!/bin/sh
# Runs the suite and the whitespace check after the userscript or a test file
# changes, so a red test cannot pass unnoticed. Exit 2 reports the failure back
# to Claude. jq is not installed here, so node reads the hook payload.
set -u

file=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);const p=j.tool_input?.file_path||j.tool_response?.filePath||"";process.stdout.write(p.split(String.fromCharCode(92)).join("/"))}catch{}})')

case "$file" in
    *activity-renamer.user.js|*/test/*) ;;
    *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

if ! output=$(npm test 2>&1); then
    printf 'npm test failed:\n%s\n' "$(printf '%s\n' "$output" | tail -n 40)" >&2
    exit 2
fi

if ! output=$(git diff --check 2>&1); then
    printf 'git diff --check found whitespace errors:\n%s\n' "$output" >&2
    exit 2
fi
