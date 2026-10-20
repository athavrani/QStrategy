Add-Type -AssemblyName System.Drawing

$projectRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $projectRoot

$iconPath = "$projectRoot\assets\icon.png"
$adaptivePath = "$projectRoot\assets\adaptive-icon.png"
$notificationPath = "$projectRoot\assets\notification-icon.png"

if (-not (Test-Path $iconPath)) {
    Write-Error "Could not find $iconPath"
    exit 1
}

# Densities and sizes for Android mipmaps
$densities = @(
    @{ Name = "mipmap-mdpi";    Size = 108 },
    @{ Name = "mipmap-hdpi";    Size = 162 },
    @{ Name = "mipmap-xhdpi";   Size = 216 },
    @{ Name = "mipmap-xxhdpi";  Size = 324 },
    @{ Name = "mipmap-xxxhdpi"; Size = 432 }
)

function Resize-Image {
    param (
        [System.Drawing.Image]$source,
        [int]$width,
        [int]$height,
        [string]$outputPath
    )
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    $destImage = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($destImage)

    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, $destRect, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel)

    $parentDir = Split-Path -Parent $outputPath
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    $destImage.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $destImage.Dispose()
}

Write-Host "-> Generating Android mipmap icons from assets/..." -ForegroundColor Cyan

# 1. Process launcher icons
$iconImg = [System.Drawing.Image]::FromFile($iconPath)
$adaptiveImg = if (Test-Path $adaptivePath) { [System.Drawing.Image]::FromFile($adaptivePath) } else { $iconImg }

try {
    foreach ($d in $densities) {
        $folder = "$projectRoot\android\app\src\main\res\$($d.Name)"
        $sz = $d.Size

        # ic_launcher_foreground.png
        $outFg = "$folder\ic_launcher_foreground.png"
        Resize-Image -source $adaptiveImg -width $sz -height $sz -outputPath $outFg

        # ic_launcher.png
        $outLauncher = "$folder\ic_launcher.png"
        Resize-Image -source $iconImg -width $sz -height $sz -outputPath $outLauncher

        # ic_launcher_round.png
        $outRound = "$folder\ic_launcher_round.png"
        Resize-Image -source $iconImg -width $sz -height $sz -outputPath $outRound

        Write-Host "  [OK] $($d.Name): ${sz}x${sz} generated." -ForegroundColor Green
    }
} finally {
    $iconImg.Dispose()
    if ($adaptiveImg -ne $iconImg) {
        $adaptiveImg.Dispose()
    }
}

# 2. Process notification icons
if (Test-Path $notificationPath) {
    Write-Host "-> Generating notification icons..." -ForegroundColor Cyan
    $notifImg = [System.Drawing.Image]::FromFile($notificationPath)
    $notifSizes = @(
        @{ Name = "drawable-mdpi";    Size = 24 },
        @{ Name = "drawable-hdpi";    Size = 36 },
        @{ Name = "drawable-xhdpi";   Size = 48 },
        @{ Name = "drawable-xxhdpi";  Size = 72 },
        @{ Name = "drawable-xxxhdpi"; Size = 96 }
    )

    try {
        foreach ($nd in $notifSizes) {
            $nFolder = "$projectRoot\android\app\src\main\res\$($nd.Name)"
            $nSz = $nd.Size
            $outN = "$nFolder\notification_icon.png"
            Resize-Image -source $notifImg -width $nSz -height $nSz -outputPath $outN
            Write-Host "  [OK] $($nd.Name): ${nSz}x${nSz} notification icon generated." -ForegroundColor Green
        }
    } finally {
        $notifImg.Dispose()
    }
}

Write-Host "[OK] All Android icons generated successfully!" -ForegroundColor Green
