$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..'))
$pg = (Select-String -Path .env -Pattern '^KB_PGPASSWORD=').Line
$env:PGPASSWORD = $pg.Substring($pg.IndexOf('=') + 1).Trim().Trim('"').Trim("'")
$env:FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE = '{"e2e-geek-a":["STILL001"]}'
$cases = @(
  @{ name = 'auth';        url = 'https://mcp.open.jackyun.com/mcp/messages'; token = 'bad-token-0000-0000-0000'; expect = 'auth_failed' },
  @{ name = 'unreachable'; url = 'https://127.0.0.1:9/mcp';                   token = 'bad-token-0000-0000-0000'; expect = 'unreachable' },
  @{ name = 'timeout';     url = 'https://10.255.255.1/mcp';                  token = 'bad-token-0000-0000-0000'; expect = 'timeout' }
)
$failed = 0
foreach ($c in $cases) {
  docker rm -f e2e-geek-mcp 2>$null | Out-Null
  docker run -d --name e2e-geek-mcp --network mind-map_default -p 127.0.0.1:18911:18801 `
    -e FILE_KB_ENABLED=true -e PGHOST=postgres -e PGPORT=5432 -e PGDATABASE=mind_map -e PGUSER=kb_app -e PGPASSWORD `
    -e FILE_KB_GEEKCLOUD_ENABLED=true -e "FILE_KB_GEEKCLOUD_MCP_URL=$($c.url)" -e "FILE_KB_GEEKCLOUD_MCP_TOKEN=$($c.token)" `
    -e FILE_KB_GEEKCLOUD_ALLOWED_USERS=e2e-geek-a -e FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE `
    -e FILE_KB_GEEKCLOUD_TIMEOUT_MS=2000 -e FILE_KB_GEEKCLOUD_BREAKER_THRESHOLD=3 mind-map-file-kb-mcp:0.1.0 | Out-Null
  Start-Sleep -Seconds 4
  node services/file-kb/test/live/geekcloud-fault.mjs $c.name $c.expect
  if ($LASTEXITCODE -ne 0) { $failed++ }
}
docker rm -f e2e-geek-mcp 2>$null | Out-Null
Remove-Item Env:PGPASSWORD
"fault scenarios failed: $failed"
