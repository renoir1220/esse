[CmdletBinding()]
param(
  [string]$SourcePath,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  $SourcePath = Join-Path $PSScriptRoot '..\..\..\plugins\codex\assets\batchimager-esse-icon.png'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\assets'
}

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function Get-ResizedPngBytes {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size
  )

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $bitmap.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = [System.IO.MemoryStream]::new()
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Write-BigEndianUInt32 {
  param(
    [System.IO.BinaryWriter]$Writer,
    [uint32]$Value
  )

  $Writer.Write([byte](($Value -shr 24) -band 0xff))
  $Writer.Write([byte](($Value -shr 16) -band 0xff))
  $Writer.Write([byte](($Value -shr 8) -band 0xff))
  $Writer.Write([byte]($Value -band 0xff))
}

$source = [System.Drawing.Image]::FromFile($resolvedSource)
try {
  $sizes = @(16, 24, 32, 48, 64, 128, 256, 512, 1024)
  $pngBySize = @{}
  foreach ($size in $sizes) {
    $pngBySize[$size] = [byte[]](Get-ResizedPngBytes -Source $source -Size $size)
  }

  [System.IO.File]::Copy($resolvedSource, (Join-Path $resolvedOutput 'esse.png'), $true)

  $icoSizes = @(16, 24, 32, 48, 64, 128, 256)
  $icoStream = [System.IO.MemoryStream]::new()
  $icoWriter = [System.IO.BinaryWriter]::new($icoStream)
  try {
    $icoWriter.Write([uint16]0)
    $icoWriter.Write([uint16]1)
    $icoWriter.Write([uint16]$icoSizes.Count)

    $offset = 6 + (16 * $icoSizes.Count)
    foreach ($size in $icoSizes) {
      [byte[]]$png = $pngBySize[$size]
      $dimension = if ($size -eq 256) { 0 } else { $size }
      $icoWriter.Write([byte]$dimension)
      $icoWriter.Write([byte]$dimension)
      $icoWriter.Write([byte]0)
      $icoWriter.Write([byte]0)
      $icoWriter.Write([uint16]1)
      $icoWriter.Write([uint16]32)
      $icoWriter.Write([uint32]$png.Length)
      $icoWriter.Write([uint32]$offset)
      $offset += $png.Length
    }
    foreach ($size in $icoSizes) {
      $icoWriter.Write([byte[]]$pngBySize[$size])
    }
    $icoWriter.Flush()
    [System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'esse.ico'), $icoStream.ToArray())
  } finally {
    $icoWriter.Dispose()
    $icoStream.Dispose()
  }

  $icnsTypes = [ordered]@{
    16 = 'icp4'
    32 = 'icp5'
    64 = 'icp6'
    128 = 'ic07'
    256 = 'ic08'
    512 = 'ic09'
    1024 = 'ic10'
  }
  $icnsLength = 8
  foreach ($sizeKey in $icnsTypes.Keys) {
    $icnsLength += 8 + $pngBySize[[int]$sizeKey].Length
  }

  $icnsStream = [System.IO.MemoryStream]::new()
  $icnsWriter = [System.IO.BinaryWriter]::new($icnsStream)
  try {
    $icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
    Write-BigEndianUInt32 -Writer $icnsWriter -Value $icnsLength
    foreach ($entry in $icnsTypes.GetEnumerator()) {
      [byte[]]$png = $pngBySize[[int]$entry.Key]
      $icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes($entry.Value))
      Write-BigEndianUInt32 -Writer $icnsWriter -Value (8 + $png.Length)
      $icnsWriter.Write($png)
    }
    $icnsWriter.Flush()
    [System.IO.File]::WriteAllBytes((Join-Path $resolvedOutput 'esse.icns'), $icnsStream.ToArray())
  } finally {
    $icnsWriter.Dispose()
    $icnsStream.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output "Generated Esse app icons in $resolvedOutput"
