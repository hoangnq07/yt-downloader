package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

type BinaryManager struct {
	ytdlpPath  string
	ffmpegDir  string
	ffmpegPath string
}

func NewBinaryManager() *BinaryManager {
	exePath, _ := os.Executable()
	baseDir := filepath.Dir(exePath)

	candidateBinDirs := []string{
		filepath.Join(baseDir, "bin"),
		filepath.Join(baseDir, "..", "bin"),
		filepath.Join(baseDir, "..", "..", "bin"),
		filepath.Join(".", "bin"),
	}

	var foundYtdlp, foundFfmpeg string

	for _, dir := range candidateBinDirs {
		ytPath := filepath.Join(dir, "yt-dlp.exe")
		ffPath := filepath.Join(dir, "ffmpeg.exe")

		if foundYtdlp == "" {
			if _, err := os.Stat(ytPath); err == nil {
				foundYtdlp, _ = filepath.Abs(ytPath)
			}
		}
		if foundFfmpeg == "" {
			if _, err := os.Stat(ffPath); err == nil {
				foundFfmpeg, _ = filepath.Abs(ffPath)
			}
		}
	}

	// Fallback to System PATH if missing
	if foundYtdlp == "" {
		if p, err := exec.LookPath("yt-dlp"); err == nil {
			foundYtdlp = p
		}
	}
	if foundFfmpeg == "" {
		if p, err := exec.LookPath("ffmpeg"); err == nil {
			foundFfmpeg = p
		}
	}

	ffDir := ""
	if foundFfmpeg != "" {
		ffDir = filepath.Dir(foundFfmpeg)
	}

	return &BinaryManager{
		ytdlpPath:  foundYtdlp,
		ffmpegDir:  ffDir,
		ffmpegPath: foundFfmpeg,
	}
}

func (b *BinaryManager) AreBinariesReady() bool {
	return b.ytdlpPath != ""
}

func (b *BinaryManager) GetYtdlpPath() string {
	return b.ytdlpPath
}

func (b *BinaryManager) GetFfmpegDir() string {
	return b.ffmpegDir
}

func (b *BinaryManager) GetFfmpegPath() string {
	return b.ffmpegPath
}

func (b *BinaryManager) BuildArgs(baseArgs ...string) []string {
	args := append([]string{}, baseArgs...)
	if b.ffmpegDir != "" {
		args = append(args, "--ffmpeg-location", b.ffmpegDir)
	}
	return args
}

func (b *BinaryManager) CheckOrReport() error {
	if b.ytdlpPath == "" {
		return fmt.Errorf("không tìm thấy công cụ yt-dlp.exe trong hệ thống hay thư mục bin/")
	}
	return nil
}
