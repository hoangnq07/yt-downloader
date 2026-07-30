param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'browser-extension\icons')
)

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$Rectangle,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-ExtensionIcon {
    param([int]$Size)

    $scale = 4
    $canvasSize = $Size * $scale
    $bitmap = New-Object System.Drawing.Bitmap($canvasSize, $canvasSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $rectangle = New-Object System.Drawing.RectangleF(
        [float]($canvasSize * 0.05),
        [float]($canvasSize * 0.20),
        [float]($canvasSize * 0.90),
        [float]($canvasSize * 0.60)
    )
    $roundedPath = New-RoundedRectanglePath -Rectangle $rectangle -Radius ([float]($canvasSize * 0.14))
    $redBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 0, 0))
    $graphics.FillPath($redBrush, $roundedPath)

    $triangle = New-Object 'System.Drawing.PointF[]' 3
    $triangle[0] = New-Object System.Drawing.PointF([float]($canvasSize * 0.42), [float]($canvasSize * 0.35))
    $triangle[1] = New-Object System.Drawing.PointF([float]($canvasSize * 0.42), [float]($canvasSize * 0.65))
    $triangle[2] = New-Object System.Drawing.PointF([float]($canvasSize * 0.66), [float]($canvasSize * 0.50))
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.FillPolygon($whiteBrush, $triangle)

    $output = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $outputGraphics = [System.Drawing.Graphics]::FromImage($output)
    $outputGraphics.Clear([System.Drawing.Color]::Transparent)
    $outputGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $outputGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $outputGraphics.DrawImage($bitmap, 0, 0, $Size, $Size)

    $target = Join-Path $OutputDirectory ("icon{0}.png" -f $Size)
    $output.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

    $outputGraphics.Dispose()
    $output.Dispose()
    $whiteBrush.Dispose()
    $redBrush.Dispose()
    $roundedPath.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
16, 32, 48, 128 | ForEach-Object { New-ExtensionIcon -Size $_ }
