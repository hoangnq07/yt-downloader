package main

import (
	"errors"
	"strings"
	"testing"
)

func TestVideoInfoCommandErrorExplainsCountryRestriction(t *testing.T) {
	err := videoInfoCommandError(
		"ERROR: [youtube] abc: The uploader has not made this video available in your country",
		errors.New("exit status 1"),
		nil,
	)

	if !strings.Contains(err.Error(), "không khả dụng tại quốc gia/khu vực hiện tại") {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(err.Error(), "exit status 1") {
		t.Fatalf("error exposed only the process status: %v", err)
	}
}

func TestVideoInfoCommandErrorKeepsYtdlpDetail(t *testing.T) {
	err := videoInfoCommandError(
		"WARNING: transient warning\nERROR: [youtube] abc: A useful extractor detail\n",
		errors.New("exit status 1"),
		nil,
	)

	if !strings.Contains(err.Error(), "A useful extractor detail") {
		t.Fatalf("yt-dlp detail was lost: %v", err)
	}
}

func TestVideoInfoCommandErrorExplainsTimeout(t *testing.T) {
	err := videoInfoCommandError("", errors.New("killed"), errors.New("deadline exceeded"))
	if !strings.Contains(err.Error(), "phản hồi quá lâu") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVideoInfoCommandErrorMarksBotCheck(t *testing.T) {
	err := videoInfoCommandError(
		"ERROR: [youtube] abc: Sign in to confirm you're not a bot",
		errors.New("exit status 1"),
		nil,
	)

	if !strings.Contains(err.Error(), youtubeBotCheckErrorCode) {
		t.Fatalf("bot-check marker is missing: %v", err)
	}
	if !strings.Contains(err.Error(), "đổi máy chủ VPN") {
		t.Fatalf("VPN guidance is missing: %v", err)
	}
}

func TestVideoInfoNoFormatsNoticeUsesYtdlpWarning(t *testing.T) {
	notice := videoInfoNoFormatsNotice("WARNING: [youtube] Video unavailable\nWARNING: No video formats found!")
	if !strings.Contains(notice, "Video unavailable") {
		t.Fatalf("video-unavailable warning was not preserved: %s", notice)
	}

	geoNotice := videoInfoNoFormatsNotice("The uploader has not made this video available in your country")
	if !strings.Contains(geoNotice, "quốc gia/khu vực") {
		t.Fatalf("geo restriction was not explained: %s", geoNotice)
	}
}

func TestVideoInfoCommandErrorExplainsSSLError(t *testing.T) {
	stderr := "ERROR: [youtube] MPxSRyMxluU: Unable to download API page: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1010) (caused by SSLError('[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1010)'))"
	err := videoInfoCommandError(stderr, errors.New("exit status 1"), nil)

	if !strings.Contains(err.Error(), "lỗi mạng/SSL hoặc IP bị mạng/quốc gia chặn") {
		t.Fatalf("unexpected error format: %v", err)
	}
	if !strings.Contains(err.Error(), "VPN") {
		t.Fatalf("VPN suggestion is missing: %v", err)
	}
}

