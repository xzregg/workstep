#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift run CoreChecks
node --test tests/*.test.mjs
swiftc -frontend -parse WorkStep/*.swift WorkStep/Core/*.swift WorkStepUITests/*.swift
plutil -lint WorkStep/Info.plist WorkStep.xcodeproj/project.pbxproj
