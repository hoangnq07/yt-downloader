package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx       context.Context
	ytdlpPath string
	ffmpegDir string
	outputDir string
}

// VideoInfo holds parsed video metadata
type VideoInfo struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Channel        string `json:"channel"`
	Duration       int    `json:"duration"`
	DurationString string `json:"duration_string"`
	ViewCount      int64  `json:"view_count"`
	Thumbnail      string `json:"thumbnail"`
}

// DownloadProgress holds download progress data
type DownloadProgress struct {
	Percent string `json:"percent"`
	Speed   string `json:"speed"`
	ETA     string `json:"eta"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Resolve paths to bundled binaries (../../bin/ from wails-poc dir)
	exePath, _ := os.Executable()
	projectRoot := filepath.Dir(filepath.Dir(filepath.Dir(exePath)))

	// In dev mode, use the project root directly
	devRoot := filepath.Join(".", "..", "..")
	if _, err := os.Stat(filepath.Join(devRoot, "bin", "yt-dlp.exe")); err == nil {
		projectRoot = devRoot
	}

	a.ytdlpPath = filepath.Join(projectRoot, "bin", "yt-dlp.exe")
	a.ffmpegDir = filepath.Join(projectRoot, "bin")
	a.outputDir = filepath.Join(os.Getenv("USERPROFILE"), "Downloads", "YT-Downloader")

	// Fallback: check if yt-dlp is in PATH
	if _, err := os.Stat(a.ytdlpPath); os.IsNotExist(err) {
		if p, err := exec.LookPath("yt-dlp"); err == nil {
			a.ytdlpPath = p
		}
	}

	// Ensure output directory exists
	os.MkdirAll(a.outputDir, 0755)
}

// GetVideoInfo fetches video metadata using yt-dlp --dump-json
func (a *App) GetVideoInfo(url string) (*VideoInfo, error) {
	args := []string{
		"--dump-json",
		"--no-warnings",
		"--no-playlist",
		"--ffmpeg-location", a.ffmpegDir,
		url,
	}

	cmd := exec.Command(a.ytdlpPath, args...)
	cmd.SysProcAttr = hiddenWindowAttr()
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("yt-dlp error: %v", err)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil, fmt.Errorf("JSON parse error: %v", err)
	}

	info := &VideoInfo{
		ID:             getStr(raw, "id"),
		Title:          getStr(raw, "title"),
		Channel:        getStr(raw, "channel"),
		Duration:       getInt(raw, "duration"),
		DurationString: getStr(raw, "duration_string"),
		ViewCount:      getInt64(raw, "view_count"),
		Thumbnail:      getStr(raw, "thumbnail"),
	}

	if info.Channel == "" {
		info.Channel = getStr(raw, "uploader")
	}

	return info, nil
}

// DownloadVideo starts downloading and emits progress events to frontend
func (a *App) DownloadVideo(url string, quality string) error {
	fmtStr := quality
	switch quality {
	case "1080":
		fmtStr = "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
	case "720":
		fmtStr = "bestvideo[height<=720]+bestaudio/best[height<=720]"
	case "480":
		fmtStr = "bestvideo[height<=480]+bestaudio/best[height<=480]"
	case "best":
		fmtStr = "bestvideo+bestaudio/best"
	case "audio":
		fmtStr = "bestaudio/best"
	}

	outTemplate := filepath.Join(a.outputDir, "%(title)s.%(ext)s")
	args := []string{
		"-f", fmtStr,
		"-o", outTemplate,
		"--newline",
		"--ffmpeg-location", a.ffmpegDir,
		url,
	}

	cmd := exec.Command(a.ytdlpPath, args...)
	cmd.SysProcAttr = hiddenWindowAttr()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start yt-dlp: %v", err)
	}

	// Parse progress from stdout
	pctRe := regexp.MustCompile(`(\d+\.?\d*)%`)
	speedRe := regexp.MustCompile(`at\s+([\d.]+\w+/s)`)
	etaRe := regexp.MustCompile(`ETA\s+(\S+)`)

	buf := make([]byte, 4096)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			line := string(buf[:n])
			progress := DownloadProgress{}

			if m := pctRe.FindStringSubmatch(line); len(m) > 1 {
				progress.Percent = m[1]
			}
			if m := speedRe.FindStringSubmatch(line); len(m) > 1 {
				progress.Speed = m[1]
			}
			if m := etaRe.FindStringSubmatch(line); len(m) > 1 {
				progress.ETA = m[1]
			}

			if progress.Percent != "" {
				runtime.EventsEmit(a.ctx, "download-progress", progress)
			}
		}
		if err != nil {
			break
		}
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("download failed: %v", err)
	}

	runtime.EventsEmit(a.ctx, "download-complete", nil)
	return nil
}

// SelectFolder opens a folder selection dialog
func (a *App) SelectFolder() string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Chọn thư mục lưu file",
		DefaultDirectory: a.outputDir,
	})
	if err == nil && dir != "" {
		a.outputDir = dir
	}
	return a.outputDir
}

// GetOutputDir returns current output directory
func (a *App) GetOutputDir() string {
	return a.outputDir
}

// OpenFolder opens the output folder in Explorer
func (a *App) OpenFolder() {
	exec.Command("explorer", a.outputDir).Start()
}

// --- Helpers ---

func getStr(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return 0
}

func getInt64(m map[string]interface{}, key string) int64 {
	if v, ok := m[key].(float64); ok {
		return int64(v)
	}
	return 0
}
