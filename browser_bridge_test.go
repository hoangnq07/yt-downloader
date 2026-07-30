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
)

func TestEmbeddedAssetsExtensionIdentityAndCapabilities(t *testing.T) {
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

	if manifest.Version != "2.1.1" {
		t.Fatalf("extension version = %s, want 2.1.1", manifest.Version)
	}
	permissions := strings.Join(manifest.Permissions, ",")
	if !strings.Contains(permissions, "downloads") || !strings.Contains(permissions, "scripting") {
		t.Fatalf("assets extension permissions are incomplete: %v", manifest.Permissions)
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
	if bytes.Contains(popup, []byte(browserBridgeHostName)) {
		t.Fatal("assets extension should not depend on the native video bridge")
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
	status, err := (&App{}).InstallBrowserBridge()
	if err != nil {
		t.Fatal(err)
	}
	if !status.Installed {
		t.Fatal("assets extension was not marked as installed")
	}
	if _, err := os.Stat(filepath.Join(status.ExtensionPath, "icons", "icon128.png")); err != nil {
		t.Fatalf("installed extension is missing its icon directory: %v", err)
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
