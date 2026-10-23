const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_500_000;
const MAX_BYTES = 12_000_000;

export type TarFile = {
  name: string;
  data: Uint8Array;
};

export function packTar(files: readonly TarFile[]): Buffer {
  if (files.length > MAX_FILES) {
    throw new Error("archive trop volumineuse");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (const file of files) {
    if (file.data.byteLength > MAX_FILE_BYTES) {
      throw new Error("fichier d'archive trop volumineux");
    }
    total += file.data.byteLength;
    if (total > MAX_BYTES) {
      throw new Error("archive trop volumineuse");
    }
    const header = Buffer.alloc(512, 0);
    const name = Buffer.from(file.name, "utf8");
    if (name.length === 0 || name.length >= 100 || name.includes(0)) {
      throw new Error("nom d'archive refusé");
    }
    name.copy(header, 0);
    writeOctal(header, 100, 0o644, 8);
    writeOctal(header, 108, 0, 8);
    writeOctal(header, 116, 0, 8);
    writeOctal(header, 124, file.data.byteLength, 12);
    writeOctal(header, 136, 0, 12);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    writeChecksum(header);
    chunks.push(header, Buffer.from(file.data));
    const padding = (512 - (file.data.byteLength % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function unpackTar(input: Uint8Array): TarFile[] {
  const buffer = Buffer.from(input);
  const files: TarFile[] = [];
  let offset = 0;
  let total = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }
    if (readOctal(header, 148, 8) !== headerChecksum(header)) {
      throw new Error("archive invalide");
    }
    if (header.subarray(345, 500).some((byte) => byte !== 0)) {
      throw new Error("archive non supportée");
    }
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error("fichier d'archive trop volumineux");
    }
    if (offset + size > buffer.length) {
      throw new Error("archive tronquée");
    }
    const data = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size;
    const padding = (512 - (size % 512)) % 512;
    if (offset + padding > buffer.length) {
      throw new Error("archive tronquée");
    }
    offset += padding;
    const type = header[156] ?? 0;
    if (type === 0x35) {
      continue;
    }
    if (type !== 0 && type !== 0x30) {
      throw new Error("archive non supportée");
    }
    const name = readName(header);
    total += data.length;
    if (total > MAX_BYTES || files.length >= MAX_FILES) {
      throw new Error("archive trop volumineuse");
    }
    files.push({ name, data });
  }
  return files;
}

function writeOctal(buffer: Buffer, offset: number, value: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) {
    throw new Error("valeur d'archive trop grande");
  }
  buffer.write(text, offset, length - 1, "ascii");
}

function writeChecksum(header: Buffer): void {
  const text = headerChecksum(header).toString(8).padStart(6, "0");
  header.write(text, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum;
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const raw = header.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error("archive invalide");
  }
  return Number.parseInt(raw, 8);
}

function readName(header: Buffer): string {
  const raw = header.subarray(0, 100);
  const end = raw.indexOf(0);
  const name = (end === -1 ? raw : raw.subarray(0, end)).toString("utf8");
  if (!isSafeArchivePath(name)) {
    throw new Error("chemin d'archive refusé");
  }
  return name;
}

function isSafeArchivePath(name: string): boolean {
  if (name.length === 0 || name.length > 100 || name.includes("\\") || name.startsWith("/")) {
    return false;
  }
  const parts = name.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}
