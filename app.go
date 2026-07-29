package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type DownloadTask struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Thumbnail  string  `json:"thumbnail"`
	Channel    string  `json:"channel"`
	Type       string  `json:"type"`
	Format     string  `json:"format"`
	Quality    string  `json:"quality"`
	Status     string  `json:"status"` // "running", "completed", "error", "cancelled"
	Percent    float64 `json:"percent"`
	Speed      string  `json:"speed"`
	ETA        string  `json:"eta"`
	FilePath   string  `json:"filePath"`
	FolderPath string  `json:"folderPath"`
	Date       string  `json:"date"`
}

type App struct {
	ctx           context.Context
	storage       *Storage
	binaryManager *BinaryManager
	activeCmds    map[string]*exec.Cmd
	activeTasks   map[string]*DownloadTask
	taskMu        sync.Mutex
}

type DownloadOptions struct {
	URL        string `json:"url"`
	Type       string `json:"type"`     // "video", "audio", "subtitle", "thumbnail", "metadata", "bundle"
	Quality    string `json:"quality"`  // "best", "1080", "720", "480", "320", "192"
	Format     string `json:"format"`   // "mp4", "mkv", "webm", "mp3", "m4a", "srt", "vtt", "jpg", "png", "txt"
	SubLang    string `json:"subLang"`  // "vi", "en", etc.
	ThumbRes   string `json:"thumbRes"` // "maxresdefault", "hqdefault"
	OutputPath string `json:"outputPath"`
	Title      string `json:"title"`
	Thumbnail  string `json:"thumbnail"`
	Channel    string `json:"channel"`
	BundleOpts struct {
		Video     bool   `json:"video"`
		VideoQual string `json:"videoQual"`
		Audio     bool   `json:"audio"`
		AudioQual string `json:"audioQual"`
		Sub       bool   `json:"sub"`
		Thumb     bool   `json:"thumb"`
		Metadata  bool   `json:"metadata"`
	} `json:"bundleOpts"`
}

func NewApp() *App {
	return &App{
		storage:       NewStorage(),
		binaryManager: NewBinaryManager(),
		activeCmds:    make(map[string]*exec.Cmd),
		activeTasks:   make(map[string]*DownloadTask),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) appContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

// CheckBinaries validates yt-dlp, ffmpeg, and ffprobe before the UI is enabled.
func (a *App) CheckBinaries() BinaryStatus {
	return a.binaryManager.Status(a.appContext())
}

// SetupBinaries downloads missing runtime tools and emits setup-status events
// so the frontend can show progress instead of appearing frozen.
func (a *App) SetupBinaries() (BinaryStatus, error) {
	status, err := a.binaryManager.Ensure(a.appContext(), func(progress BinarySetupStatus) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "setup-status", progress)
		}
	})
	if err != nil {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "setup-status", BinarySetupStatus{
				Step:    "setup",
				Status:  "error",
				Message: fmt.Sprintf("Không thể thiết lập công cụ: %v", err),
				Percent: 0,
				BinDir:  status.BinDir,
			})
		}
		return status, err
	}
	return status, nil
}

