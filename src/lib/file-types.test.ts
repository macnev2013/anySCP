import { describe, it, expect } from "vitest";
import { isEditableInEditor } from "./file-types";

describe("isEditableInEditor", () => {
  it("returns false for binary media, documents, archives, and executables", () => {
    for (const name of [
      "clip.mov", "movie.MP4", "song.mp3", "photo.JPG", "scan.pdf",
      "sheet.xlsx", "bundle.zip", "installer.dmg", "lib.so", "font.woff2",
      "data.sqlite", "image.png",
    ]) {
      expect(isEditableInEditor(name), name).toBe(false);
    }
  });

  it("returns true for text, code, config, and log files", () => {
    for (const name of [
      "server.log", "main.rs", "index.ts", "config.yaml", "notes.txt",
      "deploy.sh", "data.json", "style.css", "page.html", "query.sql",
    ]) {
      expect(isEditableInEditor(name), name).toBe(true);
    }
  });

  it("treats extensionless files and dotfiles as text", () => {
    for (const name of ["Dockerfile", "Makefile", "README", ".env", ".bashrc", ".gitignore"]) {
      expect(isEditableInEditor(name), name).toBe(true);
    }
  });

  it("keys off the last extension for multi-dot names", () => {
    expect(isEditableInEditor("archive.tar.gz")).toBe(false);
    expect(isEditableInEditor("app.min.js")).toBe(true);
    expect(isEditableInEditor(".env.local")).toBe(true);
  });
});
