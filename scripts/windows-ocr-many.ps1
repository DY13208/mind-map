param(
  [string]$ListFile,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [string]$Dir,
  [string]$Pattern = '*.jpg'
)
$ErrorActionPreference = 'Continue'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$log = Join-Path $OutDir '_log.txt'
"start $(Get-Date -Format o)" | Set-Content -Encoding UTF8 $log

# 优先用 -Dir 让 PowerShell 自己枚举（避免把中文路径写进清单文件，
# PS 5.1 读无 BOM 的 UTF-8 清单会踩编码坑）；-ListFile 仅作兜底
if ($Dir) {
  $paths = @(Get-ChildItem -LiteralPath $Dir -Filter $Pattern -File | ForEach-Object { $_.FullName })
} else {
  $paths = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ -and $_.Trim() -ne '' })
}
"paths=$($paths.Count)" | Add-Content -Encoding UTF8 $log

$script = {
  param($img, $out)
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($t, $rt) {
    $m = $asTaskGeneric.MakeGenericMethod($rt)
    $nt = $m.Invoke($null, @($t))
    $nt.Wait(-1) | Out-Null
    $nt.Result
  }
  [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'no OCR engine' }
  $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($img)) ([Windows.Storage.StorageFile])
  $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
}

foreach ($p in $paths) {
  $img = $p.Trim()
  $name = [System.IO.Path]::GetFileNameWithoutExtension($img)
  $out = Join-Path $OutDir ($name + '.txt')
  if ((Test-Path $out) -and ((Get-Content -LiteralPath $out -TotalCount 1) -notlike 'ERROR*')) {
    "skip $name" | Add-Content -Encoding UTF8 $log
    continue
  }
  if (-not (Test-Path $img)) { "missing $img" | Add-Content -Encoding UTF8 $log; continue }
  try {
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'
    $rs.ThreadOptions = 'ReuseThread'
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    $null = $ps.AddScript($script).AddArgument($img).AddArgument($out)
    $res = $ps.Invoke()
    if ($ps.HadErrors) {
      $msg = ($ps.Streams.Error | ForEach-Object { $_.ToString() }) -join ' | '
      "ERROR: $msg" | Set-Content -Encoding UTF8 $out
      "fail $name :: $msg" | Add-Content -Encoding UTF8 $log
    } else {
      ($res -join "`n") | Set-Content -Encoding UTF8 $out
      "ok $name" | Add-Content -Encoding UTF8 $log
    }
    $ps.Dispose(); $rs.Close()
  } catch {
    "ERROR: $($_.Exception.Message)" | Set-Content -Encoding UTF8 $out
    "exc $name :: $($_.Exception.Message)" | Add-Content -Encoding UTF8 $log
  }
}
"done $(Get-Date -Format o)" | Add-Content -Encoding UTF8 $log
