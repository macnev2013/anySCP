// Feedback for "open in editor" (double-click or Edit / Open With). The backend
// downloads the whole file before launching the editor, which for a large file
// can take a while with nothing on screen — and a second double-click would
// download and open it again (issue #141). This shows a progress toast while it
// runs and ignores repeat requests for a file that is already opening.

import { toast } from "../stores/toast-store";
import { editorLaunchErrorMessage } from "./editor-errors";

/** Small files open before the toast would show — skip it to avoid a flash. */
export const OPEN_PROGRESS_DELAY_MS = 300;

/** Keys of files currently being downloaded for an editor, across all tabs. */
const opening = new Set<string>();

/**
 * Run `open` (download + launch) for one remote file. `key` identifies the file
 * uniquely across sessions (e.g. `${sessionId}\0${remotePath}`).
 */
export async function openInEditorWithProgress(
  key: string,
  fileName: string,
  open: () => Promise<unknown>,
): Promise<void> {
  if (opening.has(key)) {
    toast.info(`"${fileName}" is already opening…`);
    return;
  }
  opening.add(key);

  let progressToast: string | null = null;
  const timer = setTimeout(() => {
    progressToast = toast.progress(`Downloading "${fileName}" to open…`);
  }, OPEN_PROGRESS_DELAY_MS);
  try {
    await open();
  } catch (err) {
    toast.error(editorLaunchErrorMessage(err));
  } finally {
    clearTimeout(timer);
    if (progressToast) toast.dismiss(progressToast);
    opening.delete(key);
  }
}
