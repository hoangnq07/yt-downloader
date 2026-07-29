package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	ytdlpDownloadURL  = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
	ffmpegDownloadURL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

	maxYtdlpBytes = int64(100 * 1024 * 1024)
	maxFFmpegZip  = int64(1024 * 1024 * 1024)
	maxFFmpegExe  = int64(1024 * 1024 * 1024)
)

type BinarySetupStatus struct {
	Step          string  `json:"step"`
	Status        string  `json:"status"`
	Message       string  `json:"message"`
	Percent       float64 `json:"percent"`
	ReceivedBytes int64   `json:"receivedBytes"`
	TotalBytes    int64   `json:"totalBytes"`
	BinDir        string  `json:"binDir"`
}

type BinaryStatus struct {
	Ready       bool     `json:"ready"`
	BinDir      string   `json:"binDir"`
	YtdlpPath   string   `json:"ytdlpPath"`
	FFmpegPath  string   `json:"ffmpegPath"`
	FFprobePath string   `json:"ffprobePath"`
	Missing     []string `json:"missing"`
}

type BinaryManager struct {
	mu            sync.RWMutex
	setupMu       sync.Mutex
	ytdlpPath     string
	ffmpegDir     string
	ffmpegPath    string
	ffprobePath   string
	managedBinDir string
}

type setupReporter func(BinarySetupStatus)

func NewBinaryManager() *BinaryManager {
	manager := &BinaryManager{
		managedBinDir: managedBinaryDirectory(),
	}
	manager.refreshPaths()
	return manager
}

func managedBinaryDirectory() string {
	if localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); localAppData != "" {
		return filepath.Join(localAppData, "YT Downloader Pro", "bin")
	}
	if configDir, err := os.UserConfigDir(); err == nil && configDir != "" {
		return filepath.Join(configDir, "YT Downloader Pro", "bin")
	}
	if executable, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(executable), "bin")
	}
	return filepath.Join(".", "bin")
}

func (b *BinaryManager) candidateBinDirectories() []string {
	directories := []string{b.managedBinDir}
	if executable, err := os.Executable(); err == nil {
		baseDir := filepath.Dir(executable)
		directories = append(directories,
			filepath.Join(baseDir, "bin"),
		)
	}
	directories = append(directories, filepath.Join(".", "bin"))

	seen := make(map[string]bool)
	result := make([]string, 0, len(directories))
	for _, directory := range directories {
		absolute, err := filepath.Abs(directory)
		if err != nil {
			continue
		}
		key := strings.ToLower(filepath.Clean(absolute))
		if !seen[key] {
			seen[key] = true
			result = append(result, absolute)
		}
	}
	return result
}

func existingFile(path string) string {
	info, err := os.Stat(path)
	if err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		absolute, absErr := filepath.Abs(path)
		if absErr == nil {
			return absolute
		}
		return path
	}
	return ""
}

func (b *BinaryManager) refreshPaths() {
	var ytdlpPath, ffmpegPath, ffprobePath string
	for _, directory := range b.candidateBinDirectories() {
		if ytdlpPath == "" {
			ytdlpPath = existingFile(filepath.Join(directory, "yt-dlp.exe"))
		}
		if ffmpegPath == "" {
			ffmpegPath = existingFile(filepath.Join(directory, "ffmpeg.exe"))
		}
		if ffprobePath == "" {
			ffprobePath = existingFile(filepath.Join(directory, "ffprobe.exe"))
		}
	}

	if ytdlpPath == "" {
		if found, err := exec.LookPath("yt-dlp"); err == nil {
			ytdlpPath = found
		}
	}
	if ffmpegPath == "" {
		if found, err := exec.LookPath("ffmpeg"); err == nil {
			ffmpegPath = found
		}
	}
	if ffprobePath == "" {
		if found, err := exec.LookPath("ffprobe"); err == nil {
			ffprobePath = found
		}
	}

	ffmpegDir := ""
	if ffmpegPath != "" {
		ffmpegDir = filepath.Dir(ffmpegPath)
	}

	b.mu.Lock()
	b.ytdlpPath = ytdlpPath
	b.ffmpegPath = ffmpegPath
	b.ffprobePath = ffprobePath
	b.ffmpegDir = ffmpegDir
	b.mu.Unlock()
}

func (b *BinaryManager) GetYtdlpPath() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ytdlpPath
}

func (b *BinaryManager) GetFfmpegDir() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ffmpegDir
}

func (b *BinaryManager) GetFfmpegPath() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ffmpegPath
}

func (b *BinaryManager) GetFfprobePath() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ffprobePath
}

func (b *BinaryManager) BuildArgs(baseArgs ...string) []string {
	args := []string{"--ignore-config"}
	if ffmpegDir := b.GetFfmpegDir(); ffmpegDir != "" {
		args = append(args, "--ffmpeg-location", ffmpegDir)
	}
	return append(args, baseArgs...)
}

