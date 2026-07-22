[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sidecarRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$product = Get-Content -Raw -Encoding UTF8 (Join-Path $sidecarRoot 'product.json') | ConvertFrom-Json
$packagedExe = Join-Path $sidecarRoot ("out\{0}-win32-x64\{1}.exe" -f $product.displayName, $product.executableName)
$nupkg = Get-ChildItem -LiteralPath (Join-Path $sidecarRoot 'out\make\squirrel.windows\x64') -Filter '*.nupkg' |
  Where-Object { $_.Name -notlike '*-delta.nupkg' } |
  Select-Object -First 1
if (-not (Test-Path -LiteralPath $packagedExe)) { throw "Missing packaged app: $packagedExe" }
if ($null -eq $nupkg) { throw 'Missing full Squirrel NUPKG.' }

$nuspecName = tar -tf $nupkg.FullName | Where-Object { $_ -like '*.nuspec' } | Select-Object -First 1
$nuspec = tar -xOf $nupkg.FullName $nuspecName | Out-String
if ($nuspec -notmatch ("<id>{0}</id>" -f [regex]::Escape($product.windowsSquirrelAppId))) { throw 'Squirrel application ID does not match product.json.' }
if ($nuspec -notmatch ("<title>{0}</title>" -f [regex]::Escape($product.displayName))) { throw 'Squirrel product title does not match product.json.' }

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("esse-agent-sidecar-package-smoke-" + [guid]::NewGuid().ToString('N'))
$stdout = Join-Path $smokeRoot 'stdout.log'
$stderr = Join-Path $smokeRoot 'stderr.log'
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$oldSmoke = $env:ESSE_SMOKE_TEST
$oldUserData = $env:ESSE_QA_USER_DATA_PATH
try {
  $env:ESSE_SMOKE_TEST = '1'
  $env:ESSE_QA_USER_DATA_PATH = Join-Path $smokeRoot 'user-data'
  $process = Start-Process -FilePath $packagedExe -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if ($process.ExitCode -ne 0) {
    throw "Packaged Windows app smoke test exited $($process.ExitCode): $(Get-Content -Raw -ErrorAction SilentlyContinue $stderr)"
  }
  $output = Get-Content -Raw -LiteralPath $stdout
  if ($output -notmatch 'ESSE_SMOKE_RESULT=\{"ok":true') { throw "Packaged Windows app did not report a successful renderer smoke test: $output" }
} finally {
  $env:ESSE_SMOKE_TEST = $oldSmoke
  $env:ESSE_QA_USER_DATA_PATH = $oldUserData
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output (ConvertTo-Json @{ status = 'ok'; platform = 'windows'; arch = 'x64'; squirrelId = $product.windowsSquirrelAppId; smoke = 'ok' } -Compress)
