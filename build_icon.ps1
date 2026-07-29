Add-Type -AssemblyName System.Drawing

$width = 256
$height = 256

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$g.Clear([System.Drawing.Color]::Transparent)

# YouTube Red Brush
$redBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 0, 51))

# Create smooth rounded rectangle path (YouTube icon squircle shape)
$r = 52 # Corner radius
$rect = New-Object System.Drawing.Rectangle(16, 44, 224, 152)

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$path.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
$path.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
$path.CloseFigure()

$g.FillPath($redBrush, $path)

# Draw centered white play icon triangle
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$p1 = New-Object System.Drawing.Point(102, 88)
$p2 = New-Object System.Drawing.Point(168, 120)
$p3 = New-Object System.Drawing.Point(102, 152)
$pts = [System.Drawing.Point[]]@($p1, $p2, $p3)
$g.FillPolygon($whiteBrush, $pts)

$g.Dispose()
$bmp.Save("renderer/icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Rounded YouTube 256x256 icon saved to renderer/icon.png"
