import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProjectSignal {
  language: string;
  framework: string[];
  projectType: string;
  keywords: string[];
}

const SIGNAL_FILES: Record<string, string> = {
  'package.json': 'javascript',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'Makefile': 'c',
};

const JS_FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  angular: '@angular/core',
  express: 'Express',
  fastify: 'Fastify',
  nestjs: '@nestjs/core',
  electron: 'Electron',
};

const PYTHON_FRAMEWORK_KEYWORDS: Record<string, string> = {
  flask: 'Flask',
  django: 'Django',
  fastapi: 'FastAPI',
  tornado: 'Tornado',
  aiohttp: 'aiohttp',
  streamlit: 'Streamlit',
};

const PROJECT_TYPE_SIGNALS: Record<string, string[]> = {
  'web-frontend': ['react', 'vue', 'angular', 'svelte', 'next', 'nuxt'],
  'web-backend': ['express', 'fastify', 'nestjs', 'flask', 'django', 'fastapi'],
  'mobile': ['react-native', 'expo', 'flutter'],
  'cli': ['commander', 'yargs', 'click', 'typer', 'clap'],
  'library': ['rollup', 'tsup', 'microbundle'],
  'data-science': ['numpy', 'pandas', 'sklearn', 'torch', 'tensorflow'],
};

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return process.cwd();
  return folders[0].uri.fsPath;
}

function detectMonorepo(root: string): boolean {
  const monorepoFiles = ['nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml'];
  return monorepoFiles.some(f => fs.existsSync(path.join(root, f)));
}

export function scanWorkspace(workspacePath?: string): ProjectSignal {
  const root = workspacePath ?? getWorkspaceRoot();
  let language = 'unknown';
  const framework: string[] = [];
  let projectType = 'generic';
  const keywords: string[] = [];

  // Detect primary language
  for (const [file, lang] of Object.entries(SIGNAL_FILES)) {
    if (fs.existsSync(path.join(root, file))) {
      language = lang;
      break;
    }
  }

  // JavaScript/TypeScript deep scan
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };

      // Detect if TypeScript project
      if (allDeps['typescript'] || fs.existsSync(path.join(root, 'tsconfig.json'))) {
        language = 'typescript';
      }

      // Detect frameworks
      for (const [dep, name] of Object.entries(JS_FRAMEWORK_DEPS)) {
        if (allDeps[dep] || allDeps[`@${dep}/core`]) {
          framework.push(name);
        }
      }

      // Detect project type
      for (const [type, signals] of Object.entries(PROJECT_TYPE_SIGNALS)) {
        if (signals.some(s => allDeps[s] !== undefined)) {
          projectType = type;
          break;
        }
      }

      // Add package name as keyword
      if (pkg.name) keywords.push(pkg.name);
    } catch {
      // malformed package.json — continue with defaults
    }
  }

  // Python deep scan
  const reqPath = path.join(root, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    try {
      const reqs = fs.readFileSync(reqPath, 'utf8').toLowerCase();
      for (const [dep, name] of Object.entries(PYTHON_FRAMEWORK_KEYWORDS)) {
        if (reqs.includes(dep)) framework.push(name);
      }
      if (reqs.includes('numpy') || reqs.includes('pandas')) {
        projectType = 'data-science';
        keywords.push('data science');
      }
    } catch { /* continue */ }
  }

  // Rust scan
  const cargoPath = path.join(root, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const cargo = fs.readFileSync(cargoPath, 'utf8');
      if (cargo.includes('tokio')) framework.push('Tokio');
      if (cargo.includes('axum') || cargo.includes('actix-web')) {
        framework.push(cargo.includes('axum') ? 'Axum' : 'Actix-web');
        projectType = 'web-backend';
      }
      if (cargo.includes('clap')) projectType = 'cli';
    } catch { /* continue */ }
  }

  // Go scan
  const goModPath = path.join(root, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const goMod = fs.readFileSync(goModPath, 'utf8');
      if (goMod.includes('gin-gonic/gin')) { framework.push('Gin'); projectType = 'web-backend'; }
      if (goMod.includes('labstack/echo')) { framework.push('Echo'); projectType = 'web-backend'; }
      if (goMod.includes('fiber')) { framework.push('Fiber'); projectType = 'web-backend'; }
    } catch { /* continue */ }
  }

  // Add monorepo keyword
  if (detectMonorepo(root)) keywords.push('monorepo');

  // Ensure language is in keywords
  if (language !== 'unknown' && !keywords.includes(language)) {
    keywords.unshift(language);
  }

  return {
    language,
    framework,
    projectType,
    keywords: [...new Set(keywords)],
  };
}
