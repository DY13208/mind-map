const { test } = require('@playwright/test')
const cases = require('../../../tests/performance/directory-browser.cjs')
let harness
test.beforeAll(async () => { harness = await cases.createDirectoryHarness() })
test.afterAll(async () => { if (harness) await harness.close() })
test('[R31] bounded FilesPage and team pager', async () => cases.boundedFiles(harness))
test('[R31] SOP team room twenty-one remains selectable', async () => cases.sopLegacyTwentyOne(harness))
test('[R31] SOP team expansion is paginated', async () => cases.sopBounded(harness))
test('[R31] SOP search includes later team pages', async () => cases.sopTeamSearch(harness))
test('[R31] SOP obsolete response cannot replace newer results', async () => cases.sopSearchRace(harness,false))
test('[R31] SOP obsolete transport work is cancelled', async () => cases.sopSearchRace(harness,true))

test('[R31] SOP a revoked known team cannot erase accessible personal results', async () => cases.sopRevokedTeamSearch(harness))
