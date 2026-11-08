export const BOOK_IMAGE_MODEL:"qwen-image-2.0";
export function bailianOrigin(raw:string):string|null;
export function pngSize(data:Buffer):[number,number];
export function paintBookImage(options:{baseUrl:string;apiKey:string;brief:string;signal?:AbortSignal;fetcher?:typeof fetch}):Promise<{bytes:Buffer;width:number;height:number}>;
