export namespace main {
	
	export class AppSettings {
	    language: string;
	    theme: string;
	    downloadPath: string;
	    autoOpenFolder: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.theme = source["theme"];
	        this.downloadPath = source["downloadPath"];
	        this.autoOpenFolder = source["autoOpenFolder"];
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
