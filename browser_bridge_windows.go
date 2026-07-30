//go:build windows

package main

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func openBrowserBridgeDirectory(path string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	directory, err := windows.UTF16PtrFromString(filepath.Clean(path))
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, directory, nil, nil, windows.SW_SHOWNORMAL)
}

func registerBrowserNativeHost(manifestPath string) error {
	registryPaths := []string{
		`Software\Google\Chrome\NativeMessagingHosts\` + browserBridgeHostName,
		`Software\Microsoft\Edge\NativeMessagingHosts\` + browserBridgeHostName,
		`Software\CocCoc\Browser\NativeMessagingHosts\` + browserBridgeHostName,
		`Software\CocCoc\Browser\Application\NativeMessagingHosts\` + browserBridgeHostName,
	}

	for _, keyPath := range registryPaths {
		key, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
		if err != nil {
			return fmt.Errorf("không thể tạo registry key %s: %w", keyPath, err)
		}
		setErr := key.SetStringValue("", manifestPath)
		closeErr := key.Close()
		if setErr != nil {
			return fmt.Errorf("không thể ghi registry key %s: %w", keyPath, setErr)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
