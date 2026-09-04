//go:build windows

package main

import "syscall"

// CREATE_NO_WINDOW ngăn console window được tạo ngay từ đầu,
// loại bỏ hiện tượng cửa sổ trắng/đen chớp qua trên màn hình.
const CREATE_NO_WINDOW = 0x08000000

// CREATE_BREAKAWAY_FROM_JOB tách process ra khỏi Windows Job Object
// của Chrome, giúp yt-dlp không bị kill khi Chrome đóng native host.
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000

func hiddenWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: CREATE_NO_WINDOW,
	}
}

func detachedWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB,
	}
}
