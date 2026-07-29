# YT Downloader Pro — Electron

Phiên bản Electron của YT Downloader Pro, được duy trì độc lập với phiên bản
Wails trên nhánh `main`.

## Tính năng

- Tải video, audio, phụ đề, thumbnail và metadata TXT.
- Nhiều tác vụ tải chạy đồng thời với hàng đợi giới hạn.
- Theo dõi tiến độ và hủy riêng từng tác vụ.
- Tải các thành phần bundle hoặc các video được chọn trong playlist.
- Quản lý lịch sử tải xuống và cài đặt ứng dụng.
- Tự tải `yt-dlp` và `ffmpeg` khi chạy lần đầu.
- Hỗ trợ nhiều theme và tiếng Việt/English.

## Yêu cầu phát triển

- Node.js 18 trở lên.
- Kết nối Internet trong lần thiết lập công cụ đầu tiên.

## Cài dependencies và chạy

```powershell
npm install
npm start
```

Chạy kèm DevTools:

```powershell
npm run dev
```

Ở chế độ development, các công cụ media được lưu trong `bin/`. Bản ứng dụng
đã đóng gói lưu chúng trong thư mục dữ liệu người dùng có quyền ghi.

## Build installer

```powershell
npm run dist
```

Electron Builder tạo artefact Windows trong `dist/`.

## Cấu trúc chính

```text
main.js             Electron main process và task manager
preload.js          IPC bridge an toàn cho renderer
setup.js            Thiết lập yt-dlp/ffmpeg
renderer/           HTML, CSS, JavaScript giao diện
package.json        Scripts và cấu hình Electron Builder
```

Phiên bản Wails production nằm trên nhánh `main`.
