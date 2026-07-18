$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$marketplaceFile = Join-Path $packageRoot '.agents\plugins\marketplace.json'
$pluginBinary = Join-Path $packageRoot 'plugins\esse\bin\esse.exe'

if (-not (Test-Path -LiteralPath $marketplaceFile)) { throw "Missing marketplace manifest: $marketplaceFile" }
if (-not (Test-Path -LiteralPath $pluginBinary)) { throw "This is not the Windows x64 esse package." }
$codex = Get-Command codex -ErrorAction Stop
$marketplace = Get-Content -Raw -Encoding UTF8 -LiteralPath $marketplaceFile | ConvertFrom-Json
$listed = (& $codex.Source plugin marketplace list | Out-String)
if (-not $listed.Contains($packageRoot)) {
  & $codex.Source plugin marketplace add $packageRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not register the local esse marketplace." }
}
& $codex.Source plugin add "esse@$($marketplace.name)"
if ($LASTEXITCODE -ne 0) { throw "Could not install esse." }

Write-Host "esse installed locally." -ForegroundColor Green
Write-Host "Restart the ChatGPT desktop app, start a new chat, and say: 打开 esse"
