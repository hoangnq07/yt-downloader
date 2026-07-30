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
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
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
	Action      string                `json:"action"`
	PageURL     string                `json:"pageUrl"`
	Title       string                `json:"title"`
	CapturedAt  string                `json:"capturedAt"`
	Streams     []BrowserBridgeStream `json:"streams"`
	CaptureID   string                `json:"captureId"`
	StreamIndex int                   `json:"streamIndex"`
	Data        string                `json:"data"`
	SourcePaths []string              `json:"sourcePaths"`
}

type browserBridgeNativeResponse struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	CaptureID string `json:"captureId,omitempty"`
	Received  int64  `json:"received,omitempty"`
}

type browserTransferState struct {
	Capture   BrowserBridgeCapture
	Files     map[int]*os.File
	PartPaths map[int]string
	Received  map[int]int64
	Finished  map[int]bool
}

type browserNativeHostState struct {
	Transfers map[string]*browserTransferState
}

func browserBridgeRootDir() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = os.Getenv("USERPROFILE")
	}
	return filepath.Join(appData, "yt-downloader-pro", "browser-bridge")
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

	status.Installed = true
	status.Message = "Extension tải thumbnail, metadata và phụ đề đã sẵn sàng."
	return status, nil
}

func (a *App) GetBrowserBridgeStatus() BrowserBridgeStatus {
	status := BrowserBridgeStatus{
		ExtensionID:   browserBridgeExtensionID,
		ExtensionPath: browserExtensionDir(),
	}
	_, extensionErr := os.Stat(filepath.Join(status.ExtensionPath, "manifest.json"))
	status.Installed = extensionErr == nil
	if status.Installed {
		status.Message = "YouTube Assets Extension đã được chuẩn bị trên máy."
	} else {
		status.Message = "YouTube Assets Extension chưa được chuẩn bị."
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
			return BrowserBridgeCapture{}, errors.New("chưa nhận được luồng từ extension")
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
		return BrowserBridgeCapture{}, errors.New("chưa có luồng cho video này; hãy phát video vài giây, bấm extension rồi gửi sang app")
	}

	sort.Slice(captures, func(i, j int) bool { return browserCaptureTime(captures[i]).After(browserCaptureTime(captures[j])) })
	capture := captures[0]
	if time.Since(browserCaptureTime(capture)) > browserCaptureTTL {
		return BrowserBridgeCapture{}, errors.New("link media đã hết hạn; hãy gửi lại từ extension")
	}
	if !captureHasUsableMedia(capture) {
		return BrowserBridgeCapture{}, errors.New("extension chưa bắt đủ luồng video/audio; hãy phát video thêm vài giây")
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
	reader := bufio.NewReader(input)
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	defer state.closeAllTransfers()
	for {
		var messageSize uint32
		if err := binary.Read(reader, binary.LittleEndian, &messageSize); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if messageSize == 0 || messageSize > maxNativeMessageSize {
			return fmt.Errorf("native message size không hợp lệ: %d", messageSize)
		}

		messageData := make([]byte, messageSize)
		if _, err := io.ReadFull(reader, messageData); err != nil {
			return err
		}

		response := state.handleMessage(messageData)
		if err := writeBrowserNativeResponse(output, response); err != nil {
			return err
		}
	}
}

func (state *browserNativeHostState) handleMessage(data []byte) browserBridgeNativeResponse {
	var message browserBridgeNativeMessage
	if err := json.Unmarshal(data, &message); err != nil {
		return browserBridgeNativeResponse{Error: "dữ liệu extension không hợp lệ"}
	}

	switch message.Action {
	case "capture":
		return handleLegacyBrowserCapture(message)
	case "transfer-start":
		return state.startTransfer(message)
	case "transfer-chunk":
		return state.writeTransferChunk(message)
	case "transfer-stream-end":
		return state.finishTransferStream(message)
	case "transfer-finish":
		return state.finishTransfer(message)
	case "transfer-abort":
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{OK: true}
	case "import-files":
		return handleBrowserFileImport(message)
	default:
		return browserBridgeNativeResponse{Error: "action không được hỗ trợ"}
	}
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
		return browserBridgeNativeResponse{Error: "đang có một lượt truyền media khác"}
	}
	capture, err := validatedBrowserCapture(message)
	if err != nil {
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if len(capture.Streams) > 2 {
		return browserBridgeNativeResponse{Error: "mỗi lượt chỉ được truyền tối đa một luồng video và một luồng audio"}
	}
	if err := os.MkdirAll(browserCaptureDataDir(), 0700); err != nil {
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	transfer := &browserTransferState{
		Capture:   capture,
		Files:     make(map[int]*os.File),
		PartPaths: make(map[int]string),
		Received:  make(map[int]int64),
		Finished:  make(map[int]bool),
	}
	state.Transfers[capture.ID] = transfer
	return browserBridgeNativeResponse{OK: true, CaptureID: capture.ID}
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
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: "file media vượt quá giới hạn 8 GB"}
	}

	file := transfer.Files[message.StreamIndex]
	if file == nil {
		partPath := filepath.Join(browserCaptureDataDir(), fmt.Sprintf("%s-%d.part", message.CaptureID, message.StreamIndex))
		file, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return browserBridgeNativeResponse{Error: "không thể tạo file media tạm: " + err.Error()}
		}
		transfer.Files[message.StreamIndex] = file
		transfer.PartPaths[message.StreamIndex] = partPath
	}
	written, err := file.Write(chunk)
	if err != nil || written != len(chunk) {
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: "không thể ghi media chunk"}
	}
	transfer.Received[message.StreamIndex] += int64(written)
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
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	if err := file.Close(); err != nil {
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: err.Error()}
	}
	delete(transfer.Files, message.StreamIndex)
	extension := safeBrowserStreamExtension(transfer.Capture.Streams[message.StreamIndex].Container)
	finalPath := filepath.Join(browserCaptureDataDir(), fmt.Sprintf("%s-%d.%s", message.CaptureID, message.StreamIndex, extension))
	if err := os.Rename(transfer.PartPaths[message.StreamIndex], finalPath); err != nil {
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: "không thể hoàn tất file media: " + err.Error()}
	}
	stream := &transfer.Capture.Streams[message.StreamIndex]
	stream.LocalPath = finalPath
	stream.ContentLength = transfer.Received[message.StreamIndex]
	stream.URL = ""
	transfer.Finished[message.StreamIndex] = true
	return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID, Received: transfer.Received[message.StreamIndex]}
}

func (state *browserNativeHostState) finishTransfer(message browserBridgeNativeMessage) browserBridgeNativeResponse {
	transfer, ok := state.Transfers[message.CaptureID]
	if !ok {
		return browserBridgeNativeResponse{Error: "không tìm thấy lượt truyền media"}
	}
	for index := range transfer.Capture.Streams {
		if !transfer.Finished[index] {
			return browserBridgeNativeResponse{Error: "vẫn còn stream chưa truyền xong"}
		}
	}
	transfer.Capture.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveBrowserCapture(transfer.Capture); err != nil {
		state.abortTransfer(message.CaptureID)
		return browserBridgeNativeResponse{Error: "không thể lưu capture cục bộ: " + err.Error()}
	}
	delete(state.Transfers, message.CaptureID)
	return browserBridgeNativeResponse{OK: true, CaptureID: message.CaptureID}
}

func (state *browserNativeHostState) abortTransfer(captureID string) {
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
	if err := os.Rename(temporary, target); err != nil {
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
