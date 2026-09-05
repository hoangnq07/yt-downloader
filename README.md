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
- Hỗ trợ playlist YouTube và YouTube Music, chọn từng bài để tải, nhiều giao diện màu và tiếng Việt/English.
- YouTube Bridge Extension cho Cốc Cốc/Chrome: gửi video/audio bằng kết nối của trình duyệt sang app, đồng thời tải thumbnail, metadata và phụ đề.

## YouTube Bridge Extension

Nút **Ghép Video** gửi URL và chất lượng đã chọn qua Native Messaging để app dùng
yt-dlp lấy luồng hiện hành, tải hình/tiếng và ghép MP4 bằng FFmpeg. Nút tải trực tiếp,
thumbnail, metadata và phụ đề vẫn dùng kết nối trình duyệt và `youtubei.js` (YouTube.js).

- Video và audio gửi sang app, hỗ trợ chọn giới hạn chất lượng.
- Thumbnail JPG với nhiều mức chất lượng.
- Báo cáo metadata/SEO dạng TXT: tiêu đề, mô tả, tag/keyword, hashtag, chapter và các chỉ số SEO tham khảo.
- Phụ đề chính thức và tự động dạng SRT, VTT hoặc JSON.

1. Mở **Cài đặt > YouTube Bridge Extension** trong ứng dụng và bấm **Chuẩn bị Bridge Extension**. App sẽ chuẩn bị extension và đăng ký Native Messaging host cho Chrome/Cốc Cốc/Edge.
2. Mở `coccoc://extensions` hoặc `chrome://extensions`.
3. Bật chế độ dành cho nhà phát triển, chọn **Tải tiện ích đã giải nén** và chọn thư mục app vừa mở.
4. Mở video YouTube rồi bấm extension **YT Downloader Pro Bridge**.
5. Chọn giới hạn chất lượng và bấm **Ghép Video**. Có thể đóng popup trong lúc app tiếp tục tải.
6. Video hoàn tất được lưu vào thư mục tải đã cài đặt và lịch sử của app.
7. Thumbnail, metadata và phụ đề vẫn có thể tải trực tiếp trong popup extension.

Nếu đã nạp extension cũ, bấm **Tải lại/Reload** tại trang Extensions sau khi app chuẩn bị lại thư mục.

Bridge 3.2.2 dùng yt-dlp hiện hành cho video chất lượng cao thay cho URL iOS
có thể bị YouTube từ chối giữa chừng. Nếu đang dùng bản yt-dlp cũ, chạy cập nhật
công cụ trong app. Chức năng truyền media từ trình duyệt cũng kiểm tra kích thước
qua HEAD/HTTP Range khi metadata không khai báo tổng dung lượng, tránh tải vượt cuối file.
Nút **Ghép Video** dùng kết nối của app và proxy đã đặt trong **Cài đặt**; VPN chỉ
cài trong trình duyệt không tự áp dụng cho tác vụ này.

YouTube.js giúp thay đổi InnerTube client và xử lý URL stream, nhưng không đổi địa chỉ IP. Nếu chính tab trình duyệt
cũng bị YouTube chặn theo quốc gia hoặc IP VPN, người dùng vẫn cần đổi sang máy chủ/IP được YouTube cho phép.

Chỉ tải nội dung bạn sở hữu hoặc được phép tải.

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
