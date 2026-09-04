package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	ID              string  `json:"id"`
	Title           string  `json:"title"`
	Thumbnail       string  `json:"thumbnail"`
	Channel         string  `json:"channel"`
	Type            string  `json:"type"`
	Format          string  `json:"format"`
	Quality         string  `json:"quality"`
	Status          string  `json:"status"` // "running", "completed", "error", "cancelled"
	Percent         float64 `json:"percent"`
	Speed           string  `json:"speed"`
	ETA             string  `json:"eta"`
	FilePath        string  `json:"filePath"`
	FolderPath      string  `json:"folderPath"`
	Date            string  `json:"date"`
	Error           string  `json:"error,omitempty"`
	IsPlaylist      bool    `json:"isPlaylist,omitempty"`
	PlaylistCurrent int     `json:"playlistCurrent,omitempty"`
	PlaylistTotal   int     `json:"playlistTotal,omitempty"`
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
	URL              string `json:"url"`
	Type             string `json:"type"`     // "video", "audio", "subtitle", "thumbnail", "metadata", "bundle"
	Quality          string `json:"quality"`  // "best", "1080", "720", "480", "320", "192"
	Format           string `json:"format"`   // "mp4", "mkv", "webm", "mp3", "m4a", "srt", "vtt", "jpg", "png", "txt"
	SubLang          string `json:"subLang"`  // "vi", "en", etc.
	ThumbRes         string `json:"thumbRes"` // "maxresdefault", "hqdefault"
	OutputPath       string `json:"outputPath"`
	Title            string `json:"title"`
	Thumbnail        string `json:"thumbnail"`
	Channel          string `json:"channel"`
	BrowserCaptureID string `json:"browserCaptureId,omitempty"`
	IsPlaylist       bool   `json:"isPlaylist,omitempty"`
	PlaylistItems    string `json:"playlistItems,omitempty"`
	BundleOpts       struct {
		Video     bool   `json:"video"`
		VideoQual string `json:"videoQual"`
		Audio     bool   `json:"audio"`
		AudioQual string `json:"audioQual"`
		Sub       bool   `json:"sub"`
		Thumb     bool   `json:"thumb"`
		Metadata  bool   `json:"metadata"`
	} `json:"bundleOpts"`
}

const (
	youtubeBotCheckErrorCode = "YOUTUBE_BOT_CHECK"
)

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
	// Refresh the unpacked extension and native-host registration on every app
	// start. This repairs missing registry keys and stale paths left by dev builds
	// or by moving/updating the executable.
	_, _ = a.InstallBrowserBridge()
	cleanupStaleBridgeCaptures()
	go a.watchBridgeAndHistory()
}

func (a *App) watchBridgeAndHistory() {
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()

	var lastHistoryModTime time.Time
	if stat, err := os.Stat(a.storage.historyFile); err == nil {
		lastHistoryModTime = stat.ModTime()
	}

	bridgeTaskPath := activeBridgeTaskPath()
	var lastBridgeTaskID string
	var lastBridgeStatus string
	var lastBridgePercent float64

	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			// 1. Sync history.json modifications with frontend
			if stat, err := os.Stat(a.storage.historyFile); err == nil {
				if stat.ModTime().After(lastHistoryModTime) {
					lastHistoryModTime = stat.ModTime()
					if a.ctx != nil {
						runtime.EventsEmit(a.ctx, "history-updated")
					}
				}
			}

			// 2. Sync active bridge transfer task with frontend queue
			data, err := os.ReadFile(bridgeTaskPath)
			if err == nil && len(data) > 0 {
				var task DownloadTask
				if json.Unmarshal(data, &task) == nil && task.ID != "" {
					if task.ID != lastBridgeTaskID || task.Status != lastBridgeStatus || task.Percent != lastBridgePercent {
						lastBridgeTaskID = task.ID
						lastBridgeStatus = task.Status
						lastBridgePercent = task.Percent
						a.emitTaskUpdate(&task)
					}
					if task.Status == "completed" || task.Status == "error" || task.Status == "cancelled" {
						lastBridgeTaskID = ""
						lastBridgeStatus = ""
						lastBridgePercent = 0
					}
				}
			}
		}
	}
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

