/**
 * Minimal vscode stub for running pure-function tests outside of Electron.
 * Only the surface area actually touched at import/call time by the modules
 * under test needs to be stubbed — everything else can be undefined.
 */
'use strict';

const Module = require('module');
const originalLoad = Module._load;

const vscodeMock = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (_key, def) => def,
    }),
  },
  window: {
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    showWarningMessage: () => {},
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
  },
  extensions: {
    getExtension: () => undefined,
  },
  Uri: {
    joinPath: (base, ...parts) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      toString: () => [base.toString(), ...parts].join('/'),
    }),
    file: (p) => ({ fsPath: p, toString: () => p }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  EventEmitter: class {
    fire() {}
    event = () => ({ dispose: () => {} });
  },
  Disposable: { from: () => ({ dispose: () => {} }) },
  // Used by provider.ts — safe to stub as no-ops
  WebviewView: class {},
  CancellationToken: class {},
};

// Intercept require('vscode') before any test module loads
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
