package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	browserBridgeExtensionID = "kdfpdflgciohgneobfnoffjfandlnhhn"
	browserBridgeHostName    = "com.ytdownloaderpro.browser_bridge"
	browserCaptureTTL        = 15 * time.Minute
	maxNativeMessageSize     = 1024 * 1024
)

//go:embed all:browser-extension
var browserExtensionAssets embed.FS

var safeBridgeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,96}$`)

type BrowserBridgeStream struct {
	URL           string  `json:"url"`
	Itag          int     `json:"itag"`
	MimeType      string  `json:"mimeType"`
	Container     string  `json:"container"`
	HasVideo      bool    `json:"hasVideo"`
	HasAudio      bool    `json:"hasAudio"`
	Height        int     `json:"height"`
	Bitrate       int64   `json:"bitrate"`
	ContentLength int64   `json:"contentLength"`
	Duration      float64 `json:"duration"`
	LocalPath     string  `json:"localPath,omitempty"`
}

type BrowserBridgeCapture struct {
	ID         string                `json:"id"`
	PageURL    string                `json:"pageUrl"`
	VideoID    string                `json:"videoId"`
	Title      string                `json:"title"`
	CapturedAt string                `json:"capturedAt"`
	Streams    []BrowserBridgeStream `json:"streams"`
}

type BrowserBridgeStatus struct {
	Installed     bool   `json:"installed"`
	ExtensionID   string `json:"extensionId"`
	ExtensionPath string `json:"extensionPath"`
	Message       string `json:"message"`
}

type browserBridgeNativeMessage struct {
	Action       string                `json:"action"`
	PageURL      string                `json:"pageUrl"`
	Title        string                `json:"title"`
	CapturedAt   string                `json:"capturedAt"`
	Streams      []BrowserBridgeStream `json:"streams"`
	CaptureID    string                `json:"captureId"`
	StreamIndex  int                   `json:"streamIndex"`
	Data         string                `json:"data"`
	SourcePaths  []string              `json:"sourcePaths"`
	ExportFormat string                `json:"exportFormat"`
	Quality      string                `json:"quality,omitempty"`
}

type browserBridgeNativeResponse struct {
	OK           bool              `json:"ok"`
	Error        string            `json:"error,omitempty"`
	CaptureID    string            `json:"captureId,omitempty"`
	Received     int64             `json:"received,omitempty"`
	FilePath     string            `json:"filePath,omitempty"`
	ResolvedURLs map[string]string `json:"resolvedUrls,omitempty"`
	Status       string            `json:"status,omitempty"`
	Percent      float64           `json:"percent,omitempty"`
	Speed        string            `json:"speed,omitempty"`
	ETA          string            `json:"eta,omitempty"`
}

type browserTransferState struct {
	Capture      BrowserBridgeCapture
	Files        map[int]*os.File
	PartPaths    map[int]string
	Received     map[int]int64
	Finished     map[int]bool
	ExportFormat string
}

type browserNativeHostState struct {
	Transfers map[string]*browserTransferState
}

var (
	globalActiveCmdsMu sync.Mutex
	globalActiveCmds   = make(map[string]*exec.Cmd)
	globalActiveCmdsWg sync.WaitGroup

	globalLastTasksMu sync.RWMutex
	globalLastTasks   = make(map[string]DownloadTask)
)

func browserBridgeRootDir() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = os.Getenv("USERPROFILE")
	}
	return filepath.Join(appData, "yt-downloader-pro", "browser-bridge")
}

var bridgeLogMu sync.Mutex

func bridgeLog(format string, args ...interface{}) {
	bridgeLogMu.Lock()
	defer bridgeLogMu.Unlock()
	rootDir := browserBridgeRootDir()
	_ = os.MkdirAll(rootDir, 0755)
	logPath := filepath.Join(rootDir, "bridge.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05.000"), msg)
	_, _ = f.WriteString(line)
}

func browserExtensionDir() string {
	return filepath.Join(browserBridgeRootDir(), "extension")
}

func browserCaptureDir() string {
	return filepath.Join(browserBridgeRootDir(), "captures")
}

func browserCaptureDataDir() string {
	return filepath.Join(browserCaptureDir(), "data")
}

func browserNativeHostManifestPath() string {
	return filepath.Join(browserBridgeRootDir(), "native-host.json")
}

func (a *App) InstallBrowserBridge() (BrowserBridgeStatus, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return BrowserBridgeStatus{}, fmt.Errorf("không thể xác định đường dẫn ứng dụng: %w", err)
	}
	return a.installBrowserBridge(executablePath, registerBrowserNativeHost)
}

func (a *App) installBrowserBridge(executablePath string, registerNativeHost func(string) error) (BrowserBridgeStatus, error) {
	status := BrowserBridgeStatus{
		ExtensionID:   browserBridgeExtensionID,
		ExtensionPath: browserExtensionDir(),
	}

	if err := os.MkdirAll(status.ExtensionPath, 0755); err != nil {
		return status, fmt.Errorf("không thể tạo thư mục extension: %w", err)
	}

	err := fs.WalkDir(browserExtensionAssets, "browser-extension", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, readErr := browserExtensionAssets.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		relativePath := strings.TrimPrefix(path, "browser-extension/")
		target := filepath.Join(status.ExtensionPath, filepath.FromSlash(relativePath))
		return writeFileAtomic(target, data, 0644)
	})
	if err != nil {
		return status, fmt.Errorf("không thể chuẩn bị extension: %w", err)
	}

	executablePath, err = filepath.Abs(executablePath)
	if err != nil {
		return status, fmt.Errorf("đường dẫn ứng dụng không hợp lệ: %w", err)
	}
	nativeManifest := struct {
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}{
		Name:           browserBridgeHostName,
		Description:    "YT Downloader Pro Browser Bridge",
		Path:           executablePath,
		Type:           "stdio",
		AllowedOrigins: []string{"chrome-extension://" + browserBridgeExtensionID + "/"},
	}
	manifestData, err := json.MarshalIndent(nativeManifest, "", "  ")
	if err != nil {
		return status, fmt.Errorf("không thể tạo native host manifest: %w", err)
	}
	manifestPath := browserNativeHostManifestPath()
	if err := writeFileAtomic(manifestPath, manifestData, 0600); err != nil {
		return status, fmt.Errorf("không thể lưu native host manifest: %w", err)
	}
	if err := registerNativeHost(manifestPath); err != nil {
		_ = os.Remove(manifestPath)
		return status, fmt.Errorf("không thể đăng ký Browser Bridge: %w", err)
	}

	status.Installed = true
	status.Message = "Extension và Browser Bridge tải media đã sẵn sàng."
	return status, nil
}

func (a *App) GetBrowserBridgeStatus() BrowserBridgeStatus {
	status := BrowserBridgeStatus{
		ExtensionID:   browserBridgeExtensionID,
		ExtensionPath: browserExtensionDir(),
	}
	_, extensionErr := os.Stat(filepath.Join(status.ExtensionPath, "manifest.json"))
	_, nativeHostErr := os.Stat(browserNativeHostManifestPath())
	status.Installed = extensionErr == nil && nativeHostErr == nil
	if status.Installed {
		status.Message = "YouTube Extension và Browser Bridge đã được chuẩn bị trên máy."
	} else {
		status.Message = "YouTube Extension hoặc Browser Bridge chưa được chuẩn bị."
	}
	return status
}

func (a *App) OpenBrowserBridgeFolder() error {
	extensionPath := browserExtensionDir()
	info, err := os.Stat(extensionPath)
	if err != nil || !info.IsDir() {
		return errors.New("extension chưa được chuẩn bị")
	}
	return openBrowserBridgeDirectory(extensionPath)
}

func (a *App) TestBrowserBridgeProxy(rawProxyURL string) (string, error) {
	proxyURL, err := normalizeBrowserProxyURL(rawProxyURL)
	if err != nil {
		return "", err
	}
	if proxyURL == "" {
		return "", errors.New("hãy nhập proxy HTTP trước khi kiểm tra")
	}
	parsedProxy, err := url.Parse(proxyURL)
	if err != nil {
		return "", err
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyURL(parsedProxy),
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 12 * time.Second}
	request, err := http.NewRequestWithContext(a.appContext(), http.MethodGet, "https://www.youtube.com/generate_204", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", browserBridgeUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("không thể kết nối YouTube qua proxy: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 {
		return "", fmt.Errorf("proxy trả về HTTP %d", response.StatusCode)
	}
	return fmt.Sprintf("Kết nối proxy thành công (YouTube HTTP %d)", response.StatusCode), nil
}

func normalizeBrowserProxyURL(rawProxyURL string) (string, error) {
	value := strings.TrimSpace(rawProxyURL)
	if value == "" {
		return "", nil
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return "", errors.New("proxy không hợp lệ; ví dụ: http://127.0.0.1:7890")
	}
	if strings.ToLower(parsed.Scheme) != "http" {
		return "", errors.New("Browser Bridge hiện chỉ hỗ trợ proxy HTTP có CONNECT")
	}
	if parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("proxy không được chứa path, query hoặc fragment")
	}
	parsed.Path = ""
	return parsed.String(), nil
}

func (a *App) GetBrowserBridgeCapture(pageURL string) (BrowserBridgeCapture, error) {
	videoID := youtubeVideoID(pageURL)
	if videoID == "" {
		return BrowserBridgeCapture{}, errors.New("URL YouTube không hợp lệ")
	}

	entries, err := os.ReadDir(browserCaptureDir())
	if err != nil {
		if os.IsNotExist(err) {
			return BrowserBridgeCapture{}, errors.New("chưa nhận được media từ extension")
		}
		return BrowserBridgeCapture{}, err
	}

	var captures []BrowserBridgeCapture
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		capture, loadErr := loadBrowserCaptureFile(filepath.Join(browserCaptureDir(), entry.Name()))
		if loadErr == nil && capture.VideoID == videoID {
			captures = append(captures, capture)
		}
	}
	if len(captures) == 0 {
		return BrowserBridgeCapture{}, errors.New("chưa có media cho video này; hãy mở extension, chọn chất lượng và bấm Gửi sang app")
	}

	sort.Slice(captures, func(i, j int) bool { return browserCaptureTime(captures[i]).After(browserCaptureTime(captures[j])) })
	capture := captures[0]
	if time.Since(browserCaptureTime(capture)) > browserCaptureTTL {
		return BrowserBridgeCapture{}, errors.New("media đã hết hạn; hãy gửi lại từ extension")
	}
	if !captureHasUsableMedia(capture) {
		return BrowserBridgeCapture{}, errors.New("extension chưa gửi đủ video/audio; hãy gửi lại từ tab YouTube")
	}
	if err := validateLocalCaptureFiles(capture); err != nil {
		return BrowserBridgeCapture{}, err
	}
	return capture, nil
}

func loadBrowserCaptureByID(captureID string) (BrowserBridgeCapture, error) {
	if !safeBridgeIDPattern.MatchString(captureID) {
		return BrowserBridgeCapture{}, errors.New("mã capture không hợp lệ")
	}
	capture, err := loadBrowserCaptureFile(filepath.Join(browserCaptureDir(), captureID+".json"))
	if err != nil {
		return BrowserBridgeCapture{}, errors.New("không tìm thấy capture từ trình duyệt")
	}
	if time.Since(browserCaptureTime(capture)) > browserCaptureTTL {
		return BrowserBridgeCapture{}, errors.New("link media từ trình duyệt đã hết hạn; hãy gửi lại")
	}
	if err := validateLocalCaptureFiles(capture); err != nil {
		return BrowserBridgeCapture{}, err
	}
	return capture, nil
}

func loadBrowserCaptureFile(path string) (BrowserBridgeCapture, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return BrowserBridgeCapture{}, err
	}
	var capture BrowserBridgeCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		return BrowserBridgeCapture{}, err
	}
	return capture, nil
}

func captureHasUsableMedia(capture BrowserBridgeCapture) bool {
	hasVideo := false
	hasAudio := false
	for _, stream := range capture.Streams {
		hasVideo = hasVideo || stream.HasVideo
		hasAudio = hasAudio || stream.HasAudio
	}
	return hasVideo || hasAudio
}

func validateLocalCaptureFiles(capture BrowserBridgeCapture) error {
	dataRoot, err := filepath.Abs(browserCaptureDataDir())
	if err != nil {
		return err
	}
	for _, stream := range capture.Streams {
		if stream.LocalPath == "" {
			continue
		}
		absolutePath, pathErr := filepath.Abs(stream.LocalPath)
		if pathErr != nil {
			return pathErr
		}
		relativePath, pathErr := filepath.Rel(dataRoot, absolutePath)
		if pathErr != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
			return errors.New("đường dẫn media cục bộ không hợp lệ")
		}
		info, statErr := os.Stat(absolutePath)
		if statErr != nil || !info.Mode().IsRegular() {
			return errors.New("file media từ trình duyệt không còn tồn tại; hãy gửi lại")
		}
	}
	return nil
}

func isBrowserNativeHostInvocation(args []string) bool {
	expected := "chrome-extension://" + browserBridgeExtensionID
	for _, arg := range args {
		if strings.TrimSuffix(arg, "/") == expected {
			return true
		}
	}
	return false
}

func runBrowserBridgeNativeHost(input io.Reader, output io.Writer) error {
	bridgeLog("runBrowserBridgeNativeHost: bắt đầu phiên Native Messaging Host")
	reader := bufio.NewReader(input)
	state := &browserNativeHostState{
		Transfers: make(map[string]*browserTransferState),
	}
	defer func() {
		bridgeLog("runBrowserBridgeNativeHost: kết thúc phiên Native Messaging Host")
		state.closeAllTransfers()
	}()
	for {
		var messageSize uint32
		if err := binary.Read(reader, binary.LittleEndian, &messageSize); err != nil {
			if errors.Is(err, io.EOF) {
				bridgeLog("runBrowserBridgeNativeHost: nhận EOF từ browser stdin")
				bridgeLog("runBrowserBridgeNativeHost: chờ tác vụ tải ngầm nếu có...")
				globalActiveCmdsWg.Wait()
				bridgeLog("runBrowserBridgeNativeHost: không còn tác vụ tải ngầm")
				return nil
			}
			bridgeLog("runBrowserBridgeNativeHost: lỗi đọc message size: %v", err)
			return err
		}
		if messageSize == 0 || messageSize > maxNativeMessageSize {
			bridgeLog("runBrowserBridgeNativeHost: message size không hợp lệ: %d", messageSize)
			return fmt.Errorf("native message size không hợp lệ: %d", messageSize)
		}

		messageData := make([]byte, messageSize)
		if _, err := io.ReadFull(reader, messageData); err != nil {
			bridgeLog("runBrowserBridgeNativeHost: lỗi đọc message body: %v", err)
			return err
		}

		response := state.handleMessage(messageData)
		if err := writeBrowserNativeResponse(output, response); err != nil {
			bridgeLog("runBrowserBridgeNativeHost: lỗi ghi response: %v", err)
			return err
		}
	}
}

func (state *browserNativeHostState) handleMessage(data []byte) browserBridgeNativeResponse {
	var message browserBridgeNativeMessage
	if err := json.Unmarshal(data, &message); err != nil {
		bridgeLog("handleMessage: json không hợp lệ: %s", string(data))
		return browserBridgeNativeResponse{Error: "dữ liệu extension không hợp lệ"}
	}

	if message.Action != "transfer-chunk" {
		bridgeLog("handleMessage: action=%s, captureID=%s, exportFormat=%s", message.Action, message.CaptureID, message.ExportFormat)
	}

	var response browserBridgeNativeResponse
	switch message.Action {
	case "ping":
		response = browserBridgeNativeResponse{OK: true}
	case "start-native-download":
		response = state.startNativeDownload(message)
	case "get-task-status":
		response = state.getTaskStatus(message)
	case "capture":
		response = handleLegacyBrowserCapture(message)
	case "transfer-start":
		response = state.startTransfer(message)
	case "transfer-chunk":
		response = state.writeTransferChunk(message)
	case "transfer-stream-end":
		response = state.finishTransferStream(message)
	case "transfer-finish":
		response = state.finishTransfer(message)
	case "transfer-abort":
		bridgeLog("transfer-abort: captureID=%s, lý do: %s", message.CaptureID, message.Data)
		if isUserRequestedTransferAbort(message.Data) {
			state.abortTransfer(message.CaptureID)
		} else {
			reportActiveBridgeTaskError(message.CaptureID, strings.TrimSpace(message.Data))
			state.cleanupTransfer(message.CaptureID)
		}
		response = browserBridgeNativeResponse{OK: true}
	case "import-files":
		response = handleBrowserFileImport(message)
	default:
		response = browserBridgeNativeResponse{Error: "action không được hỗ trợ"}
	}

	if message.Action != "transfer-chunk" || !response.OK {
		bridgeLog("handleMessage kết quả action=%s: ok=%v, error=%s, filePath=%s", message.Action, response.OK, response.Error, response.FilePath)
	}
	return response
}

func handleBrowserFileImport(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	capture, err := validatedBrowserCapture(message)
	if err != nil {
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if len(capture.Streams) > 2 || len(message.SourcePaths) != len(capture.Streams) {
		return browserBridgeNativeResponse{Error: "danh sách file media từ trình duyệt không hợp lệ"}
	}
	if err := os.MkdirAll(browserCaptureDataDir(), 0700); err != nil {
		return browserBridgeNativeResponse{Error: err.Error()}
	}

	cleanup := func() {
		removeBrowserCaptureFiles(capture)
	}
	for index, sourcePath := range message.SourcePaths {
		absoluteSource, pathErr := filepath.Abs(strings.TrimSpace(sourcePath))
		if pathErr != nil {
			cleanup()
			return browserBridgeNativeResponse{Error: "đường dẫn file tải của trình duyệt không hợp lệ"}
		}
		info, statErr := os.Stat(absoluteSource)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
			cleanup()
			return browserBridgeNativeResponse{Error: "không tìm thấy file media do trình duyệt tải"}
		}
		const maxBrowserImportBytes = int64(8 * 1024 * 1024 * 1024)
		if info.Size() > maxBrowserImportBytes {
			cleanup()
			return browserBridgeNativeResponse{Error: "file media vượt quá giới hạn 8 GB"}
		}

		extension := safeBrowserStreamExtension(capture.Streams[index].Container)
		finalPath := filepath.Join(browserCaptureDataDir(), fmt.Sprintf("%s-%d.%s", capture.ID, index, extension))
		if copyErr := copyBrowserDownloadedFile(absoluteSource, finalPath, maxBrowserImportBytes); copyErr != nil {
			cleanup()
			return browserBridgeNativeResponse{Error: "không thể nhập file tải từ trình duyệt: " + copyErr.Error()}
		}
		capture.Streams[index].LocalPath = finalPath
		capture.Streams[index].ContentLength = info.Size()
		capture.Streams[index].URL = ""
	}

	capture.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveBrowserCapture(capture); err != nil {
		cleanup()
		return browserBridgeNativeResponse{Error: "không thể lưu capture cục bộ: " + err.Error()}
	}
	return browserBridgeNativeResponse{OK: true, CaptureID: capture.ID}
}

func copyBrowserDownloadedFile(sourcePath, targetPath string, maxBytes int64) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()

	target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	succeeded := false
	defer func() {
		_ = target.Close()
		if !succeeded {
			_ = os.Remove(targetPath)
		}
	}()

	written, err := io.Copy(target, io.LimitReader(source, maxBytes+1))
	if err != nil {
		return err
	}
	if written > maxBytes {
		return errors.New("file media vượt quá giới hạn 8 GB")
	}
	if err := target.Sync(); err != nil {
		return err
	}
	if err := target.Close(); err != nil {
		return err
	}
	succeeded = true
	return nil
}

func handleLegacyBrowserCapture(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	capture, err := validatedBrowserCapture(message)
	if err != nil {
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if err := saveBrowserCapture(capture); err != nil {
		return browserBridgeNativeResponse{Error: "không thể lưu capture: " + err.Error()}
	}
	return browserBridgeNativeResponse{OK: true, CaptureID: capture.ID}
}

func (state *browserNativeHostState) startTransfer(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	if len(state.Transfers) != 0 {
		bridgeLog("startTransfer thất bại: đang có transfer khác đang chạy")
		return browserBridgeNativeResponse{Error: "đang có một lượt truyền media khác"}
	}
	capture, err := validatedBrowserCapture(message)
	if err != nil {
		bridgeLog("startTransfer thất bại: %v", err)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if len(capture.Streams) > 2 {
		bridgeLog("startTransfer thất bại: quá nhiều luồng (%d)", len(capture.Streams))
		return browserBridgeNativeResponse{Error: "mỗi lượt chỉ được truyền tối đa một luồng video và một luồng audio"}
	}
	exportFormat := normalizeBrowserExportFormat(message.ExportFormat)
	if strings.TrimSpace(message.ExportFormat) != "" && exportFormat == "" {
		bridgeLog("startTransfer thất bại: định dạng xuất không hỗ trợ: %s", message.ExportFormat)
		return browserBridgeNativeResponse{Error: "định dạng xuất không được hỗ trợ"}
	}
	if isBrowserAudioExportFormat(exportFormat) {
		if len(capture.Streams) != 1 || !capture.Streams[0].HasAudio {
			bridgeLog("startTransfer thất bại: xuất audio yêu cầu 1 luồng âm thanh")
			return browserBridgeNativeResponse{Error: "xuất audio yêu cầu đúng một luồng có âm thanh"}
		}
	}
	if isBrowserVideoExportFormat(exportFormat) {
		hasVideo := false
		for _, s := range capture.Streams {
			if s.HasVideo {
				hasVideo = true
			}
		}
		if !hasVideo {
			bridgeLog("startTransfer thất bại: xuất video yêu cầu ít nhất một luồng có hình ảnh")
			return browserBridgeNativeResponse{Error: "xuất video yêu cầu ít nhất một luồng có hình ảnh"}
		}
	}
	if err := os.MkdirAll(browserCaptureDataDir(), 0700); err != nil {
		bridgeLog("startTransfer thất bại: không tạo được thư mục data: %v", err)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	transfer := &browserTransferState{
		Capture:      capture,
		Files:        make(map[int]*os.File),
		PartPaths:    make(map[int]string),
		Received:     make(map[int]int64),
		Finished:     make(map[int]bool),
		ExportFormat: exportFormat,
	}
	state.Transfers[capture.ID] = transfer
	bridgeLog("startTransfer thành công: captureID=%s, streams=%d, exportFormat=%s, title=%q", capture.ID, len(capture.Streams), exportFormat, capture.Title)

	taskType := "video"
	if isBrowserAudioExportFormat(exportFormat) {
		taskType = "audio"
	}
	reportActiveBridgeTask(DownloadTask{
		ID:        capture.ID,
		Title:     capture.Title,
		Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", capture.VideoID),
		Channel:   "Browser Bridge",
		Type:      taskType,
		Format:    strings.ToUpper(exportFormat),
		Quality:   "Browser Stream",
		Status:    "running",
		Percent:   0,
		Speed:     "Đang kết nối...",
		Date:      time.Now().Format("02/01/2006 15:04"),
	})

	return browserBridgeNativeResponse{
		OK:        true,
		CaptureID: capture.ID,
	}
}

func (state *browserNativeHostState) writeTransferChunk(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	transfer, ok := state.Transfers[message.CaptureID]
	if !ok {
		return browserBridgeNativeResponse{Error: "không tìm thấy lượt truyền media"}
	}
	if message.StreamIndex < 0 || message.StreamIndex >= len(transfer.Capture.Streams) || transfer.Finished[message.StreamIndex] {
		return browserBridgeNativeResponse{Error: "stream index không hợp lệ"}
	}
	if len(message.Data) == 0 || len(message.Data) > 768*1024 {
		return browserBridgeNativeResponse{Error: "media chunk không hợp lệ"}
	}
	chunk, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(chunk) > 512*1024 {
		return browserBridgeNativeResponse{Error: "không thể giải mã media chunk"}
	}
	const maxBrowserTransferBytes = int64(8 * 1024 * 1024 * 1024)
	if transfer.Received[message.StreamIndex]+int64(len(chunk)) > maxBrowserTransferBytes {
		reportActiveBridgeTaskError(message.CaptureID, "file media vượt quá giới hạn 8 GB")
		state.cleanupTransfer(message.CaptureID)
		bridgeLog("writeTransferChunk: vượt quá giới hạn 8GB")
		return browserBridgeNativeResponse{Error: "file media vượt quá giới hạn 8 GB"}
	}

	file := transfer.Files[message.StreamIndex]
	if file == nil {
		partPath := filepath.Join(browserCaptureDataDir(), fmt.Sprintf("%s-%d.part", message.CaptureID, message.StreamIndex))
		file, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			bridgeLog("writeTransferChunk: lỗi tạo part file %s: %v", partPath, err)
			return browserBridgeNativeResponse{Error: "không thể tạo file media tạm: " + err.Error()}
		}
		transfer.Files[message.StreamIndex] = file
		transfer.PartPaths[message.StreamIndex] = partPath
		bridgeLog("writeTransferChunk: bắt đầu ghi part file %s (stream %d)", partPath, message.StreamIndex)
	}
	written, err := file.Write(chunk)
	if err != nil || written != len(chunk) {
		reportActiveBridgeTaskError(message.CaptureID, "không thể ghi media chunk")
		state.cleanupTransfer(message.CaptureID)
		bridgeLog("writeTransferChunk: lỗi ghi part file: %v", err)
		return browserBridgeNativeResponse{Error: "không thể ghi media chunk"}
	}
	prev := transfer.Received[message.StreamIndex]
	transfer.Received[message.StreamIndex] += int64(written)

	// Update periodic progress every 512 KB or on first chunk
	if prev == 0 || (transfer.Received[message.StreamIndex]/(512*1024) > prev/(512*1024)) {
		var expectedTotal int64
		var receivedTotal int64
		for idx, s := range transfer.Capture.Streams {
			expectedTotal += s.ContentLength
			receivedTotal += transfer.Received[idx]
		}
		var percent float64
		if expectedTotal > 0 {
			percent = math.Min(98.0, float64(receivedTotal)/float64(expectedTotal)*100.0)
		}
		taskType := "video"
		if isBrowserAudioExportFormat(transfer.ExportFormat) {
			taskType = "audio"
		}
		speedMsg := fmt.Sprintf("%.1f MB", float64(receivedTotal)/(1024*1024))
		if expectedTotal > 0 {
			speedMsg = fmt.Sprintf("%.1f MB / %.1f MB", float64(receivedTotal)/(1024*1024), float64(expectedTotal)/(1024*1024))
		}
		reportActiveBridgeTask(DownloadTask{
			ID:        message.CaptureID,
			Title:     transfer.Capture.Title,
			Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", transfer.Capture.VideoID),
			Channel:   "Browser Bridge",
			Type:      taskType,
			Format:    strings.ToUpper(transfer.ExportFormat),
			Quality:   "Browser Stream",
			Status:    "running",
			Percent:   percent,
			Speed:     speedMsg,
			Date:      time.Now().Format("02/01/2006 15:04"),
		})
		if prev == 0 || (transfer.Received[message.StreamIndex]/(2*1024*1024) > prev/(2*1024*1024)) {
			bridgeLog("writeTransferChunk: captureID=%s stream=%d đã nhận %d bytes (%.1f MB)",
				message.CaptureID, message.StreamIndex, transfer.Received[message.StreamIndex], float64(transfer.Received[message.StreamIndex])/(1024*1024))
		}
	}
	return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID, Received: transfer.Received[message.StreamIndex]}
}

func (state *browserNativeHostState) finishTransferStream(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	transfer, ok := state.Transfers[message.CaptureID]
	if !ok || message.StreamIndex < 0 || message.StreamIndex >= len(transfer.Capture.Streams) {
		return browserBridgeNativeResponse{Error: "stream cần hoàn tất không hợp lệ"}
	}
	file := transfer.Files[message.StreamIndex]
	if file == nil || transfer.Received[message.StreamIndex] == 0 {
		return browserBridgeNativeResponse{Error: "stream chưa có dữ liệu"}
	}
	if err := file.Sync(); err != nil {
		reportActiveBridgeTaskError(message.CaptureID, err.Error())
		state.cleanupTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if err := file.Close(); err != nil {
		reportActiveBridgeTaskError(message.CaptureID, err.Error())
		state.cleanupTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	delete(transfer.Files, message.StreamIndex)
	extension := safeBrowserStreamExtension(transfer.Capture.Streams[message.StreamIndex].Container)
	finalPath := filepath.Join(browserCaptureDataDir(), fmt.Sprintf("%s-%d.%s", message.CaptureID, message.StreamIndex, extension))
	if err := os.Rename(transfer.PartPaths[message.StreamIndex], finalPath); err != nil {
		reportActiveBridgeTaskError(message.CaptureID, err.Error())
		state.cleanupTransfer(message.CaptureID)
		bridgeLog("finishTransferStream: không thể rename sang %s: %v", finalPath, err)
		return browserBridgeNativeResponse{Error: "không thể hoàn tất file media: " + err.Error()}
	}
	stream := &transfer.Capture.Streams[message.StreamIndex]
	stream.LocalPath = finalPath
	stream.ContentLength = transfer.Received[message.StreamIndex]
	stream.URL = ""
	transfer.Finished[message.StreamIndex] = true
	bridgeLog("finishTransferStream: stream %d hoàn tất: path=%s, size=%d bytes", message.StreamIndex, finalPath, stream.ContentLength)
	return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID, Received: transfer.Received[message.StreamIndex]}
}

func (state *browserNativeHostState) finishTransfer(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	transfer, ok := state.Transfers[message.CaptureID]
	if !ok {
		return browserBridgeNativeResponse{Error: "không tìm thấy lượt truyền media"}
	}
	for index := range transfer.Capture.Streams {
		if !transfer.Finished[index] {
			bridgeLog("finishTransfer: stream %d chưa truyền xong", index)
			return browserBridgeNativeResponse{Error: "vẫn còn stream chưa truyền xong"}
		}
	}
	if isBrowserAudioExportFormat(transfer.ExportFormat) {
		bridgeLog("finishTransfer: bắt đầu xuất audio %s cho capture %s", transfer.ExportFormat, message.CaptureID)
		reportActiveBridgeTask(DownloadTask{
			ID:        message.CaptureID,
			Title:     transfer.Capture.Title,
			Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", transfer.Capture.VideoID),
			Channel:   "Browser Bridge",
			Type:      "audio",
			Format:    strings.ToUpper(transfer.ExportFormat),
			Quality:   "Browser Stream",
			Status:    "running",
			Percent:   99,
			Speed:     "FFmpeg đang xuất file...",
			Date:      time.Now().Format("02/01/2006 15:04"),
		})
		filePath, err := exportBrowserAudioCapture(transfer.Capture, transfer.ExportFormat)
		if err != nil {
			reportActiveBridgeTaskError(message.CaptureID, err.Error())
			state.cleanupTransfer(message.CaptureID)
			bridgeLog("finishTransfer: lỗi xuất audio: %v", err)
			return browserBridgeNativeResponse{Error: "không thể xuất audio: " + err.Error()}
		}
		removeBrowserCaptureFiles(transfer.Capture)
		delete(state.Transfers, message.CaptureID)
		reportActiveBridgeTaskFinished(message.CaptureID, filePath)
		bridgeLog("finishTransfer: xuất audio thành công -> %s", filePath)
		return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID, FilePath: filePath}
	}
	if isBrowserVideoExportFormat(transfer.ExportFormat) {
		bridgeLog("finishTransfer: bắt đầu ghép video %s cho capture %s", transfer.ExportFormat, message.CaptureID)
		reportActiveBridgeTask(DownloadTask{
			ID:        message.CaptureID,
			Title:     transfer.Capture.Title,
			Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", transfer.Capture.VideoID),
			Channel:   "Browser Bridge",
			Type:      "video",
			Format:    strings.ToUpper(transfer.ExportFormat),
			Quality:   "Browser Stream",
			Status:    "running",
			Percent:   99,
			Speed:     "FFmpeg đang ghép video...",
			Date:      time.Now().Format("02/01/2006 15:04"),
		})
		filePath, err := exportBrowserVideoCapture(transfer.Capture, transfer.ExportFormat)
		if err != nil {
			reportActiveBridgeTaskError(message.CaptureID, err.Error())
			state.cleanupTransfer(message.CaptureID)
			bridgeLog("finishTransfer: lỗi ghép video: %v", err)
			return browserBridgeNativeResponse{Error: "không thể ghép video: " + err.Error()}
		}
		removeBrowserCaptureFiles(transfer.Capture)
		delete(state.Transfers, message.CaptureID)
		reportActiveBridgeTaskFinished(message.CaptureID, filePath)
		bridgeLog("finishTransfer: ghép video thành công -> %s", filePath)
		return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID, FilePath: filePath}
	}
	transfer.Capture.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveBrowserCapture(transfer.Capture); err != nil {
		reportActiveBridgeTaskError(message.CaptureID, err.Error())
		state.cleanupTransfer(message.CaptureID)
		bridgeLog("finishTransfer: lỗi lưu capture json: %v", err)
		return browserBridgeNativeResponse{Error: "không thể lưu capture cục bộ: " + err.Error()}
	}
	delete(state.Transfers, message.CaptureID)
	bridgeLog("finishTransfer: lưu capture thành công, chờ app nhận: %s", message.CaptureID)
	return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID}
}

func (state *browserNativeHostState) startNativeDownload(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	targetURL := strings.TrimSpace(message.PageURL)
	if targetURL == "" {
		return browserBridgeNativeResponse{Error: "URL video không hợp lệ"}
	}
	taskID := fmt.Sprintf("bridge_%d", time.Now().UnixNano())
	title := strings.TrimSpace(message.Title)
	if title == "" {
		title = "Video YouTube"
	}
	quality := strings.TrimSpace(message.Quality)
	if quality == "" {
		quality = "1080"
	}
	exportFormat := strings.ToLower(strings.TrimSpace(message.ExportFormat))
	if exportFormat == "" {
		exportFormat = "mp4"
	}

	videoID := youtubeVideoID(targetURL)
	reportActiveBridgeTask(DownloadTask{
		ID:        taskID,
		Title:     title,
		Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID),
		Channel:   "Browser Bridge",
		Type:      "video",
		Format:    strings.ToUpper(exportFormat),
		Quality:   quality + "p",
		Status:    "running",
		Percent:   1,
		Speed:     "Đang chuẩn bị tải...",
		Date:      time.Now().Format("02/01/2006 15:04"),
	})

	bridgeLog("startNativeDownload: bắt đầu tải task %s (url=%s, quality=%s, format=%s, title=%q)", taskID, targetURL, quality, exportFormat, title)

	globalActiveCmdsWg.Add(1)
	go func() {
		defer globalActiveCmdsWg.Done()
		state.runNativeDownload(taskID, targetURL, title, videoID, quality, exportFormat)
	}()

	return browserBridgeNativeResponse{
		OK:        true,
		CaptureID: taskID,
		Status:    "running",
		Percent:   1,
	}
}

func (state *browserNativeHostState) getTaskStatus(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	captureID := strings.TrimSpace(message.CaptureID)
	if captureID != "" {
		globalLastTasksMu.RLock()
		task, found := globalLastTasks[captureID]
		globalLastTasksMu.RUnlock()
		if found {
			return browserBridgeNativeResponse{
				OK:        true,
				CaptureID: task.ID,
				Status:    task.Status,
				Percent:   task.Percent,
				Speed:     task.Speed,
				ETA:       task.ETA,
				FilePath:  task.FilePath,
				Error:     task.Error,
			}
		}
	}

	taskPath := activeBridgeTaskPath()
	data, err := os.ReadFile(taskPath)
	if err != nil || len(data) == 0 {
		return browserBridgeNativeResponse{OK: true, Status: "idle", Percent: 0}
	}
	var task DownloadTask
	if err := json.Unmarshal(data, &task); err != nil {
		return browserBridgeNativeResponse{OK: true, Status: "idle", Percent: 0}
	}
	return browserBridgeNativeResponse{
		OK:        true,
		CaptureID: task.ID,
		Status:    task.Status,
		Percent:   task.Percent,
		Speed:     task.Speed,
		ETA:       task.ETA,
		FilePath:  task.FilePath,
		Error:     task.Error,
	}
}

func (state *browserNativeHostState) runNativeDownload(taskID, targetURL, title, videoID, quality, exportFormat string) {
	manager := NewBinaryManager()
	ytdlpPath := manager.GetYtdlpPath()
	if ytdlpPath == "" {
		reportActiveBridgeTaskError(taskID, "Không tìm thấy yt-dlp; hãy mở app và chạy bước thiết lập")
		bridgeLog("runNativeDownload: không tìm thấy yt-dlp")
		return
	}

	settings := NewStorage().LoadSettings()
	outputDir := strings.TrimSpace(settings.DownloadPath)
	if outputDir == "" {
		outputDir = filepath.Join(os.Getenv("USERPROFILE"), "Downloads", "YT-Downloader")
	}
	_ = os.MkdirAll(outputDir, 0755)

	outTemplate := filepath.Join(outputDir, "%(title)s.%(ext)s")
	args := []string{"--newline", "--progress", "--no-playlist"}
	if quality != "" && quality != "best" {
		args = append(args, "-f", fmt.Sprintf("bestvideo[height<=%s]+bestaudio/best[height<=%s]/best", quality, quality))
	} else {
		args = append(args, "-f", "bestvideo+bestaudio/best")
	}
	args = append(args, "--merge-output-format", exportFormat)
	args = append(args, "-o", outTemplate)
	args = manager.BuildArgs(args...)
	args = append(args, targetURL)

	bridgeLog("runNativeDownload: chạy lệnh: %s %v", ytdlpPath, args)

	cmd := exec.Command(ytdlpPath, args...)
	cmd.SysProcAttr = detachedWindowAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		reportActiveBridgeTaskError(taskID, err.Error())
		bridgeLog("runNativeDownload: lỗi tạo stdout pipe: %v", err)
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	globalActiveCmdsMu.Lock()
	globalActiveCmds[taskID] = cmd
	globalActiveCmdsMu.Unlock()

	defer func() {
		globalActiveCmdsMu.Lock()
		delete(globalActiveCmds, taskID)
		globalActiveCmdsMu.Unlock()
	}()

	if err := cmd.Start(); err != nil {
		reportActiveBridgeTaskError(taskID, err.Error())
		bridgeLog("runNativeDownload: lỗi khởi động cmd: %v", err)
		return
	}

	pctRe := regexp.MustCompile(`\[download\]\s+(\d+(?:\.\d+)?)%`)
	speedRe := regexp.MustCompile(`at\s+([^\s]+(?:B|iB)/s)`)
	etaRe := regexp.MustCompile(`ETA\s+([0-9:]+)`)
	destRe := regexp.MustCompile(`\[(?:download|Merger)\]\s+Destination:\s+(.+)`)
	mergeRe := regexp.MustCompile(`\[Merger\]\s+Merging formats into "(.+)"`)

	var lastReport time.Time
	var finalFilePath string

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()

		if m := destRe.FindStringSubmatch(line); len(m) > 1 {
			dest := strings.TrimSpace(m[1])
			if strings.HasSuffix(strings.ToLower(dest), "."+exportFormat) {
				finalFilePath = dest
			}
		}
		if m := mergeRe.FindStringSubmatch(line); len(m) > 1 {
			finalFilePath = strings.TrimSpace(m[1])
			reportActiveBridgeTask(DownloadTask{
				ID:        taskID,
				Title:     title,
				Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID),
				Channel:   "Browser Bridge",
				Type:      "video",
				Format:    strings.ToUpper(exportFormat),
				Quality:   quality + "p",
				Status:    "running",
				Percent:   99,
				Speed:     "Đang ghép video lossless bằng FFmpeg...",
				Date:      time.Now().Format("02/01/2006 15:04"),
			})
			continue
		}

		if m := pctRe.FindStringSubmatch(line); len(m) > 1 {
			pct, _ := strconv.ParseFloat(m[1], 64)
			speed := "Đang tải..."
			if sm := speedRe.FindStringSubmatch(line); len(sm) > 1 {
				speed = sm[1]
			}
			eta := ""
			if em := etaRe.FindStringSubmatch(line); len(em) > 1 {
				eta = "ETA: " + em[1]
			}

			if time.Since(lastReport) >= 300*time.Millisecond || pct >= 99 {
				lastReport = time.Now()
				reportActiveBridgeTask(DownloadTask{
					ID:        taskID,
					Title:     title,
					Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID),
					Channel:   "Browser Bridge",
					Type:      "video",
					Format:    strings.ToUpper(exportFormat),
					Quality:   quality + "p",
					Status:    "running",
					Percent:   minFloat(98, pct),
					Speed:     speed,
					ETA:       eta,
					Date:      time.Now().Format("02/01/2006 15:04"),
				})
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		globalActiveCmdsMu.Lock()
		_, stillActive := globalActiveCmds[taskID]
		globalActiveCmdsMu.Unlock()
		if stillActive {
			errMsg := stderr.String()
			if strings.TrimSpace(errMsg) == "" {
				errMsg = err.Error()
			}
			reportActiveBridgeTaskError(taskID, errMsg)
			bridgeLog("runNativeDownload: task %s thất bại: %v", taskID, errMsg)
		}
		return
	}

	if finalFilePath == "" {
		// Thử tìm file thực tế vừa được tạo/cập nhật trong thư mục đích
		if candidate := findDownloadedMediaFile(outputDir, title, exportFormat); candidate != "" {
			finalFilePath = candidate
		}
	}

	// Xác thực file thực sự tồn tại trên đĩa trước khi báo hoàn tất
	if finalFilePath == "" || !fileExists(finalFilePath) {
		errMsg := fmt.Sprintf("yt-dlp đã chạy xong nhưng không tìm thấy file đầu ra trong %s", outputDir)
		reportActiveBridgeTaskError(taskID, errMsg)
		bridgeLog("runNativeDownload: task %s thất bại: %s", taskID, errMsg)
		return
	}

	reportActiveBridgeTaskFinished(taskID, finalFilePath)
	bridgeLog("runNativeDownload: task %s hoàn tất thành công -> %s", taskID, finalFilePath)

	historyItem := HistoryItem{
		ID:        taskID,
		Title:     title,
		Channel:   "Browser Bridge",
		Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID),
		FilePath:  finalFilePath,
		FileName:  filepath.Base(finalFilePath),
		Format:    strings.ToUpper(exportFormat),
		Quality:   quality + "p",
		Date:      time.Now().Format("02/01/2006 15:04"),
		Status:    "completed",
	}
	_ = NewStorage().AddHistory(historyItem)
}

func activeBridgeTaskPath() string {
	return filepath.Join(browserCaptureDir(), "active_bridge_task.json")
}

func reportActiveBridgeTask(task DownloadTask) {
	globalLastTasksMu.Lock()
	globalLastTasks[task.ID] = task
	globalLastTasksMu.Unlock()

	data, err := json.Marshal(task)
	if err != nil {
		return
	}
	_ = writeFileAtomic(activeBridgeTaskPath(), data, 0600)
}

func reportActiveBridgeTaskFinished(captureID, filePath string) {
	task := DownloadTask{
		ID:       captureID,
		Status:   "completed",
		Percent:  100,
		FilePath: filePath,
		Speed:    "Hoàn tất",
		Date:     time.Now().Format("02/01/2006 15:04"),
	}
	reportActiveBridgeTask(task)
}

func reportActiveBridgeTaskError(captureID, errMsg string) {
	task := DownloadTask{
		ID:     captureID,
		Status: "error",
		Error:  errMsg,
		Date:   time.Now().Format("02/01/2006 15:04"),
	}
	reportActiveBridgeTask(task)
}

func reportActiveBridgeTaskCancelled(captureID string) {
	task := DownloadTask{
		ID:     captureID,
		Status: "cancelled",
		Error:  "Đã hủy tải",
		Date:   time.Now().Format("02/01/2006 15:04"),
	}
	reportActiveBridgeTask(task)
}

func cleanupStaleBridgeCaptures() {
	captureDir := browserCaptureDataDir()
	entries, err := os.ReadDir(captureDir)
	if err == nil {
		now := time.Now()
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if strings.HasSuffix(name, ".part") {
				info, statErr := entry.Info()
				if statErr == nil && now.Sub(info.ModTime()) > 15*time.Minute {
					_ = os.Remove(filepath.Join(captureDir, name))
				}
			}
		}
	}
	taskPath := activeBridgeTaskPath()
	if info, err := os.Stat(taskPath); err == nil {
		if time.Since(info.ModTime()) > 5*time.Minute {
			_ = os.Remove(taskPath)
		}
	}
}

func normalizeBrowserExportFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "mp3", "m4a", "opus", "flac":
		return strings.ToLower(strings.TrimSpace(format))
	case "mp4", "mkv", "webm":
		return strings.ToLower(strings.TrimSpace(format))
	default:
		return ""
	}
}

func isBrowserAudioExportFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "mp3", "m4a", "opus", "flac":
		return true
	default:
		return false
	}
}

func isBrowserVideoExportFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "mp4", "mkv", "webm":
		return true
	default:
		return false
	}
}

func isUserRequestedTransferAbort(reason string) bool {
	normalized := strings.ToLower(strings.TrimSpace(reason))
	return normalized == "" || strings.Contains(normalized, "người dùng") || strings.Contains(normalized, "user")
}

func (state *browserNativeHostState) abortTransfer(captureID string) {
	reportActiveBridgeTaskCancelled(captureID)
	state.cleanupTransfer(captureID)
}

func (state *browserNativeHostState) cleanupTransfer(captureID string) {
	globalActiveCmdsMu.Lock()
	if cmd, ok := globalActiveCmds[captureID]; ok && cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		delete(globalActiveCmds, captureID)
		bridgeLog("abortTransfer: đã dừng tiến trình download của task %s", captureID)
	}
	globalActiveCmdsMu.Unlock()

	transfer, ok := state.Transfers[captureID]
	if !ok {
		return
	}
	for _, file := range transfer.Files {
		_ = file.Close()
	}
	for _, path := range transfer.PartPaths {
		_ = os.Remove(path)
	}
	for _, stream := range transfer.Capture.Streams {
		if stream.LocalPath != "" {
			_ = os.Remove(stream.LocalPath)
		}
	}
	delete(state.Transfers, captureID)
	bridgeLog("abortTransfer: đã hủy và dọn dẹp các part file của capture %s", captureID)
}

func (state *browserNativeHostState) closeAllTransfers() {
	ids := make([]string, 0, len(state.Transfers))
	for captureID := range state.Transfers {
		ids = append(ids, captureID)
	}
	for _, captureID := range ids {
		state.abortTransfer(captureID)
	}
}

func safeBrowserStreamExtension(container string) string {
	switch strings.ToLower(container) {
	case "mp4", "m4a", "webm", "opus":
		return strings.ToLower(container)
	default:
		return "media"
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

// findDownloadedMediaFile tìm file media trong thư mục đầu ra có tên
// bắt đầu bằng title hoặc được sửa đổi gần đây nhất (trong vòng 5 phút).
func findDownloadedMediaFile(outputDir, title, format string) string {
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return ""
	}
	ext := "." + strings.ToLower(format)
	var bestMatch string
	var bestModTime time.Time
	now := time.Now()

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(strings.ToLower(name), ext) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Chỉ xét file được sửa đổi trong vòng 5 phút qua
		if now.Sub(info.ModTime()) > 5*time.Minute {
			continue
		}
		if info.ModTime().After(bestModTime) {
			bestModTime = info.ModTime()
			bestMatch = filepath.Join(outputDir, name)
		}
	}
	return bestMatch
}

func validatedBrowserCapture(message browserBridgeNativeMessage) (BrowserBridgeCapture, error) {
	videoID := youtubeVideoID(message.PageURL)
	if videoID == "" {
		return BrowserBridgeCapture{}, errors.New("extension không gửi URL YouTube hợp lệ")
	}
	if len(message.Streams) == 0 || len(message.Streams) > 50 {
		return BrowserBridgeCapture{}, errors.New("số lượng luồng không hợp lệ")
	}

	seen := make(map[string]bool)
	streams := make([]BrowserBridgeStream, 0, len(message.Streams))
	for _, stream := range message.Streams {
		if err := validateGoogleVideoStream(stream); err != nil {
			continue
		}
		key := strconv.Itoa(stream.Itag) + "|" + stream.URL
		if seen[key] {
			continue
		}
		seen[key] = true
		streams = append(streams, stream)
	}
	if len(streams) == 0 {
		return BrowserBridgeCapture{}, errors.New("không có URL googlevideo hợp lệ")
	}

	title := strings.TrimSpace(strings.TrimSuffix(message.Title, " - YouTube"))
	if title == "" {
		title = "YouTube Video"
	}
	if len(title) > 240 {
		title = title[:240]
	}

	now := time.Now().UTC()
	captureID := videoID + "_" + strconv.FormatInt(now.UnixNano(), 36)
	return BrowserBridgeCapture{
		ID:         captureID,
		PageURL:    message.PageURL,
		VideoID:    videoID,
		Title:      title,
		CapturedAt: now.Format(time.RFC3339Nano),
		Streams:    streams,
	}, nil
}

func browserCaptureTime(capture BrowserBridgeCapture) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, capture.CapturedAt)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func validateGoogleVideoStream(stream BrowserBridgeStream) error {
	if len(stream.URL) == 0 || len(stream.URL) > 16384 {
		return errors.New("URL media không hợp lệ")
	}
	parsed, err := url.Parse(stream.URL)
	if err != nil || parsed.Scheme != "https" {
		return errors.New("URL media phải dùng HTTPS")
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname != "googlevideo.com" && !strings.HasSuffix(hostname, ".googlevideo.com") {
		return errors.New("domain media không được phép")
	}
	if !stream.HasVideo && !stream.HasAudio {
		return errors.New("luồng không có video hoặc audio")
	}
	return nil
}

func saveBrowserCapture(capture BrowserBridgeCapture) error {
	if err := os.MkdirAll(browserCaptureDir(), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(capture)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(browserCaptureDir(), capture.ID+".json"), data, 0600); err != nil {
		return err
	}
	pruneExpiredBrowserCaptures(capture.ID)
	return nil
}

func pruneExpiredBrowserCaptures(keepID string) {
	entries, err := os.ReadDir(browserCaptureDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || strings.TrimSuffix(entry.Name(), ".json") == keepID {
			continue
		}
		path := filepath.Join(browserCaptureDir(), entry.Name())
		info, statErr := entry.Info()
		if statErr == nil && time.Since(info.ModTime()) > browserCaptureTTL {
			if capture, loadErr := loadBrowserCaptureFile(path); loadErr == nil {
				removeBrowserCaptureFiles(capture)
			}
			_ = os.Remove(path)
		}
	}
	dataEntries, dataErr := os.ReadDir(browserCaptureDataDir())
	if dataErr == nil {
		for _, entry := range dataEntries {
			if entry.IsDir() {
				continue
			}
			if info, infoErr := entry.Info(); infoErr == nil && time.Since(info.ModTime()) > browserCaptureTTL {
				_ = os.Remove(filepath.Join(browserCaptureDataDir(), entry.Name()))
			}
		}
	}
}

func removeBrowserCaptureFiles(capture BrowserBridgeCapture) {
	for _, stream := range capture.Streams {
		if stream.LocalPath != "" {
			_ = os.Remove(stream.LocalPath)
		}
	}
}

func writeBrowserNativeResponse(output io.Writer, response browserBridgeNativeResponse) error {
	data, err := json.Marshal(response)
	if err != nil {
		return err
	}
	var buffer bytes.Buffer
	if err := binary.Write(&buffer, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	buffer.Write(data)
	_, err = output.Write(buffer.Bytes())
	return err
}

func writeFileAtomic(target string, data []byte, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, data, mode); err != nil {
		return err
	}
	if err := replaceFileAtomic(temporary, target); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func youtubeVideoID(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	var videoID string
	switch {
	case host == "youtu.be" || strings.HasSuffix(host, ".youtu.be"):
		videoID = strings.Split(strings.Trim(parsed.Path, "/"), "/")[0]
	case host == "youtube.com" || strings.HasSuffix(host, ".youtube.com"):
		videoID = parsed.Query().Get("v")
		if videoID == "" {
			parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
			if len(parts) >= 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") {
				videoID = parts[1]
			}
		}
	default:
		return ""
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{6,20}$`).MatchString(videoID) {
		return ""
	}
	return videoID
}
