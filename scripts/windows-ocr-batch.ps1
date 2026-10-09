param(
  [Parameter(Mandatory=$true)][string]$ListFile,
  [Parameter(Mandatory=$true)][string]$OutDir
)
$ErrorActionPreference = 'Continue'
$ocr = "D:\liangce\mind-map\scripts\windows-ocr.ps1"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$paths = Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ -and $_.Trim() -ne '' }
$n = 0
foreach ($p in $paths) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($p)
  $out  = Join-Path $OutDir ($name + '.txt')
  if (Test-Path $out) {
    $head = (Get-Content -LiteralPath $out -Encoding UTF8 -TotalCount 1)
    if ($head -and $head -notlike 'ERROR*') { continue }
  }
  # 每张图起一个全新 powershell 进程：同一进程内连续调 WinRT OCR 会失败
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ocr -Image $p -Out $out | Out-Null
  $n++
}
"processed $n"
