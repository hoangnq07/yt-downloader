package main

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestDownloadFileAtomic(t *testing.T) {
	payload := bytes.Repeat([]byte("yt-downloader-pro"), 64*1024)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write(payload)
	}))
	defer server.Close()

	targetPath := filepath.Join(t.TempDir(), "tool.exe")
	if err := downloadFileAtomic(context.Background(), server.URL, targetPath, int64(len(payload)+1), nil); err != nil {
		t.Fatalf("downloadFileAtomic() error = %v", err)
	}
	actual, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatal("downloaded payload does not match source")
	}
	if _, err := os.Stat(targetPath + ".part"); !os.IsNotExist(err) {
		t.Fatalf("partial file was not removed: %v", err)
	}
}

func TestDownloadFileAtomicCancellationCleansPartialFile(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 1024*1024)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Length", "1048576")
		response.WriteHeader(http.StatusOK)
		flusher, _ := response.(http.Flusher)
		for offset := 0; offset < len(payload); offset += 16 * 1024 {
			end := offset + 16*1024
			if end > len(payload) {
				end = len(payload)
			}
			if _, err := response.Write(payload[offset:end]); err != nil {
				return
			}
			flusher.Flush()
			select {
			case <-request.Context().Done():
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	targetPath := filepath.Join(t.TempDir(), "cancelled.exe")
	if err := downloadFileAtomic(ctx, server.URL, targetPath, int64(len(payload)+1), nil); err == nil {
		t.Fatal("downloadFileAtomic() expected cancellation error")
	}
	for _, path := range []string{targetPath, targetPath + ".part"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("cancelled download left file %q: %v", path, err)
		}
	}
}

func TestExtractFFmpegExecutables(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "ffmpeg.zip")
	archiveFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(archiveFile)
	files := map[string]string{
		"ffmpeg-build/bin/ffmpeg.exe":  "ffmpeg-payload",
		"ffmpeg-build/bin/ffprobe.exe": "ffprobe-payload",
	}
	for name, contents := range files {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := io.WriteString(entry, contents); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}

	ffmpegPath := filepath.Join(t.TempDir(), "ffmpeg.exe")
	ffprobePath := filepath.Join(t.TempDir(), "ffprobe.exe")
	if err := extractFFmpegExecutables(archivePath, ffmpegPath, ffprobePath); err != nil {
		t.Fatalf("extractFFmpegExecutables() error = %v", err)
	}
	for path, expected := range map[string]string{
		ffmpegPath:  "ffmpeg-payload",
		ffprobePath: "ffprobe-payload",
	} {
		actual, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if string(actual) != expected {
			t.Fatalf("%s = %q, want %q", path, string(actual), expected)
		}
	}
}
