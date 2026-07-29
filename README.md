# YT Downloader Pro — Wails

Ứng dụng desktop tải video, audio, phụ đề, thumbnail và metadata YouTube.
Phiên bản chính sử dụng Wails v2, Go và Vite.

## Tính năng

- Nhiều tác vụ tải chạy đồng thời, không khóa giao diện.
- Theo dõi tiến độ, tốc độ và ETA theo từng tác vụ.
- Hủy riêng từng tác vụ.
- Tải video, audio, phụ đề, thumbnail hoặc một bundle tùy chọn.
- Xuất báo cáo metadata/SEO dạng TXT.
- Quản lý lịch sử tải xuống và cài đặt ứng dụng.
- Hỗ trợ playlist, nhiều giao diện màu và tiếng Việt/English.

## Yêu cầu phát triển

- Go 1.22 trở lên.
- Node.js 18 trở lên.
- Wails CLI v2.

Khi phát triển, ứng dụng ưu tiên `yt-dlp.exe`, `ffmpeg.exe` và `ffprobe.exe`
trong `bin/` hoặc trên `PATH`. Nếu thiếu, ứng dụng cũng có thể tự thiết lập
giống bản phát hành.

## Thiết lập công cụ lần đầu

Installer không đóng gói các binary media dung lượng lớn. Trong lần chạy đầu,
ứng dụng sẽ:

1. Hiển thị màn hình tiến độ thiết lập.
2. Tự tải và xác thực `yt-dlp`, `ffmpeg` và `ffprobe`.
3. Lưu chúng trong `%LOCALAPPDATA%\YT Downloader Pro\bin`.
4. Dùng lại các file này ở những lần chạy sau.

Quá trình thiết lập cần kết nối Internet. Nếu tải thất bại, ứng dụng hiển thị
lỗi và nút **Thử lại**; file tải dở `.part` được tự động dọn dẹp.

## Chạy ở chế độ development

```powershell
wails dev
```

## Build ứng dụng

```powershell
wails build -platform windows/amd64 -clean
```

Binary được tạo tại `build/bin/yt-downloader-pro.exe`.

## Build installer Windows

Cài NSIS và bảo đảm `makensis.exe` có trên `PATH`, sau đó chạy:

```powershell
wails build -platform windows/amd64 -nsis -clean
```

Installer được tạo tại
`build/bin/YT Downloader Pro-amd64-installer.exe`.

## Tạo lại icon

```powershell
powershell -ExecutionPolicy Bypass -File .\build_icon.ps1
```

Script tạo `build/appicon.png` và ICO đa kích thước tại
`build/windows/icon.ico`.

## Cấu trúc chính

```text
app.go                 Backend và task manager
binaries.go            Tải, xác thực và quản lý yt-dlp/FFmpeg
history.go             Lưu history/settings
main.go                Wails bootstrap
frontend/              Vite frontend
build/                 Icon, manifest và cấu hình installer
wails.json             Cấu hình Wails
```

Phiên bản Electron được duy trì độc lập trên nhánh `electron-version`.