// GetVideoInfo fetches video metadata. --ignore-no-formats-error is important
// for newly published/processed or region-restricted videos: yt-dlp can still
// return the useful metadata even when no downloadable formats are available.
func (a *App) GetVideoInfo(url string) (map[string]interface{}, error) {
	if err := a.binaryManager.CheckOrReport(); err != nil {
		return nil, err
	}

	args := a.binaryManager.BuildArgs(
		"--dump-single-json",
		"--skip-download",
		"--ignore-no-formats-error",
		"--no-playlist",
		url,
	)

	commandCtx, cancel := context.WithTimeout(a.appContext(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(commandCtx, a.binaryManager.GetYtdlpPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	output, err := cmd.Output()
	if err != nil {
		return nil, videoInfoCommandError(stderr.String(), err, commandCtx.Err())
	}

	var result map[string]interface{}
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("lỗi đọc JSON thông tin video: %v", err)
	}

	formats, hasFormats := result["formats"].([]interface{})
	downloadable := hasFormats && len(formats) > 0
	result["_app_downloadable"] = downloadable
	if !downloadable {
		result["_app_notice"] = videoInfoNoFormatsNotice(stderr.String())
	}

	return result, nil
}

func videoInfoNoFormatsNotice(stderr string) string {
	lower := strings.ToLower(stderr)
	switch {
	case strings.Contains(lower, "not made this video available in your country"),
		strings.Contains(lower, "geo-restricted"):
		return "Đã lấy được metadata, nhưng video không khả dụng tại quốc gia/khu vực mà app đang kết nối. Hãy đổi máy chủ VPN rồi thử lại."
	case strings.Contains(lower, "video unavailable"):
		return "YouTube trả về “Video unavailable” cho app dù đã lấy được metadata. Hãy kiểm tra đúng URL này có phát hình và tiếng thực sự trong Firefox; nếu có, video hiện không khả dụng với client tải xuống của yt-dlp."
	default:
		return "Đã lấy được metadata, nhưng video chưa có định dạng tải xuống. Video có thể đang được YouTube xử lý hoặc chưa khả dụng với client tải xuống."
	}
}

var ansiRegexp = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func stripAnsi(str string) string {
	return ansiRegexp.ReplaceAllString(str, "")
}

func parseYtdlpError(stderr string) string {
	cleanStderr := stripAnsi(stderr)
	lower := strings.ToLower(cleanStderr)

	switch {
	case strings.Contains(lower, "unable to download api page"),
		strings.Contains(lower, "unable to download webpage"),
		strings.Contains(lower, "unable to download video data"),
		strings.Contains(lower, "unexpected_eof"),
		strings.Contains(lower, "eof occurred in violation of protocol"),
		strings.Contains(lower, "sslerror"),
		strings.Contains(lower, "ssl:"),
		strings.Contains(lower, "tls"),
		strings.Contains(lower, "certificate_verify_failed"),
		strings.Contains(lower, "connection refused"),
		strings.Contains(lower, "connection reset"),
		strings.Contains(lower, "network is unreachable"),
		strings.Contains(lower, "getaddrinfo failed"),
		strings.Contains(lower, "name or service not known"),
		strings.Contains(lower, "winerror"),
		strings.Contains(lower, "timed out"),
		strings.Contains(lower, "timeout"),
		strings.Contains(lower, "connection timed out"),
		strings.Contains(lower, "read timed out"),
		strings.Contains(lower, "remote end closed connection"),
		strings.Contains(lower, "urlerror"):
		return "không thể kết nối tới YouTube (lỗi mạng/SSL hoặc IP bị mạng/quốc gia chặn); hãy bật/đổi máy chủ VPN hoặc kiểm tra đường truyền mạng rồi thử lại"

	case strings.Contains(lower, "not made this video available in your country"),
		strings.Contains(lower, "geo-restricted"):
		return "video không khả dụng tại quốc gia/khu vực hiện tại; hãy dùng mạng hoặc VPN ở khu vực được YouTube cho phép"

	case strings.Contains(lower, "private video"):
		return "đây là video riêng tư"

	case strings.Contains(lower, "sign in to confirm"),
		strings.Contains(lower, "login required"):
		return fmt.Sprintf("%s: YouTube đang chặn yêu cầu tự động; hãy đổi máy chủ VPN hoặc thử lại sau", youtubeBotCheckErrorCode)

	case strings.Contains(lower, "video unavailable"):
		return "video không khả dụng hoặc đã bị gỡ"

	case strings.Contains(lower, "no video formats found"):
		return "video chưa có định dạng tải xuống; có thể vẫn đang được YouTube xử lý"
	}

	lines := strings.Split(strings.ReplaceAll(cleanStderr, "\r\n", "\n"), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line == "" || strings.EqualFold(line, "null") {
			continue
		}
		if errorIndex := strings.Index(line, "ERROR:"); errorIndex >= 0 {
			line = strings.TrimSpace(line[errorIndex+len("ERROR:"):])
		}
		if len(line) > 300 {
			line = line[:300] + "..."
		}
		return line
	}
	return ""
}

func videoInfoCommandError(stderr string, commandErr, contextErr error) error {
	if contextErr != nil {
		return fmt.Errorf("không thể lấy thông tin video: YouTube phản hồi quá lâu, vui lòng thử lại")
	}

	if msg := parseYtdlpError(stderr); msg != "" {
		return fmt.Errorf("không thể lấy thông tin video: %s", msg)
	}

	return fmt.Errorf("không thể lấy thông tin video: %v", commandErr)
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

	commandCtx, cancel := context.WithTimeout(a.appContext(), 2*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(commandCtx, a.binaryManager.GetYtdlpPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if commandCtx.Err() != nil {
			return nil, errors.New("không thể đọc playlist: YouTube phản hồi quá lâu")
		}
		if detail := parseYtdlpError(stderr.String()); detail != "" {
			return nil, fmt.Errorf("không thể đọc playlist: %s", detail)
		}
		return nil, fmt.Errorf("không thể đọc playlist: %w", err)
	}

	var items []map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(output))
	for {
		var item map[string]interface{}
		if err := decoder.Decode(&item); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("lỗi đọc dữ liệu playlist: %w", err)
		}
		items = append(items, item)
	}

	return items, nil
}

var playlistItemsRegexp = regexp.MustCompile(`^[1-9]\d*(?:,[1-9]\d*)*$`)
var invalidPathComponentRegexp = regexp.MustCompile(`[<>:"/\\|?*%\x00-\x1f]`)
var playlistDownloadProgressRegexp = regexp.MustCompile(`(?i)Downloading (?:item|video) (\d+) of (\d+)`)
var outputExtensionRegexp = regexp.MustCompile(`^[a-z0-9]+$`)

func normalizePlaylistItems(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	if value == "" {
		return "", nil
	}
	if len(value) > 100000 || !playlistItemsRegexp.MatchString(value) {
		return "", errors.New("danh sách bài hát đã chọn không hợp lệ")
	}
	return value, nil
}

func playlistItemCount(value string) int {
	if value == "" {
		return 0
	}
	return strings.Count(value, ",") + 1
}

func playlistDownloadArgs(isPlaylist bool, playlistItems string) []string {
	if !isPlaylist {
		return []string{"--no-playlist"}
	}

	// YouTube Music playlists commonly contain unavailable or region-blocked
	// tracks. Continue the batch and let yt-dlp report the overall run as
	// successful when the remaining selected tracks were downloaded.
	args := []string{"--yes-playlist", "--ignore-errors"}
	if playlistItems != "" {
		args = append(args, "--playlist-items", playlistItems)
	}
	return args
}

func playlistOutputExtension(opts DownloadOptions) string {
	switch opts.Type {
	case "audio", "video", "subtitle", "thumbnail":
		return safeOutputExtension(opts.Format)
	}
	return ""
}

func safeOutputExtension(format string) string {
	format = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(format)), ".")
	if format != "" && outputExtensionRegexp.MatchString(format) {
		return "." + format
	}
	return ""
}