func commandOutput(ctx context.Context, executable string, args ...string) (string, error) {
	if executable == "" {
		return "", errors.New("đường dẫn executable trống")
	}
	commandCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, executable, args...)
	command.SysProcAttr = hiddenWindowAttr()
	output, err := command.CombinedOutput()
	if commandCtx.Err() != nil {
		return "", commandCtx.Err()
	}
	return strings.TrimSpace(string(output)), err
}

func validateYtdlp(ctx context.Context, executable string) bool {
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 100*1024 {
		return false
	}
	output, err := commandOutput(ctx, executable, "--ignore-config", "--version")
	if err != nil {
		return false
	}
	return regexp.MustCompile(`(?m)^\d{4}\.\d{2}\.\d{2}`).MatchString(output)
}

func validateFFmpeg(ctx context.Context, executable string) bool {
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 500*1024 {
		return false
	}
	output, err := commandOutput(ctx, executable, "-version")
	return err == nil && strings.Contains(strings.ToLower(output), "ffmpeg version")
}

func validateFFprobe(ctx context.Context, executable string) bool {
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 500*1024 {
		return false
	}
	output, err := commandOutput(ctx, executable, "-version")
	return err == nil && strings.Contains(strings.ToLower(output), "ffprobe version")
}

func (b *BinaryManager) Status(ctx context.Context) BinaryStatus {
	b.refreshPaths()
	ytdlpPath := b.GetYtdlpPath()
	ffmpegPath := b.GetFfmpegPath()
	ffprobePath := b.GetFfprobePath()

	type validationResult struct {
		name  string
		valid bool
	}
	results := make(chan validationResult, 3)
	go func() { results <- validationResult{"yt-dlp", validateYtdlp(ctx, ytdlpPath)} }()
	go func() { results <- validationResult{"ffmpeg", validateFFmpeg(ctx, ffmpegPath)} }()
	go func() { results <- validationResult{"ffprobe", validateFFprobe(ctx, ffprobePath)} }()

	valid := make(map[string]bool, 3)
	for index := 0; index < 3; index++ {
		result := <-results
		valid[result.name] = result.valid
	}

	missing := make([]string, 0, 3)
	for _, name := range []string{"yt-dlp", "ffmpeg", "ffprobe"} {
		if !valid[name] {
			missing = append(missing, name)
		}
	}
	return BinaryStatus{
		Ready:       len(missing) == 0,
		BinDir:      b.managedBinDir,
		YtdlpPath:   ytdlpPath,
		FFmpegPath:  ffmpegPath,
		FFprobePath: ffprobePath,
		Missing:     missing,
	}
}

func (b *BinaryManager) CheckOrReport() error {
	missing := make([]string, 0, 3)
	if b.GetYtdlpPath() == "" {
		missing = append(missing, "yt-dlp")
	}
	if b.GetFfmpegPath() == "" {
		missing = append(missing, "ffmpeg")
	}
	if b.GetFfprobePath() == "" {
		missing = append(missing, "ffprobe")
	}
	if len(missing) > 0 {
		return fmt.Errorf("thiếu công cụ %s; hãy chạy lại bước thiết lập", strings.Join(missing, ", "))
	}
	return nil
}

func reportSetup(reporter setupReporter, status BinarySetupStatus) {
	if reporter != nil {
		reporter(status)
	}
}

func downloadFileAtomic(
	ctx context.Context,
	rawURL string,
	targetPath string,
	maxBytes int64,
	onProgress func(received int64, total int64),
) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}
	partPath := targetPath + ".part"
	_ = os.Remove(partPath)
	defer os.Remove(partPath)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "YT-Downloader-Pro/1.0")

	client := &http.Client{
		Timeout: 30 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("quá nhiều lần chuyển hướng khi tải công cụ")
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("máy chủ trả về HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxBytes {
		return fmt.Errorf("file tải xuống vượt quá giới hạn %d MB", maxBytes/(1024*1024))
	}

	output, err := os.OpenFile(partPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = output.Close()
		}
	}()

	buffer := make([]byte, 128*1024)
	var received int64
	lastPercent := int64(-1)
	lastReport := time.Time{}
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			received += int64(count)
			if received > maxBytes {
				return fmt.Errorf("file tải xuống vượt quá giới hạn %d MB", maxBytes/(1024*1024))
			}
			if _, err := output.Write(buffer[:count]); err != nil {
				return err
			}

			percent := int64(0)
			if response.ContentLength > 0 {
				percent = received * 100 / response.ContentLength
			}
			if onProgress != nil && (percent != lastPercent || time.Since(lastReport) >= 500*time.Millisecond) {
				lastPercent = percent
				lastReport = time.Now()
				onProgress(received, response.ContentLength)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return readErr
		}
	}
	if received == 0 {
		return errors.New("file tải xuống rỗng")
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	closed = true
	return os.Rename(partPath, targetPath)
}

