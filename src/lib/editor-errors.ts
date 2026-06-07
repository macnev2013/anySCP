// Shared formatting for editor-launch failures surfaced to the user.
//
// Backend edit commands reject with a serialized error of the shape
// `{ kind, message }` (see SftpError / ScpError / S3Error). We previously
// swallowed these entirely, so launch failures looked like "nothing happened"
// (issues #12, #45, #56). This pulls out a message worth showing in a toast.

export function editorLaunchErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = String((err as { message: unknown }).message).trim();
    if (msg) return msg;
  }
  if (typeof err === "string" && err.trim()) return err;
  return "Couldn't open the editor. Configure one in Settings → Editors.";
}
