package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const browserBridgeUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func (a *App) executeBrowserBridgeTask(task *DownloadTask, opts DownloadOptions) {
	if opts.Type != "video" && opts.Type != "audio" {
		a.failBrowserBridgeTask(task, errors.New("Browser Bridge hiện chỉ hỗ trợ tải video hoặc audio"))
		return
	}

	capture, err := loadBrowserCaptureByID(opts.BrowserCaptureID)
	if err != nil {
		a.failBrowserBridgeTask(task, err)
		return
	}
	if expectedVideoID := youtubeVideoID(opts.URL); expectedVideoID == "" || expectedVideoID != capture.VideoID {
		a.failBrowserBridgeTask(task, errors.New("capture không thuộc video đang tải"))
		return
	}

	format := strings.ToLower(strings.TrimSpace(opts.Format))
	if opts.Type == "video" {
		if format != "mp4" && format != "mkv" && format != "webm" {
			format = "mp4"
		}
	} else if format != "mp3" && format != "m4a" && format != "opus" && format != "flac" {
		format = "mp3"
	}

	title := strings.TrimSpace(opts.Title)
	if title == "" || title == "Video YouTube" {
		title = capture.Title
		task.Title = title
	}
	targetPath := nextAvailableMediaPath(task.FolderPath, title, format)

	proxyURL, err := normalizeBrowserProxyURL(a.storage.LoadSettings().BrowserProxyURL)
	if err != nil {
		a.failBrowserBridgeTask(task, err)
		return
	}
	args, duration, err := browserBridgeFFmpegArgs(capture, opts.Type, opts.Quality, format, proxyURL, targetPath)
	if err != nil {
		a.failBrowserBridgeTask(task, err)
		return
	}

	cmd := exec.Command(a.binaryManager.GetFfmpegPath(), args...)
	cmd.SysProcAttr = hiddenWindowAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.failBrowserBridgeTask(task, err)
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	a.taskMu.Lock()
	a.activeCmds[task.ID] = cmd
	a.taskMu.Unlock()

	task.Percent = 1
	task.Speed = "Browser Bridge"
	task.ETA = "ETA: --"
	a.emitTaskUpdate(task)

	if err := cmd.Start(); err != nil {
		a.removeActiveCommand(task.ID)
		a.failBrowserBridgeTask(task, err)
		return
	}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		key, value, found := strings.Cut(scanner.Text(), "=")
		if !found {
			continue
		}
		switch key {
		case "out_time_us":
			microseconds, parseErr := strconv.ParseFloat(value, 64)
			if parseErr == nil && duration > 0 {
				task.Percent = minFloat(99, microseconds/(duration*1_000_000)*100)
			}
		case "speed":
			if value != "N/A" {
				task.Speed = value
			}
		case "progress":
			a.emitTaskUpdate(task)
		}
	}

	waitErr := cmd.Wait()
	a.removeActiveCommand(task.ID)
	if waitErr != nil {
		_ = os.Remove(targetPath)
		if task.Status != "cancelled" {
			detail := lastFFmpegError(stderr.String())
			if detail == "" {
				detail = waitErr.Error()
			}
			a.failBrowserBridgeTask(task, errors.New(detail))
		}
		return
	}

	task.FilePath = targetPath
	task.Percent = 100
	task.Speed = "Hoàn tất"
	task.ETA = "ETA: 00:00"
	task.Status = "completed"
	a.emitTaskUpdate(task)
	a.saveTaskToHistory(task)
	removeBrowserCaptureFiles(capture)
	_ = os.Remove(filepath.Join(browserCaptureDir(), capture.ID+".json"))
}

