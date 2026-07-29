package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type HistoryItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Channel   string `json:"channel"`
	Thumbnail string `json:"thumbnail"`
	FilePath  string `json:"filePath"`
	FileName  string `json:"fileName"`
	Format    string `json:"format"`
	Quality   string `json:"quality"`
	Date      string `json:"date"`
	Duration  string `json:"duration"`
}

type AppSettings struct {
	Language         string `json:"language"`
	Theme            string `json:"theme"`
	DownloadPath     string `json:"downloadPath"`
	AutoOpenFolder   bool   `json:"autoOpenFolder"`
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

func (s *Storage) SaveHistory(items []HistoryItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(items, "", "  ")
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
		Language:       "vi",
		Theme:          "red",
		DownloadPath:   defaultPath,
		AutoOpenFolder: false,
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