func completedPlaylistOutputCount(folder, extension string) int {
	if extension == "" {
		return 0
	}
	entries, err := os.ReadDir(folder)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), extension) {
			continue
		}
		if info, infoErr := entry.Info(); infoErr == nil && info.Size() > 0 {
			count++
		}
	}
	return count
}

func removeCompletedPlaylistPartFiles(folder, finalExtension string) int {
	if finalExtension == "" {
		return 0
	}
	entries, err := os.ReadDir(folder)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(name), ".part") {
			continue
		}
		sourceName := strings.TrimSuffix(name, filepath.Ext(name))
		stem := strings.TrimSuffix(sourceName, filepath.Ext(sourceName))
		finalPath := filepath.Join(folder, stem+finalExtension)
		if info, statErr := os.Stat(finalPath); statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			continue
		}
		if os.Remove(filepath.Join(folder, name)) == nil {
			removed++
		}
	}
	return removed
}

func reconcilePlaylistTaskAfterCommandError(task *DownloadTask, opts DownloadOptions) {
	if !task.IsPlaylist || task.PlaylistTotal <= 0 {
		return
	}
	extension := playlistOutputExtension(opts)
	completed := completedPlaylistOutputCount(task.FolderPath, extension)
	if completed > task.PlaylistTotal {
		completed = task.PlaylistTotal
	}
	task.PlaylistCurrent = completed
	if completed >= task.PlaylistTotal {
		removeCompletedPlaylistPartFiles(task.FolderPath, extension)
		task.Percent = 100
		task.Status = "completed"
		task.Error = ""
	} else if completed > 0 {
		task.Status = "partial"
	}
}

