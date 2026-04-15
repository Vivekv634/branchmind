import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class BranchMindSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'branchmind.sidebar';

  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;

  /**
   * HTML queued by setHTML() before the view has resolved.
   * Applied immediately in resolveWebviewView() so the panel renders correctly
   * on first open even when activate() fires before the user opens the sidebar.
   */
  private _pendingHTML?: string;

  private _messageHandler?: (msg: Record<string, unknown>) => void;

  /** Called by extension.ts when the view first resolves, so a fresh render can be requested. */
  private _onResolveCallback?: () => void;

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

    webviewView.webview.onDidReceiveMessage(msg => {
      this._messageHandler?.(msg as Record<string, unknown>);
    });

    // Apply any HTML that was queued before the view resolved.
    if (this._pendingHTML !== undefined) {
      webviewView.webview.html = this._wrapHTML(this._pendingHTML);
      this._pendingHTML = undefined;
    } else {
      webviewView.webview.html = this._getLoadingHTML();
    }

    // Notify extension.ts so it can re-render if the view was previously closed
    // and context was lost (retainContextWhenHidden is false to save memory).
    this._onResolveCallback?.();
  }

  /** Send a message to the webview. No-op if the view is not yet resolved. */
  public postMessage(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  /**
   * Replace the entire webview body content.
   * If called before the view has resolved, queues the HTML so it is applied
   * the moment the user opens the sidebar.
   */
  public setHTML(html: string): void {
    if (!this._view) {
      this._pendingHTML = html;
      return;
    }
    this._view.webview.html = this._wrapHTML(html);
  }

  public onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this._messageHandler = handler;
  }

  /**
   * Register a callback to run when the view resolves (i.e. the sidebar is opened).
   * If the view is already resolved, the callback fires immediately.
   * Use this to trigger a fresh render whenever the panel becomes visible.
   */
  public onResolve(callback: () => void): void {
    this._onResolveCallback = callback;
    if (this._view) callback();
  }

  private _wrapHTML(bodyContent: string): string {
    const jsUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js')
    );

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