func browserBridgeFFmpegArgs(capture BrowserBridgeCapture, mediaType, quality, format, proxyURL, targetPath string) ([]string, float64, error) {
	args := []string{"-hide_banner", "-loglevel", "error", "-y"}
	duration := 0.0

	if mediaType == "audio" {
		audio := selectBrowserAudioStream(capture.Streams, format)
		if audio == nil {
			return nil, 0, errors.New("extension chưa bắt được luồng audio")
		}
		args = appendBrowserInput(args, capture.PageURL, *audio, proxyURL)
		duration = audio.Duration
		args = append(args, "-vn")
		switch format {
		case "m4a":
			args = append(args, "-c:a", "aac", "-b:a", "256k")
		case "opus":
			args = append(args, "-c:a", "libopus", "-b:a", "192k")
		case "flac":
			args = append(args, "-c:a", "flac")
		default:
			args = append(args, "-c:a", "libmp3lame", "-q:a", audioQualityValue(quality))
		}
	} else {
		video := selectBrowserVideoStream(capture.Streams, quality, format)
		if video == nil {
			return nil, 0, errors.New("extension chưa bắt được luồng video")
		}
		args = appendBrowserInput(args, capture.PageURL, *video, proxyURL)
		duration = video.Duration

		var audio *BrowserBridgeStream
		if !video.HasAudio {
			audio = selectBrowserAudioStream(capture.Streams, format)
			if audio == nil {
				return nil, 0, errors.New("extension mới bắt được hình nhưng chưa bắt được tiếng; hãy phát video thêm vài giây")
			}
			args = appendBrowserInput(args, capture.PageURL, *audio, proxyURL)
			if audio.Duration > duration {
				duration = audio.Duration
			}
			args = append(args, "-map", "0:v:0", "-map", "1:a:0")
		} else {
			args = append(args, "-map", "0:v:0", "-map", "0:a:0?")
		}

		copyCompatible := format == "mkv" ||
			(format == "mp4" && video.Container == "mp4" && (audio == nil || audio.Container == "m4a")) ||
			(format == "webm" && video.Container == "webm" && (audio == nil || audio.Container == "webm"))
		if copyCompatible {
			args = append(args, "-c", "copy")
			if format == "mp4" {
				args = append(args, "-movflags", "+faststart")
			}
		} else if format == "webm" {
			args = append(args, "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus", "-b:a", "192k")
		} else {
			args = append(args, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k")
			if format == "mp4" {
				args = append(args, "-movflags", "+faststart")
			}
		}
	}

	args = append(args, "-progress", "pipe:1", "-nostats", targetPath)
	return args, duration, nil
}

func appendBrowserInput(args []string, referer string, stream BrowserBridgeStream, proxyURL string) []string {
	if stream.LocalPath != "" {
		return append(args, "-i", stream.LocalPath)
	}
	if proxyURL != "" {
		args = append(args, "-http_proxy", proxyURL)
	}
	return append(args,
		"-user_agent", browserBridgeUserAgent,
		"-referer", referer,
		"-i", stream.URL,
	)
}

func selectBrowserVideoStream(streams []BrowserBridgeStream, quality, format string) *BrowserBridgeStream {
	desiredHeight := 0
	if quality != "" && quality != "best" {
		desiredHeight, _ = strconv.Atoi(quality)
	}
	candidates := make([]BrowserBridgeStream, 0)
	for _, stream := range streams {
		if stream.HasVideo && (desiredHeight == 0 || stream.Height == 0 || stream.Height <= desiredHeight) {
			candidates = append(candidates, stream)
		}
	}
	if len(candidates) == 0 && desiredHeight > 0 {
		for _, stream := range streams {
			if stream.HasVideo {
				candidates = append(candidates, stream)
			}
		}
	}
	preferredContainer := format
	if format == "mkv" {
		preferredContainer = ""
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		leftPreferred := preferredContainer != "" && candidates[i].Container == preferredContainer
		rightPreferred := preferredContainer != "" && candidates[j].Container == preferredContainer
		if candidates[i].Height != candidates[j].Height {
			return candidates[i].Height > candidates[j].Height
		}
		if leftPreferred != rightPreferred {
			return leftPreferred
		}
		return candidates[i].Bitrate > candidates[j].Bitrate
	})
	if len(candidates) == 0 {
		return nil
	}
	return &candidates[0]
}

func selectBrowserAudioStream(streams []BrowserBridgeStream, outputFormat string) *BrowserBridgeStream {
	candidates := make([]BrowserBridgeStream, 0)
	for _, stream := range streams {
		if stream.HasAudio {
			candidates = append(candidates, stream)
		}
	}
	preferredContainer := ""
	if outputFormat == "mp4" || outputFormat == "m4a" || outputFormat == "mp3" || outputFormat == "flac" {
		preferredContainer = "m4a"
	} else if outputFormat == "webm" || outputFormat == "opus" {
		preferredContainer = "webm"
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		leftAudioOnly := !candidates[i].HasVideo
		rightAudioOnly := !candidates[j].HasVideo
		if leftAudioOnly != rightAudioOnly {
			return leftAudioOnly
		}
		leftPreferred := candidates[i].Container == preferredContainer
		rightPreferred := candidates[j].Container == preferredContainer
		if leftPreferred != rightPreferred {
			return leftPreferred
		}
		return candidates[i].Bitrate > candidates[j].Bitrate
	})
	if len(candidates) == 0 {
		return nil
	}
	return &candidates[0]
}

func audioQualityValue(quality string) string {
	switch quality {
	case "2", "5":
		return quality
	default:
		return "0"
	}
}

func nextAvailableMediaPath(folder, title, extension string) string {
	invalid := regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
	cleanTitle := strings.Trim(strings.TrimSpace(invalid.ReplaceAllString(title, "_")), ". ")
	if cleanTitle == "" {
		cleanTitle = "YouTube Video"
	}
	if len([]rune(cleanTitle)) > 180 {
		cleanTitle = string([]rune(cleanTitle)[:180])
	}
	path := filepath.Join(folder, cleanTitle+"."+extension)
	for index := 2; ; index++ {
		if _, err := os.Stat(path); err != nil {
			return path
		}
		path = filepath.Join(folder, fmt.Sprintf("%s (%d).%s", cleanTitle, index, extension))
	}
}

func lastFFmpegError(stderr string) string {
	lines := strings.Split(strings.ReplaceAll(stderr, "\r\n", "\n"), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line != "" {
			if len(line) > 300 {
				line = line[:300] + "..."
			}
			return line
		}
	}
	return ""
}

func (a *App) removeActiveCommand(taskID string) {
	a.taskMu.Lock()
	delete(a.activeCmds, taskID)
	a.taskMu.Unlock()
}

func (a *App) failBrowserBridgeTask(task *DownloadTask, err error) {
	if task.Status != "cancelled" {
		task.Status = "error"
		task.Error = err.Error()
	}
	a.emitTaskUpdate(task)
}

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}