func parsePlaylistDownloadProgress(line string) (current, total int, ok bool) {
	match := playlistDownloadProgressRegexp.FindStringSubmatch(line)
	if len(match) < 3 {
		return 0, 0, false
	}
	if _, err := fmt.Sscanf(match[1], "%d", &current); err != nil {
		return 0, 0, false
	}
	if _, err := fmt.Sscanf(match[2], "%d", &total); err != nil {
		return 0, 0, false
	}
	return current, total, current > 0 && total > 0
}

func safePlaylistFolderName(title string) string {
	name := invalidPathComponentRegexp.ReplaceAllString(strings.TrimSpace(title), "_")
	name = strings.TrimRight(name, ". ")
	if name == "" {
		name = "YouTube Playlist"
	}

	runes := []rune(name)
	if len(runes) > 120 {
		name = strings.TrimRight(string(runes[:120]), ". ")
	}

	baseName := name
	if dot := strings.IndexByte(baseName, '.'); dot >= 0 {
		baseName = baseName[:dot]
	}
	reservedNames := map[string]bool{
		"CON": true, "PRN": true, "AUX": true, "NUL": true,
		"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
		"COM6": true, "COM7": true, "COM8": true, "COM9": true,
		"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
		"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
	}
	if reservedNames[strings.ToUpper(baseName)] {
		name = "_" + name
	}
	return name
}

// StartDownloadTask starts an asynchronous non-blocking download task
func (a *App) StartDownloadTask(opts DownloadOptions) (*DownloadTask, error) {
	if err := a.binaryManager.CheckOrReport(); err != nil {
		return nil, err
	}
	if opts.IsPlaylist {
		playlistItems, err := normalizePlaylistItems(opts.PlaylistItems)
		if err != nil {
			return nil, err
		}
		opts.PlaylistItems = playlistItems
	}

	taskID := fmt.Sprintf("task_%d", time.Now().UnixNano())
	targetFolder := opts.OutputPath
	if targetFolder == "" {
		settings := a.storage.LoadSettings()
		targetFolder = settings.DownloadPath
	}

	taskTitle := opts.Title
	if taskTitle == "" {
		taskTitle = "Video YouTube"
	}
	if opts.IsPlaylist {
		targetFolder = filepath.Join(targetFolder, safePlaylistFolderName(taskTitle))
	}
	if err := os.MkdirAll(targetFolder, 0755); err != nil {
		return nil, fmt.Errorf("không thể tạo thư mục tải xuống: %w", err)
	}

	task := &DownloadTask{
		ID:            taskID,
		Title:         taskTitle,
		Thumbnail:     opts.Thumbnail,
		Channel:       opts.Channel,
		Type:          opts.Type,
		Format:        opts.Format,
		Quality:       opts.Quality,
		Status:        "running",
		Percent:       0,
		Speed:         "-- MB/s",
		ETA:           "ETA: --",
		FolderPath:    targetFolder,
		Date:          time.Now().Format("15:04"),
		IsPlaylist:    opts.IsPlaylist,
		PlaylistTotal: playlistItemCount(opts.PlaylistItems),
	}
	if task.IsPlaylist {
		task.FilePath = targetFolder
		if err := a.saveTaskToHistory(task); err != nil {
			return nil, fmt.Errorf("không thể khởi tạo lịch sử playlist: %w", err)
		}
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
	if opts.BrowserCaptureID != "" {
		a.executeBrowserBridgeTask(task, opts)
		return
	}

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
		if err := a.saveTaskToHistory(task); err != nil {
			task.Error = fmt.Sprintf("đã tải xong nhưng không thể lưu lịch sử: %v", err)
		}
		a.emitTaskUpdate(task)
		return
	}

	outTemplate := filepath.Join(targetFolder, "%(title)s.%(ext)s")
	args := []string{"--newline"}
	args = append(args, playlistDownloadArgs(opts.IsPlaylist, opts.PlaylistItems)...)
	if opts.IsPlaylist {
		outTemplate = filepath.Join(targetFolder, "%(title)s.%(ext)s")
	}

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
		task.Error = err.Error()
		a.persistPlaylistTaskState(task)
		a.emitTaskUpdate(task)
		return
	}
	cmd.Stderr = cmd.Stdout

	a.taskMu.Lock()
	a.activeCmds[task.ID] = cmd
	a.taskMu.Unlock()

	if err := cmd.Start(); err != nil {
		task.Status = "error"
		task.Error = err.Error()
		a.persistPlaylistTaskState(task)
		a.emitTaskUpdate(task)
		return
	}

	pctRe := regexp.MustCompile(`(\d+\.?\d*)%`)
	speedRe := regexp.MustCompile(`at\s+([\d.]+\w+/s)`)
	etaRe := regexp.MustCompile(`ETA\s+(\S+)`)

	var outputLog strings.Builder
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		outputLog.WriteString(line)
		outputLog.WriteByte('\n')
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
		if current, total, ok := parsePlaylistDownloadProgress(line); ok {
			task.PlaylistCurrent = current
			if task.PlaylistTotal == 0 && total > 0 {
				task.PlaylistTotal = total
			}
		}
		a.emitTaskUpdate(task)
	}

	err = cmd.Wait()

	a.taskMu.Lock()
	delete(a.activeCmds, task.ID)
	a.taskMu.Unlock()

	if err != nil {
		if task.Status != "cancelled" {
			task.Status = "error"
			if msg := parseYtdlpError(outputLog.String()); msg != "" {
				task.Error = msg
			} else {
				task.Error = err.Error()
			}
		}
		reconcilePlaylistTaskAfterCommandError(task, opts)
		a.persistPlaylistTaskState(task)
		a.emitTaskUpdate(task)
		return
	}

	// Bundle Metadata Generation
	if opts.Type == "bundle" && opts.BundleOpts.Metadata && !opts.IsPlaylist {
		if info, infoErr := a.GetVideoInfo(opts.URL); infoErr == nil {
			a.writeRichMetadataFile(targetFolder, info)
		}
	}

	if opts.IsPlaylist {
		task.FilePath = targetFolder
	} else {
		fileName := fmt.Sprintf("%s.%s", task.Title, task.Format)
		task.FilePath = filepath.Join(targetFolder, fileName)
	}
	task.Percent = 100.0
	task.Status = "completed"
	if task.IsPlaylist && task.PlaylistTotal > 0 {
		task.PlaylistCurrent = task.PlaylistTotal
	}
	if err := a.saveTaskToHistory(task); err != nil {
		task.Error = fmt.Sprintf("đã tải xong nhưng không thể lưu lịch sử: %v", err)
	}
	a.emitTaskUpdate(task)
}