func promoteFile(candidatePath string, targetPath string) error {
	backupPath := targetPath + ".previous"
	_ = os.Remove(backupPath)

	targetExists := false
	if _, err := os.Stat(targetPath); err == nil {
		targetExists = true
		if err := os.Rename(targetPath, backupPath); err != nil {
			return err
		}
	}
	if err := os.Rename(candidatePath, targetPath); err != nil {
		if targetExists {
			_ = os.Rename(backupPath, targetPath)
		}
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}

func (b *BinaryManager) installYtdlp(ctx context.Context, reporter setupReporter) error {
	token := time.Now().UnixNano()
	candidatePath := filepath.Join(b.managedBinDir, fmt.Sprintf(".yt-dlp-%d.exe", token))
	defer os.Remove(candidatePath)
	defer os.Remove(candidatePath + ".part")

	reportSetup(reporter, BinarySetupStatus{
		Step:    "yt-dlp",
		Status:  "downloading",
		Message: "Đang tải yt-dlp...",
		Percent: 3,
		BinDir:  b.managedBinDir,
	})
	err := downloadFileAtomic(ctx, ytdlpDownloadURL, candidatePath, maxYtdlpBytes, func(received, total int64) {
		progress := float64(0)
		if total > 0 {
			progress = float64(received) / float64(total)
		}
		reportSetup(reporter, BinarySetupStatus{
			Step:          "yt-dlp",
			Status:        "downloading",
			Message:       "Đang tải yt-dlp...",
			Percent:       3 + progress*17,
			ReceivedBytes: received,
			TotalBytes:    total,
			BinDir:        b.managedBinDir,
		})
	})
	if err != nil {
		return fmt.Errorf("không thể tải yt-dlp: %w", err)
	}

	reportSetup(reporter, BinarySetupStatus{
		Step:    "yt-dlp",
		Status:  "validating",
		Message: "Đang kiểm tra yt-dlp...",
		Percent: 21,
		BinDir:  b.managedBinDir,
	})
	if !validateYtdlp(ctx, candidatePath) {
		return errors.New("file yt-dlp tải xuống không hợp lệ")
	}
	if err := promoteFile(candidatePath, filepath.Join(b.managedBinDir, "yt-dlp.exe")); err != nil {
		return fmt.Errorf("không thể cài đặt yt-dlp: %w", err)
	}
	return nil
}

func preferredZipEntry(reader *zip.ReadCloser, executableName string) *zip.File {
	var fallback *zip.File
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() || !strings.EqualFold(filepath.Base(filepath.FromSlash(entry.Name)), executableName) {
			continue
		}
		normalised := strings.ToLower(strings.ReplaceAll(entry.Name, "\\", "/"))
		if strings.Contains(normalised, "/bin/") {
			return entry
		}
		if fallback == nil {
			fallback = entry
		}
	}
	return fallback
}