// GetVideoInfo fetches video/playlist metadata using yt-dlp --dump-json
func (a *App) GetVideoInfo(url string) (map[string]interface{}, error) {
	if err := a.binaryManager.CheckOrReport(); err != nil {
		return nil, err
	}

	args := a.binaryManager.BuildArgs(
		"--dump-json",
		"--all-subs",
		"--no-warnings",
		"--no-playlist",
		url,
	)

	cmd := exec.Command(a.binaryManager.GetYtdlpPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("không thể lấy thông tin video: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("lỗi đọc JSON thông tin video: %v", err)
	}

	return result, nil
}

// GetPlaylistInfo fetches playlist videos using yt-dlp --flat-playlist --dump-json
func (a *App) GetPlaylistInfo(url string) ([]map[string]interface{}, error) {
	if err := a.binaryManager.CheckOrReport(); err != nil {
		return nil, err
	}

	args := a.binaryManager.BuildArgs(
		"--flat-playlist",
		"--dump-json",
		"--no-warnings",
		url,
	)

	cmd := exec.Command(a.binaryManager.GetYtdlpPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	var items []map[string]interface{}
	decoder := json.NewDecoder(stdout)
	for decoder.More() {
		var item map[string]interface{}
		if err := decoder.Decode(&item); err == nil {
			items = append(items, item)
		}
	}

	cmd.Wait()
	return items, nil
}

// StartDownloadTask starts an asynchronous non-blocking download task
func (a *App) StartDownloadTask(opts DownloadOptions) (*DownloadTask, error) {
	if err := a.binaryManager.CheckOrReport(); err != nil {
		return nil, err
	}

	taskID := fmt.Sprintf("task_%d", time.Now().UnixNano())
	targetFolder := opts.OutputPath
	if targetFolder == "" {
		settings := a.storage.LoadSettings()
		targetFolder = settings.DownloadPath
	}
	os.MkdirAll(targetFolder, 0755)

	taskTitle := opts.Title
	if taskTitle == "" {
		taskTitle = "Video YouTube"
	}

	task := &DownloadTask{
		ID:         taskID,
		Title:      taskTitle,
		Thumbnail:  opts.Thumbnail,
		Channel:    opts.Channel,
		Type:       opts.Type,
		Format:     opts.Format,
		Quality:    opts.Quality,
		Status:     "running",
		Percent:    0,
		Speed:      "-- MB/s",
		ETA:        "ETA: --",
		FolderPath: targetFolder,
		Date:       time.Now().Format("15:04"),
	}

	a.taskMu.Lock()
	a.activeTasks[taskID] = task
	a.taskMu.Unlock()

	// Launch async goroutine for execution
	go a.executeTask(task, opts)

	return task, nil
}

func (a *App) executeTask(task *DownloadTask, opts DownloadOptions) {
	targetFolder := task.FolderPath

	// Handle Instant Metadata Generation
	if opts.Type == "metadata" {
		task.Percent = 50.0
		task.Speed = "Processing"
		a.emitTaskUpdate(task)

		info, err := a.GetVideoInfo(opts.URL)
		if err == nil {
			task.FilePath = a.writeRichMetadataFile(targetFolder, info)
			if task.Title == "Video YouTube" {
				if t, ok := info["title"].(string); ok && t != "" {
					task.Title = t
				}
			}
			if task.Thumbnail == "" {
				if thumb, ok := info["thumbnail"].(string); ok {
					task.Thumbnail = thumb
				}
			}
		}

		task.Percent = 100.0
		task.Status = "completed"
		a.emitTaskUpdate(task)
		a.saveTaskToHistory(task)
		return
	}

	outTemplate := filepath.Join(targetFolder, "%(title)s.%(ext)s")
	args := []string{"--newline"}

	switch opts.Type {
	case "video":
		if opts.Quality != "" && opts.Quality != "best" {
			args = append(args, "-f", fmt.Sprintf("bestvideo[height<=%s]+bestaudio/best[height<=%s]", opts.Quality, opts.Quality))
		} else {
			args = append(args, "-f", "bestvideo+bestaudio/best")
		}
		if opts.Format != "" {
			args = append(args, "--merge-output-format", opts.Format)
		}

	case "audio":
		args = append(args, "-x", "--audio-format", opts.Format)
		if opts.Quality != "" {
			args = append(args, "--audio-quality", opts.Quality)
		}

	case "subtitle":
		args = append(args, "--skip-download", "--write-sub", "--sub-lang", opts.SubLang, "--convert-subs", opts.Format)

	case "thumbnail":
		args = append(args, "--skip-download", "--write-thumbnail", "--convert-thumbnails", opts.Format)

	case "bundle":
		if opts.BundleOpts.Video {
			if opts.BundleOpts.VideoQual != "" && opts.BundleOpts.VideoQual != "best" {
				args = append(args, "-f", fmt.Sprintf("bestvideo[height<=%s]+bestaudio/best[height<=%s]", opts.BundleOpts.VideoQual, opts.BundleOpts.VideoQual))
			}
		}
		if opts.BundleOpts.Audio {
			args = append(args, "-x", "--audio-format", "mp3")
		}
		if opts.BundleOpts.Sub {
			args = append(args, "--write-sub", "--convert-subs", "srt")
		}
		if opts.BundleOpts.Thumb {
			args = append(args, "--write-thumbnail")
		}
	}

	args = append(args, "-o", outTemplate)
	args = a.binaryManager.BuildArgs(args...)
	args = append(args, opts.URL)

	cmd := exec.Command(a.binaryManager.GetYtdlpPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		task.Status = "error"
		a.emitTaskUpdate(task)
		return
	}
	cmd.Stderr = cmd.Stdout

	a.taskMu.Lock()
	a.activeCmds[task.ID] = cmd
	a.taskMu.Unlock()

	if err := cmd.Start(); err != nil {
		task.Status = "error"
		a.emitTaskUpdate(task)
		return
	}

	pctRe := regexp.MustCompile(`(\d+\.?\d*)%`)
	speedRe := regexp.MustCompile(`at\s+([\d.]+\w+/s)`)
	etaRe := regexp.MustCompile(`ETA\s+(\S+)`)

	buf := make([]byte, 4096)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			line := string(buf[:n])
			if m := pctRe.FindStringSubmatch(line); len(m) > 1 {
				var p float64
				fmt.Sscanf(m[1], "%f", &p)
				task.Percent = p
			}
			if m := speedRe.FindStringSubmatch(line); len(m) > 1 {
				task.Speed = m[1]
			}
			if m := etaRe.FindStringSubmatch(line); len(m) > 1 {
				task.ETA = m[1]
			}
			a.emitTaskUpdate(task)
		}
		if err != nil {
			break
		}
	}

	err = cmd.Wait()

	a.taskMu.Lock()
	delete(a.activeCmds, task.ID)
	a.taskMu.Unlock()

	if err != nil {
		if task.Status != "cancelled" {
			task.Status = "error"
		}
		a.emitTaskUpdate(task)
		return
	}

	// Bundle Metadata Generation
	if opts.Type == "bundle" && opts.BundleOpts.Metadata {
		if info, infoErr := a.GetVideoInfo(opts.URL); infoErr == nil {
			a.writeRichMetadataFile(targetFolder, info)
		}
	}

	fileName := fmt.Sprintf("%s.%s", task.Title, task.Format)
	task.FilePath = filepath.Join(targetFolder, fileName)
	task.Percent = 100.0
	task.Status = "completed"
	a.emitTaskUpdate(task)
	a.saveTaskToHistory(task)
}

