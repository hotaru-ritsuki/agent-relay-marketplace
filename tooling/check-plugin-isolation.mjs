import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { existingDirectories, listFiles } from "./lib/fs-walk.mjs";
import { isDirectInvocation } from "./sync-contracts.mjs";

function moduleSpecifierText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression)
        && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = moduleSpecifierText(node.arguments[0]);
        if (specifier !== undefined) specifiers.push(specifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}

function syntaxErrorViolation(file, source) {
  const { diagnostics = [] } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
    },
    fileName: file,
    reportDiagnostics: true,
  });
  const diagnostic = diagnostics.find((item) =>
    item.category === ts.DiagnosticCategory.Error && item.file
  );
  if (!diagnostic) return undefined;

  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const position = diagnostic.start === undefined
    ? ""
    : (() => {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
          diagnostic.start,
        );
        return ` at ${line + 1}:${character + 1}`;
      })();
  return {
    file,
    message: `JavaScript syntax error prevents isolation scan: ${message}${position}`,
  };
}

export function checkPluginIsolation(pluginDir) {
  const root = path.resolve(pluginDir);
  const violations = [];

  for (const file of listFiles(root).filter((item) => {
    const relative = path.relative(root, item).split(path.sep).join("/");
    return /\.(?:mjs|js|cjs)$/.test(item)
      && !relative.startsWith("tests/")
      && !relative.startsWith("tooling/");
  })) {
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const syntaxError = syntaxErrorViolation(file, source);
    if (syntaxError) {
      violations.push(syntaxError);
      continue;
    }

    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      if (!specifier.startsWith(".")) continue;

      const resolved = path.resolve(path.dirname(file), specifier);
      if (!isPathInside(root, resolved)) {
        violations.push({
          file,
          message: `relative import resolves outside plugin: ${specifier}`,
        });
      }
    }
  }

  return violations;
}

if (isDirectInvocation({ moduleUrl: import.meta.url })) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pluginDirs = process.argv.length > 2
    ? process.argv.slice(2)
    : existingDirectories(
        ["cdx-relay", "cursor-relay"].map((name) =>
          path.join(root, "plugins", name)
        )
      );
  const violations = pluginDirs.flatMap(checkPluginIsolation);

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}
