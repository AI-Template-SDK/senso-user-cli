/**
 * Pre-flight checks for the commands that take local file paths.
 *
 * `ingest upload` checked its paths before doing any work; `kb upload` and
 * `ingest reprocess` did not. So the same user mistake — a typo'd path, a
 * zero-byte file — was a usage error naming the file in one command and a raw
 * ENOENT (exit 1), or a doomed upload the ingestion worker could not parse, in
 * the others. The checks live here so the commands cannot drift apart again.
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, EXIT } from "./errors.js";

/** The part of a file's metadata these checks need. */
export interface SizedFile {
  filename: string;
  file_size_bytes: number;
}

/**
 * Fails with a usage error naming the first unreadable path.
 *
 * Checked up front rather than at read time because the read is one of several
 * things a command does — an unreadable path should cost nothing, not a folder
 * prompt or a request the API will have to undo.
 */
export async function assertFilesExist(files: readonly string[]): Promise<void> {
  for (const file of files) {
    try {
      await access(resolve(file));
    } catch (err) {
      throw new CliError(
        `File not found: "${file}". Please check the file name and try again.`,
        EXIT.USAGE,
        {
          code: "usage",
          cause: err,
          hint: "Paths are resolved relative to the current directory.",
        },
      );
    }
  }
}

/**
 * Fails with a usage error when any file is zero bytes.
 *
 * An empty file uploads fine and then fails silently downstream: the worker has
 * nothing to parse, chunk or embed, so the content node never becomes
 * searchable and nothing says why.
 */
export function assertFilesNotEmpty(files: readonly SizedFile[]): void {
  const empty = files.filter((f) => f.file_size_bytes < 1);
  if (empty.length === 0) return;

  // One message rather than a line per file: runAction reports what is thrown,
  // so listing the names here keeps the whole failure in it.
  throw new CliError(`Empty file(s): ${empty.map((f) => f.filename).join(", ")}.`, EXIT.USAGE, {
    code: "usage",
    hint: "Please select valid files with content.",
  });
}