func (a *App) emitTaskUpdate(task *DownloadTask) {
	runtime.EventsEmit(a.ctx, "task-updated", task)
}

func (a *App) saveTaskToHistory(task *DownloadTask) {
	history := a.storage.LoadHistory()
	item := HistoryItem{
		ID:        task.ID,
		Title:     task.Title,
		Channel:   task.Channel,
		Thumbnail: task.Thumbnail,
		FilePath:  task.FilePath,
		Format:    task.Format,
		Date:      task.Date,
		Duration:  "",
	}
	history = append([]HistoryItem{item}, history...)
	a.storage.SaveHistory(history)
}

// CancelDownloadTask cancels a specific running task
func (a *App) CancelDownloadTask(taskID string) bool {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()

	if cmd, exists := a.activeCmds[taskID]; exists && cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
		delete(a.activeCmds, taskID)
		if task, tExists := a.activeTasks[taskID]; tExists {
			task.Status = "cancelled"
			a.emitTaskUpdate(task)
		}
		return true
	}
	return false
}

// GetActiveTasks returns list of currently tracked tasks
func (a *App) GetActiveTasks() []*DownloadTask {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()

	tasks := make([]*DownloadTask, 0, len(a.activeTasks))
	for _, t := range a.activeTasks {
		tasks = append(tasks, t)
	}
	return tasks
}

