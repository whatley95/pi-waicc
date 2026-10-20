import { spawn } from "node:child_process";

/**
 * A desktop notification, for when something needs you and Pi is not in front of you. Uses
 * what each system already has: a Windows toast through PowerShell, macOS osascript, Linux
 * notify-send. Text is passed as data, never as script, and nothing waits for it.
 */
const xml = (text: string): string => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function notifyCommand(title: string, body: string, platform = process.platform): [string, string[]] | null {
  const t = title.replace(/\s+/g, " ").slice(0, 120), b = body.replace(/\s+/g, " ").slice(0, 300);
  if (platform === "win32") {
    // PowerShell's own app id, so the toast shows without registering one.
    const script = [
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${xml(t).replace(/'/g, "''")}</text><text>${xml(b).replace(/'/g, "''")}</text></binding></visual></toast>')`,
      "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))",
    ].join("; ");
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]];
  }
  if (platform === "darwin")
    return ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b]];
  if (platform === "linux") return ["notify-send", ["--app-name=WAICC", t, b]];
  return null;
}

/** Shows it without waiting; false when this system has no way to. */
export function notifyDesktop(title: string, body: string): boolean {
  const command = notifyCommand(title, body);
  if (!command) return false;
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* no notifier installed: Pi's own notice still shows */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
