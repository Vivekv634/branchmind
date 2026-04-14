import * as vscode from 'vscode';
import { RouterResult } from './inference/router';

let statusBarItem: vscode.StatusBarItem | null = null;

export function createStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'branchmind.selectModel';
  statusBarItem.show();
  setRules();
  return statusBarItem;
}

export function updateStatusBar(result: RouterResult): void {
  if (!statusBarItem) return;

  if (result.selected) {
    setActive(result.selected.provider.name, result.selected.modelId);
  } else if (result.availableProviders.length > 0) {
    setSelectPrompt();
  } else {
    setRules();
  }
}

export function setOffline(): void {
  if (!statusBarItem) return;
  statusBarItem.text = '$(warning) BranchMind: offline';
  statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBarItem.tooltip = 'Selected LLM provider went offline. Click to re-select a model.';
}

function setActive(providerName: string, modelId: string): void {
  if (!statusBarItem) return;
  statusBarItem.text = `$(circle-filled) ${providerName} / ${modelId}`;
  statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
  statusBarItem.backgroundColor = undefined;
  statusBarItem.tooltip = `BranchMind: using ${modelId} via ${providerName}. Click to change model.`;
}

function setSelectPrompt(): void {
  if (!statusBarItem) return;
  statusBarItem.text = '$(search) BranchMind: select model';
  statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
  statusBarItem.backgroundColor = undefined;
  statusBarItem.tooltip = 'Local LLM providers found. Click to select a model.';
}

function setRules(): void {
  if (!statusBarItem) return;
  statusBarItem.text = '$(circle-outline) BranchMind: rule-based';
  statusBarItem.color = undefined;
  statusBarItem.backgroundColor = undefined;
  statusBarItem.tooltip = 'BranchMind: no local LLM found. Running on rule-based heuristics. Click to re-scan.';
}

export function disposeStatusBar(): void {
  statusBarItem?.dispose();
  statusBarItem = null;
}
