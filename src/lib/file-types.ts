// File-type heuristics for the Explorer.
//
// Extensions we treat as non-text/binary. When the double-click action is "Open
// in Editor" (Settings → Explorer), files matching these fall back to download
// instead of being dumped — as raw bytes — into a text editor (e.g. .mov, .pdf,
// images, archives). The Edit / Open With context-menu actions are deliberately
// NOT filtered: those let the user force any file open on purpose.
const BINARY_EXTENSIONS = new Set<string>([
  // Video
  "mov", "mp4", "m4v", "mkv", "avi", "wmv", "flv", "webm", "mpg", "mpeg", "3gp", "ogv",
  // Audio
  "mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "mid", "midi",
  // Images
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "ico", "webp", "heic", "heif", "avif",
  "psd", "raw", "cr2", "nef", "arw", "dng",
  // Documents / office
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub", "mobi",
  // Archives / compressed
  "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "zst", "lz", "lz4",
  "lzma", "cab", "ar",
  // Executables / binaries / libraries
  "exe", "dll", "so", "dylib", "bin", "o", "obj", "class", "jar", "war", "wasm", "pyc",
  "pyo", "msi", "deb", "rpm", "dmg", "pkg", "apk", "appimage", "elf",
  // Disk images
  "iso", "img", "vmdk", "vdi", "qcow2",
  // Fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // Databases
  "db", "sqlite", "sqlite3", "mdb", "accdb",
]);

/**
 * Whether a file should open in a text editor on double-click. Returns false for
 * known binary formats (video / audio / images / archives / executables / …),
 * which are useless in a code editor — those fall back to download. Files with
 * no extension or a leading-dot dotfile name (e.g. `Dockerfile`, `.env`) are
 * treated as text, matching how scripts and config on servers typically look.
 */
export function isEditableInEditor(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true; // no extension, or a leading-dot dotfile (".env")
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