func extractZipEntryAtomic(entry *zip.File, targetPath string, maxBytes int64) error {
	if entry == nil {
		return errors.New("không tìm thấy executable trong file ZIP")
	}
	if entry.UncompressedSize64 == 0 || entry.UncompressedSize64 > uint64(maxBytes) {
		return errors.New("kích thước executable trong ZIP không hợp lệ")
	}

	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()

	partPath := targetPath + ".part"
	_ = os.Remove(partPath)
	defer os.Remove(partPath)
	output, err := os.OpenFile(partPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(output, io.LimitReader(input, maxBytes+1))
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written == 0 || written > maxBytes {
		return errors.New("executable giải nén có kích thước không hợp lệ")
	}
	return os.Rename(partPath, targetPath)
}

func extractFFmpegExecutables(archivePath string, ffmpegCandidate string, ffprobeCandidate string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()

	ffmpegEntry := preferredZipEntry(reader, "ffmpeg.exe")
	ffprobeEntry := preferredZipEntry(reader, "ffprobe.exe")
	if ffmpegEntry == nil || ffprobeEntry == nil {
		return errors.New("gói FFmpeg không chứa đủ ffmpeg.exe và ffprobe.exe")
	}
	if err := extractZipEntryAtomic(ffmpegEntry, ffmpegCandidate, maxFFmpegExe); err != nil {
		return fmt.Errorf("không thể giải nén ffmpeg: %w", err)
	}
	if err := extractZipEntryAtomic(ffprobeEntry, ffprobeCandidate, maxFFmpegExe); err != nil {
		return fmt.Errorf("không thể giải nén ffprobe: %w", err)
	}
	return nil
}

func (b *BinaryManager) installFFmpeg(ctx context.Context, reporter setupReporter) error {
	token := time.Now().UnixNano()
	archivePath := filepath.Join(b.managedBinDir, fmt.Sprintf(".ffmpeg-%d.zip", token))
	ffmpegCandidate := filepath.Join(b.managedBinDir, fmt.Sprintf(".ffmpeg-%d.exe", token))
	ffprobeCandidate := filepath.Join(b.managedBinDir, fmt.Sprintf(".ffprobe-%d.exe", token))
	for _, path := range []string{
		archivePath, archivePath + ".part",
		ffmpegCandidate, ffmpegCandidate + ".part",
		ffprobeCandidate, ffprobeCandidate + ".part",
	} {
		defer os.Remove(path)
	}

	reportSetup(reporter, BinarySetupStatus{
		Step:    "ffmpeg",
		Status:  "downloading",
		Message: "Đang tải FFmpeg và FFprobe (có thể mất vài phút)...",
		Percent: 23,
		BinDir:  b.managedBinDir,
	})
	err := downloadFileAtomic(ctx, ffmpegDownloadURL, archivePath, maxFFmpegZip, func(received, total int64) {
		progress := float64(0)
		if total > 0 {
			progress = float64(received) / float64(total)
		}
		reportSetup(reporter, BinarySetupStatus{
			Step:          "ffmpeg",
			Status:        "downloading",
			Message:       "Đang tải FFmpeg và FFprobe (có thể mất vài phút)...",
			Percent:       23 + progress*66,
			ReceivedBytes: received,
			TotalBytes:    total,
			BinDir:        b.managedBinDir,
		})
	})
	if err != nil {
		return fmt.Errorf("không thể tải FFmpeg: %w", err)
	}

	reportSetup(reporter, BinarySetupStatus{
		Step:    "ffmpeg",
		Status:  "extracting",
		Message: "Đang giải nén FFmpeg và FFprobe...",
		Percent: 91,
		BinDir:  b.managedBinDir,
	})
	if err := extractFFmpegExecutables(archivePath, ffmpegCandidate, ffprobeCandidate); err != nil {
		return err
	}

	reportSetup(reporter, BinarySetupStatus{
		Step:    "ffmpeg",
		Status:  "validating",
		Message: "Đang kiểm tra FFmpeg và FFprobe...",
		Percent: 96,
		BinDir:  b.managedBinDir,
	})
	if !validateFFmpeg(ctx, ffmpegCandidate) || !validateFFprobe(ctx, ffprobeCandidate) {
		return errors.New("FFmpeg hoặc FFprobe tải xuống không hợp lệ")
	}
	if err := promoteFile(ffmpegCandidate, filepath.Join(b.managedBinDir, "ffmpeg.exe")); err != nil {
		return fmt.Errorf("không thể cài đặt FFmpeg: %w", err)
	}
	if err := promoteFile(ffprobeCandidate, filepath.Join(b.managedBinDir, "ffprobe.exe")); err != nil {
		return fmt.Errorf("không thể cài đặt FFprobe: %w", err)
	}
	return nil
}

func containsName(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}

func (b *BinaryManager) Ensure(ctx context.Context, reporter setupReporter) (BinaryStatus, error) {
	b.setupMu.Lock()
	defer b.setupMu.Unlock()

	reportSetup(reporter, BinarySetupStatus{
		Step:    "setup",
		Status:  "checking",
		Message: "Đang kiểm tra các công cụ tải xuống...",
		Percent: 1,
		BinDir:  b.managedBinDir,
	})
	current := b.Status(ctx)
	if current.Ready {
		reportSetup(reporter, BinarySetupStatus{
			Step:    "setup",
			Status:  "done",
			Message: "Các công cụ đã sẵn sàng.",
			Percent: 100,
			BinDir:  b.managedBinDir,
		})
		return current, nil
	}

	if err := os.MkdirAll(b.managedBinDir, 0755); err != nil {
		return current, fmt.Errorf("không thể tạo thư mục công cụ: %w", err)
	}
	if containsName(current.Missing, "yt-dlp") {
		if err := b.installYtdlp(ctx, reporter); err != nil {
			return current, err
		}
	}
	if containsName(current.Missing, "ffmpeg") || containsName(current.Missing, "ffprobe") {
		if err := b.installFFmpeg(ctx, reporter); err != nil {
			return current, err
		}
	}

	b.refreshPaths()
	finalStatus := b.Status(ctx)
	if !finalStatus.Ready {
		return finalStatus, fmt.Errorf("thiết lập chưa hoàn tất, còn thiếu: %s", strings.Join(finalStatus.Missing, ", "))
	}
	reportSetup(reporter, BinarySetupStatus{
		Step:    "setup",
		Status:  "done",
		Message: "Thiết lập hoàn tất. Ứng dụng đã sẵn sàng!",
		Percent: 100,
		BinDir:  b.managedBinDir,
	})
	return finalStatus, nil
}
