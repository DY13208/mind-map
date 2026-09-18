#!/bin/sh
OW=/usr/local/lib/node_modules/openwiki
echo "=== onboarding paths ==="
grep -n -E "openWikiOnboarding|onboarding.json|INSTRUCTIONS|openWikiInstructions" "$OW/dist/setup/onboarding.js" | head -40
echo "=== openwiki-home full ==="
cat "$OW/dist/config/openwiki-home.js"
echo "=== isOnboardingComplete ==="
sed -n '80,130p' "$OW/dist/setup/onboarding.js"