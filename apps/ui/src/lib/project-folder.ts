/** True only when the UI is running inside a Tauri 2 webview. */
export function supportsNativeFolderPicker(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Opens the host folder picker, or returns null when the browser has no native picker. */
export async function chooseProjectFolder(defaultPath?: string): Promise<string | null> {
  if (!supportsNativeFolderPicker()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath,
  });
  return typeof selected === 'string' ? selected : null;
}
