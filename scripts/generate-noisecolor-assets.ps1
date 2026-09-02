param()

Add-Type -AssemblyName System.Drawing

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $repositoryRoot "public\noisecolor\icons"
$documentationDirectory = Join-Path $repositoryRoot "docs\assets"
New-Item -ItemType Directory -Force -Path $iconDirectory, $documentationDirectory | Out-Null

function New-RoundedPath([System.Drawing.RectangleF]$rectangle, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  if ($radius -le 0) {
    $path.AddRectangle($rectangle)
    return $path
  }
  $diameter = $radius * 2
  $path.AddArc($rectangle.X, $rectangle.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rectangle.Right - $diameter, $rectangle.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rectangle.Right - $diameter, $rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rectangle.X, $rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-NoiseColorMark([System.Drawing.Graphics]$graphics, [float]$size, [float]$padding) {
  $strokeColors = @(
    [System.Drawing.Color]::FromArgb(190, 198, 255, 92),
    [System.Drawing.Color]::FromArgb(140, 103, 232, 249),
    [System.Drawing.Color]::FromArgb(105, 249, 168, 212)
  )
  for ($line = 0; $line -lt $strokeColors.Count; $line += 1) {
    $points = [System.Collections.Generic.List[System.Drawing.PointF]]::new()
    for ($index = 0; $index -le 96; $index += 1) {
      $x = $padding + (($size - (2 * $padding)) * $index / 96)
      $normalized = $index / 96.0
      $envelope = 0.22 + (0.58 * [Math]::Exp(-[Math]::Pow(($normalized - 0.54) / 0.24, 2)))
      $wave = [Math]::Sin(($normalized * (4.2 + ($line * 0.55)) * [Math]::PI) + ($line * 0.75))
      $y = ($size / 2) + ($wave * $envelope * $size * (0.17 - ($line * 0.018)))
      $points.Add([System.Drawing.PointF]::new($x, $y))
    }
    $pen = [System.Drawing.Pen]::new($strokeColors[$line], [Math]::Max(2, $size * (0.018 - ($line * 0.002))))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLines($pen, $points.ToArray())
    $pen.Dispose()
  }
}

function New-AppIcon([int]$size, [string]$name, [bool]$maskable) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 3, 7, 18))
  $inset = if ($maskable) { 0 } else { [Math]::Round($size * 0.035) }
  $radius = if ($maskable) { 0 } else { [Math]::Round($size * 0.2) }
  $rect = [System.Drawing.RectangleF]::new($inset, $inset, $size - (2 * $inset), $size - (2 * $inset))
  $path = New-RoundedPath $rect $radius
  $background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 7, 13, 24))
  $graphics.FillPath($background, $path)
  $gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(35, 103, 232, 249), [Math]::Max(1, $size / 512))
  for ($index = 1; $index -lt 6; $index += 1) {
    $position = $size * $index / 6
    $graphics.DrawLine($gridPen, $position, $size * 0.18, $position, $size * 0.82)
    $graphics.DrawLine($gridPen, $size * 0.18, $position, $size * 0.82, $position)
  }
  Draw-NoiseColorMark $graphics $size ($size * $(if ($maskable) { 0.22 } else { 0.16 }))
  $gridPen.Dispose()
  $background.Dispose()
  $path.Dispose()
  $graphics.Dispose()
  $bitmap.Save((Join-Path $iconDirectory $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function New-InstallBadge([string]$device, [string]$filename) {
  $width = 560
  $height = 160
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $path = New-RoundedPath ([System.Drawing.RectangleF]::new(2, 2, $width - 4, $height - 4)) 24
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 7, 13, 24)), $path)
  $graphics.DrawPath([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 70, 91, 58), 3), $path)
  $markRect = [System.Drawing.RectangleF]::new(25, 25, 110, 110)
  $markPath = New-RoundedPath $markRect 22
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 12, 24, 33)), $markPath)
  $graphics.SetClip($markRect)
  $graphics.TranslateTransform(25, 25)
  Draw-NoiseColorMark $graphics 110 18
  $graphics.ResetTransform()
  $graphics.ResetClip()
  $smallFont = [System.Drawing.Font]::new("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $largeFont = [System.Drawing.Font]::new("Segoe UI", 42, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $detailFont = [System.Drawing.Font]::new("Segoe UI", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $accentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 198, 255, 92))
  $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 248, 250, 252))
  $mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 139, 152, 170))
  $graphics.DrawString("INSTALL NOISECOLOR ON", $smallFont, $accentBrush, 158, 26)
  $graphics.DrawString($device, $largeFont, $textBrush, 154, 50)
  $graphics.DrawString("Private, installable progressive web app", $detailFont, $mutedBrush, 158, 112)
  foreach ($resource in @($smallFont, $largeFont, $detailFont, $accentBrush, $textBrush, $mutedBrush, $path, $markPath)) { $resource.Dispose() }
  $graphics.Dispose()
  $bitmap.Save((Join-Path $documentationDirectory $filename), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

New-AppIcon 192 "icon-192.png" $false
New-AppIcon 512 "icon-512.png" $false
New-AppIcon 512 "icon-maskable-512.png" $true
New-AppIcon 180 "apple-touch-icon.png" $false
New-InstallBadge "iPhone" "install-noisecolor-iphone.png"
New-InstallBadge "Android" "install-noisecolor-android.png"

Write-Output "Generated NoiseColor app icons and custom install badges."
