import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'backend', 'src', 'services', 'openai.ts');
const outDir = path.join(repoRoot, 'frontend', 'public');
const outPath = path.join(outDir, 'prompts.html');
const watchMode = process.argv.includes('--watch');

const titleMap: Record<string, string> = {
  generateSearchQueriesAndInitialToc: 'Step 1+2: Generate Search Queries and Initial TOC Paths',
  generateSearchQueries: 'Step 1 (compat): Generate Search Queries',
  selectTOCChaptersInitial: 'Step 2 (compat): Select TOC Chapters Initial',
  selectTOCChapters: 'Step 2 (Additional): Select TOC Chapters',
  judgeAnswerability: 'Step 3: Judge Answerability',
  extractElements: 'Step 4+5: Extract Elements and Multi-error Detection',
  detectMultiErrorCodes: 'Step 5 (compat): Detect Multiple Error Codes',
  classifyAnswerPatterns: 'Step 8: Answer Pattern Classification',
  classifyChapters: 'Step 7: Classify Chapters',
  buildFinalAnswerSystemPromptBase: 'Step 8: Final Answer System Prompt (Base)',
  buildPatternSpecificPrompt_single_fault: 'Step 8: Final Answer System Prompt (Pattern: Single Fault)',
  buildPatternSpecificPrompt_assembly: 'Step 8: Final Answer System Prompt (Pattern: Assembly)',
  buildPatternSpecificPrompt_multi_fault: 'Step 8: Final Answer System Prompt (Pattern: Multiple Faults)',
  buildPatternSpecificPrompt_maintenance: 'Step 8: Final Answer System Prompt (Pattern: Maintenance)',
  buildPatternSpecificPrompt_general: 'Step 8: Final Answer System Prompt (Pattern: General)',
  buildConnectorSectionPrompt: 'Step 8: Final Answer System Prompt (Connector Section Add-on)',
  buildManualAnswerGuidance: 'Step 8: Final Answer System Prompt (Manual Integration Add-on)',
  buildMultiErrorAnswerPrompt: 'Step 8: Final Answer System Prompt (Multi-error Add-on)',
  buildFinalAnswerSystemPromptMulti: 'Step 8: Final Answer System Prompt (Multi-error)',
};

const promptOrder = [
  'generateSearchQueriesAndInitialToc',
  'generateSearchQueries',
  'selectTOCChaptersInitial',
  'selectTOCChapters',
  'judgeAnswerability',
  'extractElements',
  'detectMultiErrorCodes',
  'classifyAnswerPatterns',
  'classifyChapters',
  'buildFinalAnswerSystemPromptBase',
  'buildPatternSpecificPrompt_single_fault',
  'buildPatternSpecificPrompt_assembly',
  'buildPatternSpecificPrompt_multi_fault',
  'buildPatternSpecificPrompt_maintenance',
  'buildPatternSpecificPrompt_general',
  'buildConnectorSectionPrompt',
  'buildManualAnswerGuidance',
  'buildMultiErrorAnswerPrompt',
  'buildFinalAnswerSystemPromptMulti',
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractText(node: ts.Node, sourceCode: string, sourceFile: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateLiteral(node)) {
    let text = sourceCode.slice(node.getStart(sourceFile), node.getEnd());
    if (text.startsWith('`') && text.endsWith('`')) {
      text = text.slice(1, -1);
    }
    return text;
  }
  return '';
}

function findTemplateTextInExpression(expr: ts.Expression, sourceCode: string, sourceFile: ts.SourceFile): string {
  if (ts.isTemplateLiteral(expr) || ts.isStringLiteral(expr)) {
    return extractText(expr, sourceCode, sourceFile);
  }
  if (ts.isBinaryExpression(expr)) {
    return (
      findTemplateTextInExpression(expr.right, sourceCode, sourceFile) ||
      findTemplateTextInExpression(expr.left, sourceCode, sourceFile)
    );
  }
  return '';
}

type PromptDoc = { functionName: string; title: string; prompt: string };

function inferPatternPromptKey(prompt: string): string | null {
  if (prompt.includes('Single Fault / One Error Code')) return 'single_fault';
  if (prompt.includes('Assembly / Disassembly')) return 'assembly';
  if (prompt.includes('Multiple Fault Codes')) return 'multi_fault';
  if (prompt.includes('Periodic Maintenance')) return 'maintenance';
  if (prompt.includes('General / Specification')) return 'general';
  return null;
}

