$ErrorActionPreference = 'Stop'

$sidecarRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
  (Join-Path $sidecarRoot 'out\Esse-win32-x64\esse.exe'),
  (Join-Path $sidecarRoot 'out\make\squirrel.windows\x64\Esse-Setup.exe')
)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Missing Windows release artifact: $target"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature for ${target}: $($signature.Status)"
  }
  if (-not $signature.SignerCertificate) {
    throw "Missing Authenticode signer certificate for $target"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Missing trusted Authenticode timestamp for $target"
  }

  Write-Output "$target is signed by $($signature.SignerCertificate.Subject)"
}
