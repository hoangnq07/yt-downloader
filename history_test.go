package main

import (
	"os"
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

func TestUpsertHistoryUpdatesPlaylistWithoutDuplicates(t *testing.T) {
	storage := &Storage{historyFile: filepath.Join(t.TempDir(), "history.json")}
	item := HistoryItem{
		ID:            "playlist",
		Title:         "Trending 20 Italy",
		IsPlaylist:    true,
		PlaylistTotal: 5,
		Status:        "running",
	}
	if err := storage.UpsertHistory(item); err != nil {
		t.Fatal(err)
	}

	item.Status = "completed"
	if err := storage.UpsertHistory(item); err != nil {
		t.Fatal(err)
	}

	history := storage.LoadHistory()
	if len(history) != 1 {
		t.Fatalf("history length = %d, want 1", len(history))
	}
	if history[0].Status != "completed" || history[0].PlaylistTotal != 5 {
		t.Fatalf("playlist history was not updated: %+v", history[0])
	}
}

func TestLoadAndReconcileHistoryRepairsCompletedPlaylist(t *testing.T) {
	folder := t.TempDir()
	for _, name := range []string{"First.mp3", "Second.mp3", "Second.webm.part"} {
		if err := os.WriteFile(filepath.Join(folder, name), []byte("media"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	storage := &Storage{historyFile: filepath.Join(t.TempDir(), "history.json")}
	if err := storage.SaveHistory([]HistoryItem{{
		ID:            "playlist",
		FilePath:      folder,
		Format:        "mp3",
		IsPlaylist:    true,
		PlaylistTotal: 2,
		Status:        "error",
		Error:         "network error",
	}}); err != nil {
		t.Fatal(err)
	}

	history := storage.LoadAndReconcileHistory()
	if len(history) != 1 || history[0].Status != "completed" || history[0].PlaylistDone != 2 || history[0].Error != "" {
		t.Fatalf("history was not repaired: %+v", history)
	}
	if _, err := os.Stat(filepath.Join(folder, "Second.webm.part")); !os.IsNotExist(err) {
		t.Fatalf("redundant part file was not removed, stat error: %v", err)
	}
}
