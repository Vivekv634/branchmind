import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class BranchMindSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'branchmind.sidebar';

  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;

  // Stored so it survives webview disposal/re-creation.
  // resolveWebviewView always registers a forwarder that calls this.
  private _messageHandler?: (msg: Record<string, unknown>) => void;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Forward all incoming messages to whatever handler is currently registered.
    // Using a single forwarder means re-registering the handler after disposal
    // is not needed — only _messageHandler needs to be updated.
    webviewView.webview.onDidReceiveMessage(msg => {
      this._messageHandler?.(msg as Record<string, unknown>);
    });

    webviewView.webview.html = this._getLoadingHTML();
  }

  /** Send a message to the webview. No-op if the view is not yet resolved. */
  public postMessage(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  /** Replace the entire webview body content. */
  public setHTML(html: string): void {
    if (!this._view) return;
    this._view.webview.html = this._wrapHTML(html);
  }

  /**
   * Register the handler for messages from the webview.
   * Safe to call before the view resolves — the handler is stored and forwarded
   * once resolveWebviewView fires.
   */
  public onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this._messageHandler = handler;
  }

  private _wrapHTML(bodyContent: string): string {
    const jsUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js')
    );

    // Inline styles to avoid CSP URI issues during development
    const stylesPath = path.join(this._extensionUri.fsPath, 'webview', 'styles.css');
    const inlineStyles = fs.existsSync(stylesPath)
      ? `<style>${fs.readFileSync(stylesPath, 'utf8')}</style>`
      : '';

    const cspSource = this._view?.webview.cspSource ?? '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src ${cspSource} 'unsafe-inline';">
  <title>BranchMind</title>
  ${inlineStyles}
</head>
<body>
  <div id="bm-root">${bodyContent}</div>
  ${jsUri ? `<script src="${jsUri}"></script>` : ''}
</body>
</html>`;
  }

  private _getLoadingHTML(): string {
    return this._wrapHTML(`
      <div class="loading">
        <div class="spinner"></div>
        <p>BranchMind loading…</p>
      </div>
    `);
  }
}
