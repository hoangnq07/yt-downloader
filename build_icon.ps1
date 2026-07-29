$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$rendererIconPath = Join-Path $projectRoot "renderer\icon.png"
$wailsIconPath = Join-Path $projectRoot "build\appicon.png"
$windowsIconPath = Join-Path $projectRoot "build\windows\icon.ico"

function New-AppIconBitmap {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Size
    )

    $bitmap = New-Object System.Drawing.Bitmap(
        $Size,
        $Size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $scale = $Size / 256.0
    $left = 16.0 * $scale
    $top = 44.0 * $scale
    $width = 224.0 * $scale
    $height = 152.0 * $scale
    $radius = 52.0 * $scale
    $right = $left + $width
    $bottom = $top + $height

    $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shape.AddArc($left, $top, $radius, $radius, 180, 90)
    $shape.AddArc($right - $radius, $top, $radius, $radius, 270, 90)
    $shape.AddArc($right - $radius, $bottom - $radius, $radius, $radius, 0, 90)
    $shape.AddArc($left, $bottom - $radius, $radius, $radius, 90, 90)
    $shape.CloseFigure()

    $redBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(255, 255, 0, 51)
    )
    $graphics.FillPath($redBrush, $shape)

    $playButton = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(
            [single](102.0 * $scale),
            [single](88.0 * $scale)
        ),
        [System.Drawing.PointF]::new(
            [single](168.0 * $scale),
            [single](120.0 * $scale)
        ),
        [System.Drawing.PointF]::new(
            [single](102.0 * $scale),
            [single](152.0 * $scale)
        )
    )
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.FillPolygon($whiteBrush, $playButton)

    $whiteBrush.Dispose()
    $redBrush.Dispose()
    $shape.Dispose()
    $graphics.Dispose()

    return $bitmap
}

function Save-PngIcon {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Size,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $bitmap = New-AppIconBitmap -Size $Size
    try {
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
}

function Save-WindowsIcon {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $images = foreach ($size in $sizes) {
        $bitmap = New-AppIconBitmap -Size $size
        $stream = New-Object System.IO.MemoryStream
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            [PSCustomObject]@{
                Size = $size
                Data = $stream.ToArray()
            }
        }
        finally {
            $stream.Dispose()
            $bitmap.Dispose()
        }
    }

    $fileStream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $writer = New-Object System.IO.BinaryWriter($fileStream)

    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$images.Count)

        $offset = 6 + (16 * $images.Count)
        foreach ($image in $images) {
            $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$image.Data.Length)
            $writer.Write([uint32]$offset)
            $offset += $image.Data.Length
        }

        foreach ($image in $images) {
            $writer.Write([byte[]]$image.Data)
        }
    }
    finally {
        $writer.Dispose()
        $fileStream.Dispose()
    }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $rendererIconPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $wailsIconPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $windowsIconPath) -Force | Out-Null

Save-PngIcon -Size 256 -Path $rendererIconPath
Save-PngIcon -Size 1024 -Path $wailsIconPath
Save-WindowsIcon -Path $windowsIconPath

Write-Host "Generated app icons:"
Write-Host "  $rendererIconPath (256x256 PNG)"
Write-Host "  $wailsIconPath (1024x1024 PNG)"
Write-Host "  $windowsIconPath (16-256px ICO)"
