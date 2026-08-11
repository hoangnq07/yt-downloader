package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type HistoryItem struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Channel       string `json:"channel"`
	Thumbnail     string `json:"thumbnail"`
	FilePath      string `json:"filePath"`
	FileName      string `json:"fileName"`
	Format        string `json:"format"`
	Quality       string `json:"quality"`
	Date          string `json:"date"`
	Duration      string `json:"duration"`
	IsPlaylist    bool   `json:"isPlaylist,omitempty"`
	PlaylistTotal int    `json:"playlistTotal,omitempty"`
	PlaylistDone  int    `json:"playlistDone,omitempty"`
	Status        string `json:"status,omitempty"`
	Error         string `json:"error,omitempty"`
}

type AppSettings struct {
	Language        string `json:"language"`
	Theme           string `json:"theme"`
	DownloadPath    string `json:"downloadPath"`
	AutoOpenFolder  bool   `json:"autoOpenFolder"`
	BrowserProxyURL string `json:"browserProxyUrl"`
}

type Storage struct {
	mu           sync.Mutex
	configDir    string
	historyFile  string
	settingsFile string
}

func NewStorage() *Storage {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = os.Getenv("USERPROFILE")
	}
	configDir := filepath.Join(appData, "yt-downloader-pro")
	os.MkdirAll(configDir, 0755)

	return &Storage{
		configDir:    configDir,
		historyFile:  filepath.Join(configDir, "history.json"),
		settingsFile: filepath.Join(configDir, "settings.json"),
	}
}

func (s *Storage) LoadHistory() []HistoryItem {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.historyFile)
	if err != nil {
		return []HistoryItem{}
	}

	var items []HistoryItem
	if err := json.Unmarshal(data, &items); err != nil {
		return []HistoryItem{}
	}
	return items
}

func (s *Storage) LoadAndReconcileHistory() []HistoryItem {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.historyFile)
	if err != nil {
		return []HistoryItem{}
	}
	var items []HistoryItem
	if json.Unmarshal(data, &items) != nil {
		return []HistoryItem{}
	}

	changed := false
	for index := range items {
		item := &items[index]
		if !item.IsPlaylist || item.PlaylistTotal <= 0 || (item.Status != "error" && item.Status != "partial") {
			continue
		}
		extension := safeOutputExtension(item.Format)
		completed := completedPlaylistOutputCount(item.FilePath, extension)
		if completed > item.PlaylistTotal {
			completed = item.PlaylistTotal
		}
		if item.PlaylistDone != completed {
			item.PlaylistDone = completed
			changed = true
		}
		if completed >= item.PlaylistTotal {
			removeCompletedPlaylistPartFiles(item.FilePath, extension)
			item.Status = "completed"
			item.Error = ""
			changed = true
		} else if completed > 0 && item.Status != "partial" {
			item.Status = "partial"
			changed = true
		}
	}

	if changed {
		if updated, marshalErr := json.MarshalIndent(items, "", "  "); marshalErr == nil {
			_ = os.WriteFile(s.historyFile, updated, 0644)
		}
	}
	return items
}

func (s *Storage) SaveHistory(items []HistoryItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.historyFile, data, 0644)
}

func (s *Storage) AddHistory(item HistoryItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var items []HistoryItem
	if data, err := os.ReadFile(s.historyFile); err == nil {
		_ = json.Unmarshal(data, &items)
	}
	items = append([]HistoryItem{item}, items...)
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.historyFile, data, 0644)
}

func (s *Storage) UpsertHistory(item HistoryItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var items []HistoryItem
	if data, err := os.ReadFile(s.historyFile); err == nil {
		_ = json.Unmarshal(data, &items)
	}

	updated := make([]HistoryItem, 0, len(items)+1)
	updated = append(updated, item)
	for _, existing := range items {
		if existing.ID != item.ID {
			updated = append(updated, existing)
		}
	}

	data, err := json.MarshalIndent(updated, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.historyFile, data, 0644)
}

func (s *Storage) LoadSettings() AppSettings {
	s.mu.Lock()
	defer s.mu.Unlock()

	defaultPath := filepath.Join(os.Getenv("USERPROFILE"), "Downloads", "YT-Downloader")
	defaultSettings := AppSettings{
		Language:        "vi",
		Theme:           "red",
		DownloadPath:    defaultPath,
		AutoOpenFolder:  false,
		BrowserProxyURL: "",
	}

	data, err := os.ReadFile(s.settingsFile)
	if err != nil {
		return defaultSettings
	}

	var settings AppSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return defaultSettings
	}
	return settings
}

func (s *Storage) SaveSettings(settings AppSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.settingsFile, data, 0644)
}
