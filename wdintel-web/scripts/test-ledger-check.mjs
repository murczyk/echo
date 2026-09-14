import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { reactTestPackingExceptions } from './react-test-packing-exceptions.mjs';

const webRoot = process.cwd();
const ledger = JSON.parse(
  readFileSync(join(webRoot, '../docs/frontend/react-test-removal-dispositions.json'), 'utf8'),
);
const behaviorContractsRoot = join(webRoot, '../docs/frontend/react-behavior-contracts');
const behaviorContracts = ts.sys
  .readDirectory(behaviorContractsRoot, ['.md'])
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const behaviorIds = new Set(
  [...behaviorContracts.matchAll(/\*\*Behavior ID:\*\* `([^`]+)`/g)].map((match) => match[1]),
);
const forbiddenNonContractualReason = /\b(parser|safeguard|compatibility|regression)\b/i;
const genericReason =
  /^(?:recovered and )?(?:retained as an admitted|user-visible administration|operational parser)/i;

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return callName(expression.expression);
  if (ts.isCallExpression(expression)) return callName(expression.expression);
  return null;
}

function identities(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Set();
  const visit = (node, parents) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const name = callName(node.expression);
      const titles = name === 'describe' ? [...parents, node.arguments[0].text] : parents;
      if (name === 'it' || name === 'test')
        found.add([...parents, node.arguments[0].text].join(' > '));
      ts.forEachChild(node, (child) => visit(child, titles));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, parents));
  };
  visit(source, []);
  return found;
}

const files = [
  ...ts.sys.readDirectory(join(webRoot, 'src/ts/react'), ['.ts', '.tsx']),
  ...ts.sys.readDirectory(join(webRoot, 'tests/e2e'), ['.ts', '.tsx']),
].filter((file) => /\.(?:spec|test)\.tsx?$/.test(file));
const tests = new Map(files.map((file) => [relative(webRoot, file), identities(file)]));
const hasIdentity = (path, identity) => tests.get(path)?.has(identity) === true;
const problems = [];
const recordKey = (file, identity) => `${file}\u0000${identity}`;
const validateBehaviorReference = (entry, label) => {
  if (!entry.behaviorReference || !behaviorIds.has(entry.behaviorReference))
    problems.push(`unresolved behavior reference for ${label}: ${entry.identity ?? entry.id}`);
};
const movedKeys = new Set();
const retainedKeys = new Set();
for (const entry of ledger.removed) {
  if (entry.disposition === 'retained-and-moved') {
    if (!entry.recoveredTestFile || !tests.has(entry.recoveredTestFile))
      problems.push(`missing retained target: ${entry.identity}`);
    else if (!hasIdentity(entry.recoveredTestFile, entry.identity))
      problems.push(`missing retained identity: ${entry.identity}`);
  }
  if (entry.disposition === 'removed' || entry.disposition === 'pending')
    problems.push(`generic or pending disposition: ${entry.identity}`);
  if (entry.disposition === 'removed-documented-behavior') {
    validateBehaviorReference(entry, 'removed record');
  }
  if (entry.disposition === 'removed-non-contractual-detail') {
    if (!entry.reason || genericReason.test(entry.reason))
      problems.push(`missing or generic non-contractual reason: ${entry.identity}`);
    if (forbiddenNonContractualReason.test(entry.reason ?? ''))
      problems.push(`non-contractual reason claims admitted coverage: ${entry.identity}`);
    if (entry.recoveryStatus !== 'audited-removed')
      problems.push(`removed entry is not marked audited-removed: ${entry.identity}`);
  }
  if (entry.disposition === 'retained-and-moved' && entry.recoveredTestFile)
    retainedKeys.add(recordKey(entry.recoveredTestFile, entry.identity));
}
for (const entry of ledger.moved) {
  const key = recordKey(entry.from, entry.identity);
  if (movedKeys.has(key)) problems.push(`duplicate moved ledger key: ${entry.identity}`);
  movedKeys.add(key);
  const finalRemoval = entry.removedInFinalAudit;
  if (finalRemoval === true || typeof finalRemoval === 'boolean')
    problems.push(`bare final-removal flag: ${entry.identity}`);
  if (finalRemoval) {
    if (typeof finalRemoval !== 'object')
      problems.push(`invalid final-removal record: ${entry.identity}`);
    else {
      if (finalRemoval.disposition !== 'removed-documented-behavior' || !finalRemoval.reason)
        problems.push(`incomplete final-removal disposition: ${entry.identity}`);
      validateBehaviorReference(finalRemoval, 'final-removal record');
      if (
        hasIdentity(entry.from, entry.identity) ||
        hasIdentity(entry.to, entry.toIdentity ?? entry.identity)
      )
        problems.push(`finally removed identity still exists: ${entry.identity}`);
    }
  } else if (!tests.has(entry.to) || !hasIdentity(entry.to, entry.toIdentity ?? entry.identity)) {
    problems.push(`invalid moved target: ${entry.identity}`);
  } else {
    retainedKeys.add(recordKey(entry.to, entry.toIdentity ?? entry.identity));
  }
}
const incomingKeys = new Set();
for (const entry of ledger.incoming) {
  const key = recordKey(entry.file, entry.id);
  if (incomingKeys.has(key)) problems.push(`duplicate incoming ledger key: ${entry.id}`);
  incomingKeys.add(key);
  if (!['retained', 'removed'].includes(entry.decision))
    problems.push(`invalid incoming decision: ${entry.id}`);
  if (!entry.reason) problems.push(`missing incoming reason: ${entry.id}`);
  validateBehaviorReference(entry, 'incoming record');
  if (entry.decision === 'retained' && !hasIdentity(entry.file, entry.id))
    problems.push(`invalid incoming retained decision: ${entry.id}`);
  if (entry.decision === 'removed' && hasIdentity(entry.file, entry.id))
    problems.push(`incoming removed identity still exists: ${entry.id}`);
}
for (const path of tests.keys()) {
  if (!path.startsWith('src/ts/react/')) continue;
  const testDirectoryCount = path.split('/').filter((segment) => segment === '__tests__').length;
  if (path.includes('/recovery/') || path.includes('/characterization/'))
    problems.push(`prohibited React test holding directory: ${path}`);
  else if (testDirectoryCount !== 1 && !reactTestPackingExceptions.has(path))
    problems.push(`React spec must have exactly one __tests__ segment: ${path}`);
}
const current = [...tests]
  .filter(([path]) => path.startsWith('src/ts/react/'))
  .reduce((total, [, identities]) => total + identities.size, 0);
for (const [path, fileIdentities] of tests) {
  if (!path.startsWith('src/ts/react/')) continue;
  for (const identity of fileIdentities) {
    const key = recordKey(path, identity);
    if (!retainedKeys.has(key) && !incomingKeys.has(key))
      problems.push(`current identity has no ledger decision: ${path} > ${identity}`);
  }
}
const finalRemovals = ledger.moved.filter((entry) => entry.removedInFinalAudit).length;
const relocated = ledger.moved.filter((entry) => !entry.removedInFinalAudit).length;
if (ledger.inventories.current !== current)
  problems.push(`inventory current is ${ledger.inventories.current}, expected ${current}`);
if (ledger.inventories.incoming !== ledger.incoming.length)
  problems.push(
    `inventory incoming is ${ledger.inventories.incoming}, expected ${ledger.incoming.length}`,
  );
if (ledger.inventories.genuinelyRemoved !== finalRemovals)
  problems.push(
    `inventory genuinelyRemoved is ${ledger.inventories.genuinelyRemoved}, expected ${finalRemovals}`,
  );
if (ledger.inventories.relocated !== relocated)
  problems.push(`inventory relocated is ${ledger.inventories.relocated}, expected ${relocated}`);
if (problems.length) {
  console.error(
    `React test ledger check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`React test ledger check passed (${current} retained AST identities).`);
