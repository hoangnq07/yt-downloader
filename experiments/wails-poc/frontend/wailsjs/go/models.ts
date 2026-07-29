export namespace main {
	
	export class VideoInfo {
	    id: string;
	    title: string;
	    channel: string;
	    duration: number;
	    duration_string: string;
	    view_count: number;
	    thumbnail: string;
	
	    static createFrom(source: any = {}) {
	        return new VideoInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.channel = source["channel"];
	        this.duration = source["duration"];
	        this.duration_string = source["duration_string"];
	        this.view_count = source["view_count"];
	        this.thumbnail = source["thumbnail"];
	    }
	}

}

