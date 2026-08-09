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

func TestNormalizePlaylistItems(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "all items", input: "", want: ""},
		{name: "selected music tracks", input: "1, 2, 5,12", want: "1,2,5,12"},
		{name: "zero is invalid", input: "0,1", wantErr: true},
		{name: "ranges are not accepted from UI", input: "1-4", wantErr: true},
		{name: "yt-dlp option injection", input: "1,--exec=calc", wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizePlaylistItems(test.input)
			if test.wantErr {
				if err == nil {
					t.Fatalf("normalizePlaylistItems(%q) returned no error", test.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizePlaylistItems(%q): %v", test.input, err)
			}
			if got != test.want {
				t.Fatalf("normalizePlaylistItems(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestSafePlaylistFolderName(t *testing.T) {
	tests := map[string]string{
		"Italian Love Songs":       "Italian Love Songs",
		" My: Playlist. ":          "My_ Playlist",
		"CON":                      "_CON",
		"Music %(playlist_index)s": "Music _(playlist_index)s",
		"<>:\"/\\|?*":              "_________",
		"   ":                      "YouTube Playlist",
	}

	for input, expected := range tests {
		if actual := safePlaylistFolderName(input); actual != expected {
			t.Fatalf("safePlaylistFolderName(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestPlaylistItemCount(t *testing.T) {
	if actual := playlistItemCount(""); actual != 0 {
		t.Fatalf("playlistItemCount(empty) = %d, want 0", actual)
	}
	if actual := playlistItemCount("1,2,5,12"); actual != 4 {
		t.Fatalf("playlistItemCount(selected) = %d, want 4", actual)
	}
}

func TestParsePlaylistDownloadProgress(t *testing.T) {
	tests := []struct {
		line           string
		current, total int
		ok             bool
	}{
		{line: "[download] Downloading item 3 of 12", current: 3, total: 12, ok: true},
		{line: "[download] Downloading video 2 of 5", current: 2, total: 5, ok: true},
		{line: "[download] 42.0% of 3.00MiB", ok: false},
	}

	for _, test := range tests {
		current, total, ok := parsePlaylistDownloadProgress(test.line)
		if current != test.current || total != test.total || ok != test.ok {
			t.Fatalf("parsePlaylistDownloadProgress(%q) = (%d, %d, %v), want (%d, %d, %v)", test.line, current, total, ok, test.current, test.total, test.ok)
		}
	}
}