func (a *App) emitTaskUpdate(task *DownloadTask) {
	runtime.EventsEmit(a.ctx, "task-updated", task)
}

func (a *App) saveTaskToHistory(task *DownloadTask) error {
	item := HistoryItem{
		ID:            task.ID,
		Title:         task.Title,
		Channel:       task.Channel,
		Thumbnail:     task.Thumbnail,
		FilePath:      task.FilePath,
		Format:        task.Format,
		Date:          task.Date,
		Duration:      "",
		IsPlaylist:    task.IsPlaylist,
		PlaylistTotal: task.PlaylistTotal,
		PlaylistDone:  task.PlaylistCurrent,
		Status:        task.Status,
		Error:         task.Error,
	}
	if err := a.storage.UpsertHistory(item); err != nil {
		return err
	}
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "history-updated", item)
	}
	return nil
}

func (a *App) persistPlaylistTaskState(task *DownloadTask) {
	if !task.IsPlaylist {
		return
	}
	if err := a.saveTaskToHistory(task); err != nil {
		if task.Error != "" {
			task.Error += "; "
		}
		task.Error += fmt.Sprintf("không thể cập nhật lịch sử: %v", err)
	}
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
			a.persistPlaylistTaskState(task)
			a.emitTaskUpdate(task)
		}
		return true
	}

	// Support cancelling active browser bridge task from App UI
	bridgeTaskPath := activeBridgeTaskPath()
	if data, err := os.ReadFile(bridgeTaskPath); err == nil && len(data) > 0 {
		var task DownloadTask
		if json.Unmarshal(data, &task) == nil && task.ID == taskID {
			task.Status = "cancelled"
			task.Error = "Đã hủy bởi người dùng trên ứng dụng"
			_ = os.Remove(bridgeTaskPath)
			a.emitTaskUpdate(&task)
			return true
		}
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
	} else if info, err := os.Stat(folderPath); err == nil && !info.IsDir() {
		folderPath = filepath.Dir(folderPath)
	} else if err != nil && filepath.Ext(folderPath) != "" {
		folderPath = filepath.Dir(folderPath)
	}
	exec.Command("explorer", folderPath).Start()
}

func (a *App) OpenFile(filePath string) {
	exec.Command("cmd", "/c", "start", "", filePath).Start()
}

// Storage IPC Methods
func (a *App) GetHistory() []HistoryItem {
	return a.storage.LoadAndReconcileHistory()
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