function extractPrompts(sourceCode: string): PromptDoc[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceCode, ts.ScriptTarget.Latest, true);
  const prompts: PromptDoc[] = [];

  function visit(node: ts.Node, currentFn: string | null) {
    const prevFn = currentFn;
    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFn = node.name.text;
    } else if (ts.isFunctionExpression(node) && node.name) {
      currentFn = node.name.text;
    }

    // Capture returned system-prompt builders (e.g. buildFinalAnswerSystemPrompt*)
    if (currentFn && ts.isReturnStatement(node) && node.expression) {
      if (
        currentFn.startsWith('buildFinalAnswerSystemPrompt') ||
        currentFn === 'buildMultiErrorAnswerPrompt' ||
        currentFn === 'buildPatternSpecificPrompt' ||
        currentFn === 'buildConnectorSectionPrompt' ||
        currentFn === 'buildManualAnswerGuidance'
      ) {
        const text = findTemplateTextInExpression(node.expression, sourceCode, sourceFile);
        if (text) {
          const patternKey = currentFn === 'buildPatternSpecificPrompt' ? inferPatternPromptKey(text) : null;
          const titleKey = currentFn === 'buildPatternSpecificPrompt' && patternKey
            ? `${currentFn}_${patternKey}`
            : currentFn;
          prompts.push({
            functionName: titleKey,
            title: titleMap[titleKey] || titleMap[currentFn] || currentFn,
            prompt: text,
          });
        }
      }
    }

    // Capture role: system content strings inside chatJson calls
    if (ts.isObjectLiteralExpression(node)) {
      let roleText: string | null = null;
      let contentNode: ts.Node | null = null;

      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text === 'role') {
          roleText = extractText(prop.initializer, sourceCode, sourceFile) || null;
        } else if (prop.name.text === 'content') {
          contentNode = prop.initializer;
        }
      }

      if (currentFn && contentNode && (roleText === 'system' || roleText === 'user')) {
        const promptText = extractText(contentNode, sourceCode, sourceFile);
        if (promptText) {
          const baseTitle = titleMap[currentFn] || currentFn;
          const title = `${baseTitle} (${roleText === 'system' ? 'System Prompt' : 'User Prompt'})`;
          prompts.push({
            functionName: currentFn,
            title,
            prompt: promptText,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentFn));
    currentFn = prevFn;
  }

  visit(sourceFile, null);
  return prompts;
}

function generateHtml() {
  const sourceCode = fs.readFileSync(sourcePath, 'utf8');
  const prompts = extractPrompts(sourceCode).sort(
    (a, b) => promptOrder.indexOf(a.functionName) - promptOrder.indexOf(b.functionName)
  );
  const generatedAt = new Date().toISOString();

  const sections = prompts
    .map(
      (p) => `
  <section id="${p.functionName}" class="mb-10 scroll-mt-20">
    <div class="flex items-baseline justify-between mb-3">
      <h2 class="text-xl font-semibold text-neutral-900">${escapeHtml(p.title)}</h2>
      <span class="text-xs font-mono text-neutral-500">${escapeHtml(p.functionName)}</span>
    </div>
    <div class="relative rounded-lg border border-neutral-200 bg-neutral-50">
      <button onclick="copySection('${p.functionName}')" class="absolute top-2 right-2 rounded-md bg-white px-2 py-1 text-xs font-medium text-neutral-600 shadow-sm border border-neutral-200 hover:bg-neutral-100">Copy</button>
      <pre class="overflow-x-auto p-4 text-sm leading-relaxed text-neutral-800 whitespace-pre-wrap"><code id="code-${p.functionName}">${escapeHtml(p.prompt)}</code></pre>
    </div>
  </section>
`
    )
    .join('\n');

  const toc = prompts
    .map(
      (p) => `
            <li>
              <a href="#${p.functionName}" class="block rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900">${escapeHtml(p.title)}</a>
            </li>`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>System Prompts</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-white text-neutral-900">
  <div class="max-w-5xl mx-auto px-6 py-10">
    <header class="mb-8 pb-6 border-b border-neutral-200">
      <h1 class="text-3xl font-bold tracking-tight">System Prompts</h1>
      <p class="mt-2 text-neutral-600">Extracted from <code class="text-sm bg-neutral-100 px-1 py-0.5 rounded">backend/src/services/openai.ts</code></p>
      <p class="mt-1 text-xs text-neutral-400">Generated at ${generatedAt}</p>
    </header>

    <div class="flex flex-col lg:flex-row gap-8">
      <nav class="lg:w-64 shrink-0">
        <div class="sticky top-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          <h3 class="mb-3 text-sm font-semibold text-neutral-900 uppercase tracking-wider">Timings</h3>
          <ul class="space-y-1">
            ${toc}
          </ul>
        </div>
      </nav>

      <main class="flex-1 min-w-0">
        ${sections}
      </main>
    </div>
  </div>

  <script>
    function copySection(functionName) {
      const code = document.getElementById('code-' + functionName).innerText;
      navigator.clipboard.writeText(code).then(() => {
        const btn = document.querySelector('#' + functionName + ' button');
        const original = btn.innerText;
        btn.innerText = 'Copied';
        setTimeout(() => btn.innerText = original, 1200);
      });
    }
  </script>
</body>
</html>`;

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`Generated ${outPath} (${prompts.length} prompts)`);
}

try {
  generateHtml();

  if (watchMode) {
    console.log(`Watching ${sourcePath} for changes...`);
    fs.watchFile(sourcePath, { interval: 1000 }, () => {
      console.log('Source changed, regenerating...');
      generateHtml();
    });
  }
} catch (err) {
  console.error('Failed to generate prompt docs:', err);
  process.exit(1);
}
