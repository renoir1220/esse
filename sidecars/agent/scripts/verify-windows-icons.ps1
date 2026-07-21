[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

$sidecarRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceIconPath = Join-Path $sidecarRoot 'assets\esse.ico'
$sourcePngPath = Join-Path $sidecarRoot 'assets\esse.png'
$packagedExe = Join-Path $sidecarRoot 'out\Esse-win32-x64\esse.exe'
$installerExe = Join-Path $sidecarRoot 'out\make\squirrel.windows\x64\Esse-Setup.exe'
$packagedPng = Join-Path $sidecarRoot 'out\Esse-win32-x64\resources\esse.png'

foreach ($path in @($sourceIconPath, $sourcePngPath, $packagedExe, $installerExe, $packagedPng)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing icon verification target: $path" }
}

function Get-IcoPngFrame {
  param([string]$Path, [int]$Size)
  $bytes = [IO.File]::ReadAllBytes($Path)
  $count = [BitConverter]::ToUInt16($bytes, 4)
  for ($index = 0; $index -lt $count; $index++) {
    $entry = 6 + (16 * $index)
    $width = if ($bytes[$entry] -eq 0) { 256 } else { [int]$bytes[$entry] }
    if ($width -ne $Size) { continue }
    $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
    $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
    $frame = [byte[]]::new($length)
    [Array]::Copy($bytes, $offset, $frame, 0, $length)
    return ,$frame
  }
  throw "Esse ICO does not contain a ${Size}px frame."
}

$expected = Get-IcoPngFrame -Path $sourceIconPath -Size 32
$sha = [Security.Cryptography.SHA256]::Create()
foreach ($target in @($packagedExe, $installerExe)) {
  $targetIcon = [Drawing.Icon]::ExtractAssociatedIcon($target)
  if ($null -eq $targetIcon) { throw "No application icon was embedded in $target" }
  $targetBitmap = $targetIcon.ToBitmap()
  $stream = [IO.MemoryStream]::new()
  try {
    $targetBitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $actual = $stream.ToArray()
    $actualHash = [BitConverter]::ToString($sha.ComputeHash($actual)).Replace('-', '')
    $expectedHash = [BitConverter]::ToString($sha.ComputeHash($expected)).Replace('-', '')
    if ($actualHash -ne $expectedHash) {
      throw "Embedded icon does not match the Esse 32px icon frame in $target"
    }
  } finally {
    $stream.Dispose()
    $targetBitmap.Dispose()
    $targetIcon.Dispose()
  }
}
$sha.Dispose()

$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePngPath).Hash
$packagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedPng).Hash
if ($sourceHash -ne $packagedHash) { throw 'Packaged runtime Esse PNG does not match the source icon.' }

Write-Output '{"status":"ok","platform":"windows","appIcon":"Esse","installerIcon":"Esse","runtimeIcon":"Esse"}'
