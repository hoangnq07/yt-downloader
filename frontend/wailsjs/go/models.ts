export namespace main {
	
	export class AppSettings {
	    language: string;
	    theme: string;
	    downloadPath: string;
	    autoOpenFolder: boolean;
	    browserProxyUrl: string;

	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.theme = source["theme"];
	        this.downloadPath = source["downloadPath"];
	        this.autoOpenFolder = source["autoOpenFolder"];
	        this.browserProxyUrl = source["browserProxyUrl"];
	    }
	}
	export class BinaryStatus {
	    ready: boolean;
	    binDir: string;
	    ytdlpPath: string;
	    ffmpegPath: string;
	    ffprobePath: string;
	    missing: string[];

	    static createFrom(source: any = {}) {
	        return new BinaryStatus(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ready = source["ready"];
	        this.binDir = source["binDir"];
	        this.ytdlpPath = source["ytdlpPath"];
	        this.ffmpegPath = source["ffmpegPath"];
	        this.ffprobePath = source["ffprobePath"];
	        this.missing = source["missing"];
	    }
	}
	export class BrowserBridgeStream {
	    url: string;
	    itag: number;
	    mimeType: string;
	    container: string;
	    hasVideo: boolean;
	    hasAudio: boolean;
	    height: number;
	    bitrate: number;
	    contentLength: number;
	    duration: number;
	    localPath?: string;

	    static createFrom(source: any = {}) {
	        return new BrowserBridgeStream(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.itag = source["itag"];
	        this.mimeType = source["mimeType"];
	        this.container = source["container"];
	        this.hasVideo = source["hasVideo"];
	        this.hasAudio = source["hasAudio"];
	        this.height = source["height"];
	        this.bitrate = source["bitrate"];
	        this.contentLength = source["contentLength"];
	        this.duration = source["duration"];
	        this.localPath = source["localPath"];
	    }
	}
	export class BrowserBridgeCapture {
	    id: string;
	    pageUrl: string;
	    videoId: string;
	    title: string;
	    capturedAt: string;
	    streams: BrowserBridgeStream[];

	    static createFrom(source: any = {}) {
	        return new BrowserBridgeCapture(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.pageUrl = source["pageUrl"];
	        this.videoId = source["videoId"];
	        this.title = source["title"];
	        this.capturedAt = source["capturedAt"];
	        this.streams = this.convertValues(source["streams"], BrowserBridgeStream);
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class BrowserBridgeStatus {
	    installed: boolean;
	    extensionId: string;
	    extensionPath: string;
	    message: string;

	    static createFrom(source: any = {}) {
	        return new BrowserBridgeStatus(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.installed = source["installed"];
	        this.extensionId = source["extensionId"];
	        this.extensionPath = source["extensionPath"];
	        this.message = source["message"];
	    }
	}

	export class DownloadOptions {
	    url: string;
	    type: string;
	    quality: string;
	    format: string;
	    subLang: string;
	    thumbRes: string;
	    outputPath: string;
	    title: string;
	    thumbnail: string;
	    channel: string;
	    browserCaptureId?: string;
	    // Go type: struct { Video bool "json:\"video\""; VideoQual string "json:\"videoQual\""; Audio bool "json:\"audio\""; AudioQual string "json:\"audioQual\""; Sub bool "json:\"sub\""; Thumb bool "json:\"thumb\""; Metadata bool "json:\"metadata\"" }
	    bundleOpts: any;
	
	    static createFrom(source: any = {}) {
	        return new DownloadOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.type = source["type"];
	        this.quality = source["quality"];
	        this.format = source["format"];
	        this.subLang = source["subLang"];
	        this.thumbRes = source["thumbRes"];
	        this.outputPath = source["outputPath"];
	        this.title = source["title"];
	        this.thumbnail = source["thumbnail"];
	        this.channel = source["channel"];
	        this.browserCaptureId = source["browserCaptureId"];
	        this.bundleOpts = this.convertValues(source["bundleOpts"], Object);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DownloadTask {
	    id: string;
	    title: string;
	    thumbnail: string;
	    channel: string;
	    type: string;
	    format: string;
	    quality: string;
	    status: string;
	    percent: number;
	    speed: string;
	    eta: string;
	    filePath: string;
	    folderPath: string;
	    date: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadTask(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.thumbnail = source["thumbnail"];
	        this.channel = source["channel"];
	        this.type = source["type"];
	        this.format = source["format"];
	        this.quality = source["quality"];
	        this.status = source["status"];
	        this.percent = source["percent"];
	        this.speed = source["speed"];
	        this.eta = source["eta"];
	        this.filePath = source["filePath"];
	        this.folderPath = source["folderPath"];
	        this.date = source["date"];
	        this.error = source["error"];
	    }
	}
	export class HistoryItem {
	    id: string;
	    title: string;
	    channel: string;
	    thumbnail: string;
	    filePath: string;
	    fileName: string;
	    format: string;
	    quality: string;
	    date: string;
	    duration: string;
	
	    static createFrom(source: any = {}) {
	        return new HistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.channel = source["channel"];
	        this.thumbnail = source["thumbnail"];
	        this.filePath = source["filePath"];
	        this.fileName = source["fileName"];
	        this.format = source["format"];
	        this.quality = source["quality"];
	        this.date = source["date"];
	        this.duration = source["duration"];
	    }
	}

}
