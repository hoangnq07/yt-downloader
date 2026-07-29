# 🎬 YT Downloader Pro

Ứng dụng desktop tải video, audio, phụ đề và thumbnail YouTube nhanh chóng với giao diện hiện đại, sử dụng **yt-dlp** làm engine.

---

## ⚡ Yêu cầu

- **Node.js** v18+ (đã cài sẵn)
- **Kết nối Internet** (lần đầu để tải yt-dlp & ffmpeg tự động)

## 🚀 Cài đặt & Khởi chạy

```bash
cd d:\Code\scripts\yt-downloader-pro

# Cài đặt dependencies (chỉ cần 1 lần)
npm install

# Chạy ứng dụng
npm start
```

> **Lưu ý**: Lần đầu khởi chạy, app sẽ tự động tải `yt-dlp.exe` (~13MB) và `ffmpeg.exe` (~100MB) vào thư mục `bin/`. Chỉ cần thực hiện 1 lần duy nhất.

## 📖 Hướng dẫn sử dụng

1. **Paste link YouTube** vào ô nhập hoặc bấm nút Paste.
2. App tự động hiển thị thông tin video (title, thumbnail, channel, views).
3. **Chọn tab** muốn tải:
   - 🎬 **Video** → chọn chất lượng (4K/1080p/720p...) và format (MP4/MKV/WEBM)
   - 🎵 **Audio** → chọn bitrate (320/192/128kbps) và format (MP3/M4A/OPUS/FLAC)
   - 📝 **Phụ đề** → chọn ngôn ngữ và format (SRT/VTT/ASS)
   - 🖼️ **Thumbnail** → chọn format (JPG/PNG/WEBP)
4. **Chọn thư mục lưu** (mặc định: `~/Downloads/YT-Downloader`)
5. Bấm **Tải xuống** → xem progress realtime → hoàn tất!

## 📂 Cấu trúc project

```
yt-downloader-pro/
├── main.js         # Electron main process
├── preload.js      # IPC bridge
├── setup.js        # Auto-download yt-dlp & ffmpeg
├── package.json
├── bin/            # (auto-created) yt-dlp.exe, ffmpeg.exe
└── renderer/
    ├── index.html  # UI layout
    ├── styles.css  # Dark glassmorphism theme
    └── app.js      # Frontend logic
```
