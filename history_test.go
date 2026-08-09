package main

import (
	"path/filepath"
	"testing"
)

func TestAddHistoryKeepsPlaylistDetails(t *testing.T) {
	storage := &Storage{historyFile: filepath.Join(t.TempDir(), "history.json")}
	if err := storage.AddHistory(HistoryItem{ID: "video", Title: "Video"}); err != nil {
		t.Fatal(err)
	}
	if err := storage.AddHistory(HistoryItem{
		ID:            "playlist",
		Title:         "Italian Love Songs",
		FilePath:      filepath.Join("downloads", "Italian Love Songs"),
		IsPlaylist:    true,
		PlaylistTotal: 12,
	}); err != nil {
		t.Fatal(err)
	}

	history := storage.LoadHistory()
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	playlist := history[0]
	if playlist.ID != "playlist" || !playlist.IsPlaylist || playlist.PlaylistTotal != 12 {
		t.Fatalf("playlist history details were not preserved: %+v", playlist)
	}
}
