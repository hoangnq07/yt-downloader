package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEmbeddedBridgeExtensionIdentityAndCapabilities(t *testing.T) {
	manifestData, err := browserExtensionAssets.ReadFile("browser-extension/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Key         string   `json:"key"`
		Version     string   `json:"version"`
		Permissions []string `json:"permissions"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatal(err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(manifest.Key)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(publicKey)
	extensionID := make([]byte, 32)
	for index, value := range hash[:16] {
		extensionID[index*2] = 'a' + value>>4
		extensionID[index*2+1] = 'a' + value&15
	}
	if string(extensionID) != browserBridgeExtensionID {
		t.Fatalf("extension ID = %s, want %s", extensionID, browserBridgeExtensionID)
	}

	if manifest.Version != "3.2.2" {
		t.Fatalf("extension version = %s, want 3.2.2", manifest.Version)
	}
	permissions := strings.Join(manifest.Permissions, ",")
	if !strings.Contains(permissions, "downloads") || !strings.Contains(permissions, "scripting") || !strings.Contains(permissions, "nativeMessaging") || !strings.Contains(permissions, "declarativeNetRequestWithHostAccess") {
		t.Fatalf("bridge extension permissions are incomplete: %v", manifest.Permissions)
	}

	popup, err := browserExtensionAssets.ReadFile("browser-extension/popup.js")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(popup, []byte("ytInitialPlayerResponse")) {
		t.Fatal("popup does not read YouTube page metadata")
	}
	if !bytes.Contains(popup, []byte("captionsAsSRT")) || !bytes.Contains(popup, []byte("captionsAsVTT")) {
		t.Fatal("popup does not provide subtitle conversion")
	}
	if !bytes.Contains(popup, []byte("YOUTUBE SEO METADATA REPORT")) {
		t.Fatal("popup does not provide the TXT SEO metadata report")
	}
	if !bytes.Contains(popup, []byte("data:${mimeType};charset=utf-8")) {
		t.Fatal("generated text downloads are not independent from the popup blob lifecycle")
	}
	if !bytes.Contains(popup, []byte("normalizeChapterLine")) || !bytes.Contains(popup, []byte("normalizeChapterLine(line) || line")) || !bytes.Contains(popup, []byte(".map(normalizeChapterLine)")) {
		t.Fatal("popup does not normalize playlist timestamps in the TXT SEO metadata report")
	}
	if !bytes.Contains(popup, []byte("getYouTubeJsStreams")) || !bytes.Contains(popup, []byte("streamingData")) {
		t.Fatal("popup does not provide the YouTube.js streaming fallback")
	}
	if !bytes.Contains(popup, []byte("exportFormat")) || !bytes.Contains(popup, []byte("btnAbortTransfer")) {
		t.Fatal("popup does not route media through the native FFmpeg exporter with abort support")
	}
	background, err := browserExtensionAssets.ReadFile("browser-extension/background.js")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(background, []byte(browserBridgeHostName)) || !bytes.Contains(background, []byte("transfer-chunk")) {
		t.Fatal("extension does not transfer media through the native bridge")
	}
	bundle, err := browserExtensionAssets.ReadFile("browser-extension/popup.bundle.js")
	if err != nil {
		t.Fatal("built popup bundle is missing; run npm run build:extension: ", err)
	}
	if !bytes.Contains(bundle, []byte("youtubei.js")) || !bytes.Contains(bundle, []byte("getYouTubeJsStreams")) {
		t.Fatal("built popup bundle does not contain the YouTube.js fallback")
	}

	for _, size := range []string{"16", "32", "48", "128"} {
		icon, iconErr := browserExtensionAssets.ReadFile("browser-extension/icons/icon" + size + ".png")
		if iconErr != nil {
			t.Fatalf("icon %s is not embedded: %v", size, iconErr)
		}
		if !bytes.HasPrefix(icon, []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'}) {
			t.Fatalf("icon %s is not a valid PNG", size)
		}
	}
}

func TestInstallBrowserBridgeKeepsIconDirectory(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	executablePath := filepath.Join(t.TempDir(), "yt-downloader-pro.exe")
	registeredManifest := ""
	status, err := (&App{}).installBrowserBridge(executablePath, func(manifestPath string) error {
		registeredManifest = manifestPath
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Installed {
		t.Fatal("assets extension was not marked as installed")
	}
	if _, err := os.Stat(filepath.Join(status.ExtensionPath, "icons", "icon128.png")); err != nil {
		t.Fatalf("installed extension is missing its icon directory: %v", err)
	}
	if registeredManifest != browserNativeHostManifestPath() {
		t.Fatalf("registered manifest = %q, want %q", registeredManifest, browserNativeHostManifestPath())
	}
	manifestData, err := os.ReadFile(registeredManifest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(manifestData, []byte(browserBridgeHostName)) || !bytes.Contains(manifestData, []byte(browserBridgeExtensionID)) {
		t.Fatalf("native host manifest is incomplete: %s", manifestData)
	}
	if _, err := (&App{}).installBrowserBridge(executablePath, func(string) error { return nil }); err != nil {
		t.Fatalf("preparing the extension a second time should replace existing files: %v", err)
	}
}

func TestYouTubeVideoID(t *testing.T) {
	tests := map[string]string{
		"https://www.youtube.com/watch?v=oLuhZHUEIKE": "oLuhZHUEIKE",
		"https://youtu.be/oLuhZHUEIKE?t=3":            "oLuhZHUEIKE",
		"https://www.youtube.com/shorts/oLuhZHUEIKE":  "oLuhZHUEIKE",
		"https://example.com/watch?v=oLuhZHUEIKE":     "",
	}
	for input, expected := range tests {
		if actual := youtubeVideoID(input); actual != expected {
			t.Fatalf("youtubeVideoID(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestValidateGoogleVideoStreamRejectsUntrustedHost(t *testing.T) {
	stream := BrowserBridgeStream{
		URL:      "https://googlevideo.com.evil.example/videoplayback",
		HasVideo: true,
	}
	if err := validateGoogleVideoStream(stream); err == nil {
		t.Fatal("untrusted lookalike host was accepted")
	}

	stream.URL = "https://rr1---sn.example.googlevideo.com/videoplayback?itag=137"
	if err := validateGoogleVideoStream(stream); err != nil {
		t.Fatalf("valid googlevideo host was rejected: %v", err)
	}
}

func TestBrowserNativeMessageRoundTrip(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	message := browserBridgeNativeMessage{
		Action:  "capture",
		PageURL: "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Title:   "Bridge Test - YouTube",
		Streams: []BrowserBridgeStream{
			{
				URL:       "https://rr1---sn.example.googlevideo.com/videoplayback?itag=137",
				Itag:      137,
				Container: "mp4",
				HasVideo:  true,
				Height:    1080,
			},
			{
				URL:       "https://rr1---sn.example.googlevideo.com/videoplayback?itag=140",
				Itag:      140,
				Container: "m4a",
				HasAudio:  true,
			},
		},
	}
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}

	var input bytes.Buffer
	if err := binary.Write(&input, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	input.Write(payload)
	var output bytes.Buffer
	if err := runBrowserBridgeNativeHost(&input, &output); err != nil {
		t.Fatal(err)
	}

	var responseSize uint32
	if err := binary.Read(&output, binary.LittleEndian, &responseSize); err != nil {
		t.Fatal(err)
	}
	responseData := make([]byte, responseSize)
	if _, err := output.Read(responseData); err != nil {
		t.Fatal(err)
	}
	var response browserBridgeNativeResponse
	if err := json.Unmarshal(responseData, &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.CaptureID == "" {
		t.Fatalf("unexpected native response: %+v", response)
	}

	capture, err := loadBrowserCaptureByID(response.CaptureID)
	if err != nil {
		t.Fatal(err)
	}
	if capture.VideoID != "oLuhZHUEIKE" || capture.Title != "Bridge Test" || len(capture.Streams) != 2 {
		t.Fatalf("unexpected capture: %+v", capture)
	}
}

func TestBrowserNativePing(t *testing.T) {
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	response := state.handleMessage([]byte(`{"action":"ping"}`))
	if !response.OK || response.Error != "" {
		t.Fatalf("unexpected ping response: %+v", response)
	}
}

func TestBrowserNativeHostEOFWaitsForPendingNativeDownload(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())

	globalActiveCmdsWg.Add(1)
	done := make(chan error, 1)
	go func() {
		done <- runBrowserBridgeNativeHost(strings.NewReader(""), &bytes.Buffer{})
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runBrowserBridgeNativeHost returned unexpected error: %v", err)
		}
		t.Fatal("native host returned before pending download completed")
	case <-time.After(50 * time.Millisecond):
	}

	globalActiveCmdsWg.Done()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runBrowserBridgeNativeHost returned unexpected error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("native host did not return after pending download completed")
	}
}

func TestBrowserNativeDownloadStatusTracking(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}

	taskID := "test_task_123"
	reportActiveBridgeTask(DownloadTask{
		ID:       taskID,
		Status:   "running",
		Percent:  45,
		Speed:    "12.5 MB/s",
		ETA:      "ETA: 00:05",
		Title:    "Test Video",
		FilePath: "",
	})

	resp := state.handleMessage([]byte(`{"action":"get-task-status","captureId":"test_task_123"}`))
	if !resp.OK || resp.Status != "running" || resp.Percent != 45 || resp.Speed != "12.5 MB/s" {
		t.Fatalf("unexpected get-task-status response: %+v", resp)
	}

	reportActiveBridgeTaskFinished(taskID, "C:\\Users\\test\\output.mp4")
	respFinished := state.handleMessage([]byte(`{"action":"get-task-status","captureId":"test_task_123"}`))
	if !respFinished.OK || respFinished.Status != "completed" || respFinished.Percent != 100 || respFinished.FilePath != "C:\\Users\\test\\output.mp4" {
		t.Fatalf("unexpected completed get-task-status response: %+v", respFinished)
	}
}

func TestBrowserNativeTransferAbortReportsDownloadErrors(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	taskID := "bridge_error_123"

	state.Transfers[taskID] = &browserTransferState{
		Capture: BrowserBridgeCapture{ID: taskID},
		Files:   make(map[int]*os.File),
	}

	response := state.handleMessage([]byte(`{"action":"transfer-abort","captureId":"bridge_error_123","data":"Không thể tải luồng Video itag 401 (HTTP 403)"}`))
	if !response.OK {
		t.Fatalf("unexpected transfer-abort response: %+v", response)
	}
	status := state.handleMessage([]byte(`{"action":"get-task-status","captureId":"bridge_error_123"}`))
	if status.Status != "error" || !strings.Contains(status.Error, "HTTP 403") {
		t.Fatalf("unexpected error status after abort: %+v", status)
	}
}

func TestNormalizeBrowserExportFormat(t *testing.T) {
	for _, format := range []string{"mp3", "m4a", "opus", "flac", "mp4", "mkv", "webm"} {
		if actual := normalizeBrowserExportFormat(format); actual != format {
			t.Fatalf("normalizeBrowserExportFormat(%q) = %q", format, actual)
		}
	}
	if !isBrowserAudioExportFormat("mp3") || isBrowserAudioExportFormat("mp4") {
		t.Fatalf("isBrowserAudioExportFormat failed")
	}
	if !isBrowserVideoExportFormat("mp4") || isBrowserVideoExportFormat("mp3") {
		t.Fatalf("isBrowserVideoExportFormat failed")
	}
	if actual := normalizeBrowserExportFormat("txt"); actual != "" {
		t.Fatalf("unsupported export format was accepted: %q", actual)
	}
}

func TestBrowserNativeChunkTransferCreatesLocalMedia(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	start := browserBridgeNativeMessage{
		Action:  "transfer-start",
		PageURL: "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Title:   "Local Transfer - YouTube",
		Streams: []BrowserBridgeStream{
			{
				URL:       "https://rr1---sn.example.googlevideo.com/videoplayback?itag=137",
				Itag:      137,
				Container: "mp4",
				HasVideo:  true,
				HasAudio:  true,
				Height:    1080,
			},
		},
	}
	startData, err := json.Marshal(start)
	if err != nil {
		t.Fatal(err)
	}
	startResponse := state.handleMessage(startData)
	if !startResponse.OK || startResponse.CaptureID == "" {
		t.Fatalf("unexpected start response: %+v", startResponse)
	}

	media := []byte("browser-proxied-media")
	chunkData, err := json.Marshal(browserBridgeNativeMessage{
		Action:      "transfer-chunk",
		CaptureID:   startResponse.CaptureID,
		StreamIndex: 0,
		Data:        base64.StdEncoding.EncodeToString(media),
	})
	if err != nil {
		t.Fatal(err)
	}
	if response := state.handleMessage(chunkData); !response.OK || response.Received != int64(len(media)) {
		t.Fatalf("unexpected chunk response: %+v", response)
	}

	for _, message := range []browserBridgeNativeMessage{
		{Action: "transfer-stream-end", CaptureID: startResponse.CaptureID, StreamIndex: 0},
		{Action: "transfer-finish", CaptureID: startResponse.CaptureID},
	} {
		data, marshalErr := json.Marshal(message)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if response := state.handleMessage(data); !response.OK {
			t.Fatalf("unexpected finish response: %+v", response)
		}
	}

	capture, err := loadBrowserCaptureByID(startResponse.CaptureID)
	if err != nil {
		t.Fatal(err)
	}
	if len(capture.Streams) != 1 || capture.Streams[0].URL != "" || capture.Streams[0].LocalPath == "" {
		t.Fatalf("unexpected local capture: %+v", capture)
	}
	if filepath.Ext(capture.Streams[0].LocalPath) != ".mp4" {
		t.Fatalf("unexpected local extension: %s", capture.Streams[0].LocalPath)
	}
	actual, err := os.ReadFile(capture.Streams[0].LocalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, media) {
		t.Fatalf("media = %q, want %q", actual, media)
	}

	args, _, err := browserBridgeFFmpegArgs(capture, "video", "best", "mp4", "http://127.0.0.1:7890", "output.mp4")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "-http_proxy") || !strings.Contains(joined, capture.Streams[0].LocalPath) {
		t.Fatalf("local capture should bypass proxy: %s", joined)
	}
}

func TestBrowserNativeRejectsIncompleteStream(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	started := state.startTransfer(browserBridgeNativeMessage{
		PageURL: "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Streams: []BrowserBridgeStream{{URL: "https://test.googlevideo.com/videoplayback?itag=401", Itag: 401, HasVideo: true, Container: "mp4", ContentLength: 100}},
	})
	if !started.OK {
		t.Fatal(started.Error)
	}
	chunk := state.writeTransferChunk(browserBridgeNativeMessage{CaptureID: started.CaptureID, StreamIndex: 0, Data: base64.StdEncoding.EncodeToString([]byte("partial"))})
	if !chunk.OK {
		t.Fatal(chunk.Error)
	}
	finished := state.finishTransferStream(browserBridgeNativeMessage{CaptureID: started.CaptureID, StreamIndex: 0})
	if finished.OK || !strings.Contains(finished.Error, "7/100") {
		t.Fatalf("incomplete stream accepted: %+v", finished)
	}
	if len(state.Transfers) != 0 {
		t.Fatal("incomplete transfer was not cleaned up")
	}
}

func TestBrowserNativeImportsCompletedBrowserDownload(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	sourceDir := t.TempDir()
	sourcePath := filepath.Join(sourceDir, "browser-download.mp4")
	media := []byte("download-manager-media")
	if err := os.WriteFile(sourcePath, media, 0600); err != nil {
		t.Fatal(err)
	}

	message := browserBridgeNativeMessage{
		Action:      "import-files",
		PageURL:     "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Title:       "Browser Download - YouTube",
		SourcePaths: []string{sourcePath},
		Streams: []BrowserBridgeStream{
			{
				URL:       "https://rr1---sn.example.googlevideo.com/videoplayback?itag=18&cpn=test",
				Itag:      18,
				Container: "mp4",
				HasVideo:  true,
				HasAudio:  true,
			},
		},
	}
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	response := state.handleMessage(payload)
	if !response.OK || response.CaptureID == "" {
		t.Fatalf("unexpected import response: %+v", response)
	}

	capture, err := loadBrowserCaptureByID(response.CaptureID)
	if err != nil {
		t.Fatal(err)
	}
	if len(capture.Streams) != 1 || capture.Streams[0].URL != "" || capture.Streams[0].LocalPath == "" {
		t.Fatalf("unexpected imported capture: %+v", capture)
	}
	actual, err := os.ReadFile(capture.Streams[0].LocalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, media) {
		t.Fatalf("imported media = %q, want %q", actual, media)
	}
	if _, err := os.Stat(sourcePath); err != nil {
		t.Fatalf("native import should not remove browser source: %v", err)
	}
}

func TestBrowserBridgeFFmpegArgsSelectRequestedQuality(t *testing.T) {
	capture := BrowserBridgeCapture{
		PageURL: "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Streams: []BrowserBridgeStream{
			{URL: "https://a.googlevideo.com/videoplayback?itag=137", Itag: 137, Container: "mp4", HasVideo: true, Height: 1080, Duration: 60},
			{URL: "https://a.googlevideo.com/videoplayback?itag=136", Itag: 136, Container: "mp4", HasVideo: true, Height: 720, Duration: 60},
			{URL: "https://a.googlevideo.com/videoplayback?itag=140", Itag: 140, Container: "m4a", HasAudio: true, Bitrate: 128000, Duration: 60},
		},
	}

	args, duration, err := browserBridgeFFmpegArgs(capture, "video", "720", "mp4", "http://127.0.0.1:7890", "output.mp4")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "itag=136") || strings.Contains(joined, "itag=137") {
		t.Fatalf("wrong video stream selected: %s", joined)
	}
	if !strings.Contains(joined, "itag=140") || !strings.Contains(joined, "-c copy") {
		t.Fatalf("audio or copy muxing args missing: %s", joined)
	}
	if strings.Count(joined, "-http_proxy http://127.0.0.1:7890") != 2 {
		t.Fatalf("proxy was not applied to both browser inputs: %s", joined)
	}
	if duration != 60 {
		t.Fatalf("duration = %v, want 60", duration)
	}
}

func TestExportBrowserAudioCaptureCreatesRealMP3(t *testing.T) {
	if NewBinaryManager().GetFfmpegPath() == "" {
		t.Skip("FFmpeg is not available")
	}

	appData := t.TempDir()
	userProfile := t.TempDir()
	t.Setenv("APPDATA", appData)
	t.Setenv("USERPROFILE", userProfile)

	sourcePath := filepath.Join(t.TempDir(), "source.wav")
	const sampleRate = uint32(8000)
	const sampleCount = uint32(8000)
	const bytesPerSample = uint16(2)
	dataSize := sampleCount * uint32(bytesPerSample)
	var wav bytes.Buffer
	wav.WriteString("RIFF")
	_ = binary.Write(&wav, binary.LittleEndian, uint32(36)+dataSize)
	wav.WriteString("WAVEfmt ")
	_ = binary.Write(&wav, binary.LittleEndian, uint32(16))
	_ = binary.Write(&wav, binary.LittleEndian, uint16(1))
	_ = binary.Write(&wav, binary.LittleEndian, uint16(1))
	_ = binary.Write(&wav, binary.LittleEndian, sampleRate)
	_ = binary.Write(&wav, binary.LittleEndian, sampleRate*uint32(bytesPerSample))
	_ = binary.Write(&wav, binary.LittleEndian, bytesPerSample)
	_ = binary.Write(&wav, binary.LittleEndian, uint16(16))
	wav.WriteString("data")
	_ = binary.Write(&wav, binary.LittleEndian, dataSize)
	wav.Write(make([]byte, dataSize))
	if err := os.WriteFile(sourcePath, wav.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}

	state := &browserNativeHostState{Transfers: make(map[string]*browserTransferState)}
	startData, err := json.Marshal(browserBridgeNativeMessage{
		Action:       "transfer-start",
		PageURL:      "https://www.youtube.com/watch?v=oLuhZHUEIKE",
		Title:        "Audio integration test",
		ExportFormat: "mp3",
		Streams: []BrowserBridgeStream{{
			URL:       "https://rr1---sn.example.googlevideo.com/videoplayback?itag=140",
			Itag:      140,
			Container: "wav",
			HasAudio:  true,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	started := state.handleMessage(startData)
	if !started.OK || started.CaptureID == "" {
		t.Fatalf("unexpected export start response: %+v", started)
	}
	for _, message := range []browserBridgeNativeMessage{
		{
			Action:      "transfer-chunk",
			CaptureID:   started.CaptureID,
			StreamIndex: 0,
			Data:        base64.StdEncoding.EncodeToString(wav.Bytes()),
		},
		{Action: "transfer-stream-end", CaptureID: started.CaptureID, StreamIndex: 0},
	} {
		data, marshalErr := json.Marshal(message)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if response := state.handleMessage(data); !response.OK {
			t.Fatalf("unexpected export transfer response: %+v", response)
		}
	}
	finishData, err := json.Marshal(browserBridgeNativeMessage{Action: "transfer-finish", CaptureID: started.CaptureID})
	if err != nil {
		t.Fatal(err)
	}
	finished := state.handleMessage(finishData)
	if !finished.OK || finished.FilePath == "" {
		t.Fatalf("unexpected export finish response: %+v", finished)
	}
	outputPath := finished.FilePath
	if filepath.Ext(outputPath) != ".mp3" {
		t.Fatalf("output extension = %s, want .mp3", filepath.Ext(outputPath))
	}
	if !strings.HasPrefix(strings.ToLower(outputPath), strings.ToLower(filepath.Join(userProfile, "Downloads", "YT-Downloader"))) {
		t.Fatalf("output was written outside the configured download folder: %s", outputPath)
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() == 0 {
		t.Fatal("FFmpeg produced an empty MP3")
	}
}

func TestNormalizeBrowserProxyURL(t *testing.T) {
	proxyURL, err := normalizeBrowserProxyURL("127.0.0.1:7890")
	if err != nil || proxyURL != "http://127.0.0.1:7890" {
		t.Fatalf("unexpected normalized proxy: %q, %v", proxyURL, err)
	}
	if _, err := normalizeBrowserProxyURL("socks5://127.0.0.1:1080"); err == nil {
		t.Fatal("unsupported SOCKS proxy was accepted")
	}
	if _, err := normalizeBrowserProxyURL("http://127.0.0.1:7890/path"); err == nil {
		t.Fatal("proxy URL with a path was accepted")
	}
}
