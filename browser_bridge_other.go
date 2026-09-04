//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

func registerBrowserNativeHost(string) error {
	return errors.New("Browser Bridge native host hiện chỉ hỗ trợ Windows")
}

func replaceFileAtomic(sourcePath, targetPath string) error {
	return os.Rename(sourcePath, targetPath)
}

func hiddenWindowAttr() *syscall.SysProcAttr {
	return nil
}

func detachedWindowAttr() *syscall.SysProcAttr {
	return nil
}
