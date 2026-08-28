//go:build !windows

package main

import (
	"errors"
	"os"
)

func registerBrowserNativeHost(string) error {
	return errors.New("Browser Bridge native host hiện chỉ hỗ trợ Windows")
}

func replaceFileAtomic(sourcePath, targetPath string) error {
	return os.Rename(sourcePath, targetPath)
}
