import L from 'leaflet';
import { kml } from "@tmcw/togeojson"

//leaflet-kmz
//


export function loadFile(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.responseType = "text";
    xhr.onload = () => {
      if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 0)) {
        resolve(xhr.response || xhr.responseText);
      } else {
        resolve('');
      }
    };
    xhr.onerror = () => reject("Error " + xhr.status + " while fetching remote file: " + url);
    xhr.send();
  });
}

export function getKmlDoc(files: Record<string, string>): string {
  return files["doc.kml"] ? "doc.kml" : getKmlFiles(Object.keys(files))[0];
}

export function getKmlFiles(files: string[]): string[] {
  return files.filter((file) => isKmlFile(file));
}

export function getImageFiles(files: string[]): string[] {
  return files.filter((file) => isImageFile(file));
}

export function getFileExt(filename: string): string {
  return filename.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg');
}

export function getFileName(url: string): string {
  return url.split('/').pop()!;
}

export function getMimeType(filename: string, ext: string): string {
  let mime = 'text/plain';
  if (/\.(jpe?g|png|gif|bmp)$/i.test(filename)) {
    mime = 'image/' + ext;
  } else if (/\.kml$/i.test(filename)) {
    mime = 'text/plain';
  }
  return mime;
}

export function isImageFile(filename: string): boolean {
  return /\.(jpe?g|png|gif|bmp)$/i.test(filename);
}

export function isKmlFile(filename: string): boolean {
  return /\.kml$/i.test(filename);
}

export function isZipped(file: string): boolean {
  return 'PK' === String.fromCharCode(new Uint8Array(file as any, 0, 1)[0], new Uint8Array(file as any, 1, 1)[0]);
}

export function lazyLoader(urls: string[], promise: Promise<any>): Promise<any> {
  return promise instanceof Promise ? promise : Promise.all(urls.map(url => loadJS(url)))
}

export function loadJS(url: string): Promise<void> {
  return new Promise((resolve, _) => {
    let tag = document.createElement("script");
    tag.addEventListener('load', () => resolve(), { once: true });
    tag.src = url;
    document.head.appendChild(tag);
  });
}

export function parseLatLonBox(xml: XMLDocument): [L.LatLngBounds, number | undefined] {
  let box = L.latLngBounds([
    parseFloat(xml.getElementsByTagName('south')[0].textContent!),
    parseFloat(xml.getElementsByTagName('west')[0].textContent!)
  ], [
    parseFloat(xml.getElementsByTagName('north')[0].textContent!),
    parseFloat(xml.getElementsByTagName('east')[0].textContent!)
  ]);
  let rotation = xml.getElementsByTagName('rotation')[0];
  let rotationValue = rotation ? parseFloat(rotation.textContent!) : undefined;
  return [box, rotationValue];
}


export function toGeoJSON(data: string | XMLDocument, _: any) {
  let xml = data instanceof XMLDocument ? data : toXML(data as string);
  let json = kml(xml);
  return json;
}

export function toXML(data: string | ArrayBuffer): XMLDocument {
  let text = typeof data === 'string' ? data : new Uint8Array(data).reduce((data, byte) => {
    return data + String.fromCharCode(byte);
  }, '');
  let encoding = text.substring(0, text.indexOf("?>")).match(/encoding\s*=\s*["'](.*)["']/i);
  if (encoding) {
    text = new TextDecoder(encoding[1]).decode(data as ArrayBuffer);
  }
  return text ? (new DOMParser()).parseFromString(text, 'text/xml') : document.implementation.createDocument(null, "kml");
}

export function unzip(folder: any): Promise<Record<string, string>> {
  return new Promise((resolve, _) => {
    (window as any).JSZip.loadAsync(folder)
      .then((zip: any) => {
        let files = Object.keys(zip.files)
          .map((name) => {
            let entry = zip.files[name];
            if (isImageFile(name)) {
              let ext = getFileExt(name);
              let mime = getMimeType(name, ext);
              return entry
                .async("base64")
                .then((value: string) => [name, 'data:' + mime + ';base64,' + value]);
            }
            return entry
              .async("text")
              .then((value: string) => [name, value]); // [ fileName, stringValue ]
          });

        Promise.all(files).then((list: any[]) =>
          resolve(list.reduce((obj: Record<string, string>, item: [string, string]) => {
            obj[item[0]] = item[1]; // { fileName: stringValue }
            return obj;
          }, {}))
        );
      });
  });
}