func (a *App) writeRichMetadataFile(targetFolder string, info map[string]interface{}) string {
	title, _ := info["title"].(string)
	if title == "" {
		title = "Video Metadata"
	}

	channel, _ := info["channel"].(string)
	if channel == "" {
		channel, _ = info["uploader"].(string)
	}

	channelURL, _ := info["channel_url"].(string)
	if channelURL == "" {
		channelURL, _ = info["uploader_url"].(string)
	}

	webpageURL, _ := info["webpage_url"].(string)
	uploadDate, _ := info["upload_date"].(string)
	if len(uploadDate) == 8 {
		uploadDate = fmt.Sprintf("%s-%s-%s", uploadDate[:4], uploadDate[4:6], uploadDate[6:])
	}

	durationStr, _ := info["duration_string"].(string)
	description, _ := info["description"].(string)

	viewCount := int64(0)
	if v, ok := info["view_count"].(float64); ok {
		viewCount = int64(v)
	}
	likeCount := int64(0)
	if l, ok := info["like_count"].(float64); ok {
		likeCount = int64(l)
	}

	var tagsList []string
	if rawTags, ok := info["tags"].([]interface{}); ok {
		for _, t := range rawTags {
			if ts, ok := t.(string); ok {
				tagsList = append(tagsList, ts)
			}
		}
	}

	hashtagRe := regexp.MustCompile(`#[\w\p{L}]+`)
	hashtags := hashtagRe.FindAllString(description, -1)

	var sb strings.Builder
	sb.WriteString("======================================================================\n")
	sb.WriteString("                      YOUTUBE SEO METADATA REPORT                     \n")
	sb.WriteString("======================================================================\n\n")

	sb.WriteString(fmt.Sprintf("📌 TIÊU ĐỀ (TITLE)     : %s\n", title))
	sb.WriteString(fmt.Sprintf("👤 KÊNH (CHANNEL)      : %s (%s)\n", channel, channelURL))
	sb.WriteString(fmt.Sprintf("📅 NGÀY ĐĂNG           : %s\n", uploadDate))
	sb.WriteString(fmt.Sprintf("🔗 URL VIDEO           : %s\n", webpageURL))
	sb.WriteString(fmt.Sprintf("⏱ THỜI LƯỢNG          : %s\n", durationStr))
	sb.WriteString(fmt.Sprintf("👁 LƯỢT XEM (VIEWS)    : %d\n", viewCount))
	sb.WriteString(fmt.Sprintf("👍 LƯỢT THÍCH (LIKES)  : %d\n\n", likeCount))

	sb.WriteString("----------------------------------------------------------------------\n")
	sb.WriteString("🏷 THẺ TAGS (TAGS):\n")
	if len(tagsList) > 0 {
		sb.WriteString(strings.Join(tagsList, ", "))
		sb.WriteString("\n\n")
	} else {
		sb.WriteString("Không có tags\n\n")
	}

	sb.WriteString("----------------------------------------------------------------------\n")
	sb.WriteString("# HASHTAGS (SEO):\n")
	if len(hashtags) > 0 {
		sb.WriteString(strings.Join(hashtags, " "))
		sb.WriteString("\n\n")
	} else {
		sb.WriteString("Không có hashtags\n\n")
	}

	sb.WriteString("======================================================================\n")
	sb.WriteString("📝 MÔ TẢ VIDEO (DESCRIPTION):\n")
	sb.WriteString("======================================================================\n")
	sb.WriteString(description)
	sb.WriteString("\n\n======================================================================\n")

	cleanRe := regexp.MustCompile(`[\\/:*?"<>|]`)
	cleanTitle := cleanRe.ReplaceAllString(title, "_")
	filePath := filepath.Join(targetFolder, fmt.Sprintf("%s - Metadata.txt", cleanTitle))

	os.WriteFile(filePath, []byte(sb.String()), 0644)
	return filePath
}

// Folder & File Dialogues
func (a *App) SelectFolder() string {
	settings := a.storage.LoadSettings()
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Chọn thư mục lưu file",
		DefaultDirectory: settings.DownloadPath,
	})
	if err == nil && dir != "" {
		settings.DownloadPath = dir
		a.storage.SaveSettings(settings)
		return dir
	}
	return settings.DownloadPath
}

func (a *App) OpenFolder(folderPath string) {
	if folderPath == "" {
		settings := a.storage.LoadSettings()
		folderPath = settings.DownloadPath
	}
	exec.Command("explorer", folderPath).Start()
}

func (a *App) OpenFile(filePath string) {
	exec.Command("cmd", "/c", "start", "", filePath).Start()
}

// Storage IPC Methods
func (a *App) GetHistory() []HistoryItem {
	return a.storage.LoadHistory()
}

func (a *App) SaveHistory(items []HistoryItem) bool {
	return a.storage.SaveHistory(items) == nil
}

func (a *App) ClearHistory() bool {
	return a.storage.SaveHistory([]HistoryItem{}) == nil
}

func (a *App) GetSettings() AppSettings {
	return a.storage.LoadSettings()
}

func (a *App) SaveSettings(settings AppSettings) bool {
	return a.storage.SaveSettings(settings) == nil
}
