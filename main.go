package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if isBrowserNativeHostInvocation(os.Args[1:]) {
		_ = runBrowserBridgeNativeHost(os.Stdin, os.Stdout)
		return
	}

	for _, arg := range os.Args[1:] {
		if arg == "--install-browser-bridge" {
			app := NewApp()
			status, err := app.InstallBrowserBridge()
			if err != nil {
				fmt.Fprintln(os.Stderr, "Lỗi cài đặt browser bridge:", err)
				os.Exit(1)
			}
			fmt.Printf("Browser bridge sẵn sàng tại: %s\n", status.ExtensionPath)
			return
		}
	}

	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "YT Downloader Pro",
		Width:     1100,
		Height:    750,
		MinWidth:  900,
		MinHeight: 600,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 9, G: 9, B: 11, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
