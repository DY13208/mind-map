#!/bin/sh
OW=/usr/local/lib/node_modules/openwiki
grep -n -E "openWikiOnboardingPath|openWikiInstructionsPath|onboarding.json|INSTRUCTIONS" "$OW/dist/config/openwiki-home.js" "$OW/dist/setup/onboarding.js" | head -40
echo '--- normalizeOnboardingConfig fields ---'
sed -n '120,200p' "$OW/dist/setup/onboarding.js"