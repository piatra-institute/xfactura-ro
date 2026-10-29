// Validates e-Factura XML against the official artifacts in .validators/ (see fetch.ts):
// the UBL 2.1 schema with xmllint, then each schematron XSLT (CEN EN 16931 and, when
// installed, CIUS-RO) with Saxon-HE. A missing artifact is reported as skipped, never passed.
//   bun scripts/validators/validate.ts [--json report.json] <file-or-directory>...
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import { sourceXml, type XmlElement } from '../../packages/xfactura-core/src/xml/source-xml';

type Finding = { rule: string; flag: string; text: string; location: string };
type Result = { file: string; xsd: string[]; rules: Record<string, Finding[]> };

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? args.splice(jsonIndex, 2)[1] : undefined;
const files = args.flatMap((target) =>
  statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((name) => name.endsWith('.xml'))
        .sort()
        .map((name) => path.join(target, name))
    : [target],
);
if (!files.length)
  throw new Error('usage: validate.ts [--json report.json] <file-or-directory>...');

const validators = path.join(import.meta.dir, '../..', '.validators');
const classpath = ['Saxon-HE-12.7.jar', 'xmlresolver-5.3.3.jar']
  .map((jar) => path.join(validators, 'saxon', jar))
  .join(':');
const results: Result[] = files.map((file) => ({ file, xsd: [], rules: {} }));
const skipped: string[] = [];

// UBL 2.1 schema, one xmllint run per document type.
const schemas = { Invoice: 'UBL-Invoice-2.1.xsd', CreditNote: 'UBL-CreditNote-2.1.xsd' } as const;
const byRoot = new Map<keyof typeof schemas, Result[]>();
for (const result of results) {
  const head = (await readFile(result.file, 'utf8')).slice(0, 4096);
  const root = /<(?:\w+:)?(Invoice|CreditNote)[\s>]/.exec(head)?.[1] as
    keyof typeof schemas | undefined;
  if (!root) result.xsd.push('Rădăcina nu este Invoice sau CreditNote.');
  else byRoot.set(root, [...(byRoot.get(root) ?? []), result]);
}
const xsdDirectory = path.join(validators, 'ubl-2.1/xsd/maindoc');
if (!existsSync(xsdDirectory)) skipped.push('UBL 2.1 XSD');
else
  for (const [root, group] of byRoot) {
    const output =
      await $`xmllint --noout --nonet --schema ${path.join(xsdDirectory, schemas[root])} ${group.map((item) => item.file)}`
        .nothrow()
        .quiet();
    const lines = output.stderr.toString().split('\n');
    for (const result of group)
      result.xsd.push(
        ...lines.filter(
          (line) => line.startsWith(`${result.file}:`) && !line.endsWith(' validates'),
        ),
      );
  }

// Schematron rule sets, each compiled to XSLT; one Saxon run per set over a staged directory.
const ruleSets = [
  { name: 'EN16931', xslt: path.join(validators, 'en16931-ubl/xslt/EN16931-UBL-validation.xslt') },
  ...(existsSync(path.join(validators, 'cius-ro'))
    ? readdirSync(path.join(validators, 'cius-ro'))
        .filter((name) => name.endsWith('.xslt') || name.endsWith('.xsl'))
        .map((name) => ({ name: 'CIUS-RO', xslt: path.join(validators, 'cius-ro', name) }))
    : []),
];
if (!ruleSets.some((set) => set.name === 'CIUS-RO'))
  skipped.push('CIUS-RO (not installed; see scripts/validators/sources.json)');
if (!existsSync(classpath.split(':')[0]!)) skipped.push('Saxon-HE');
const stage = await mkdtemp(path.join(tmpdir(), 'xfactura-validate-'));
try {
  const input = path.join(stage, 'input');
  await $`mkdir -p ${input}`;
  await Promise.all(
    results.map((result, index) => copyFile(result.file, path.join(input, `${index}.xml`))),
  );
  for (const set of ruleSets) {
    if (!existsSync(set.xslt) || skipped.includes('Saxon-HE')) {
      skipped.push(set.name);
      continue;
    }
    const output = path.join(stage, set.name);
    await $`mkdir -p ${output}`;
    await $`java -cp ${classpath} net.sf.saxon.Transform -s:${input} -o:${output} -xsl:${set.xslt}`.quiet();
    for (const [index, result] of results.entries())
      result.rules[set.name] = failures(
        sourceXml(await readFile(path.join(output, `${index}.xml`))),
      );
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}

function failures(report: XmlElement): Finding[] {
  const found: Finding[] = [];
  const walk = (node: XmlElement) => {
    if (node.local === 'failed-assert' || node.local === 'successful-report')
      found.push({
        rule: node.attributes.id ?? '?',
        flag: node.attributes.flag ?? 'fatal',
        text: node.children.find((child) => child.local === 'text')?.text.trim() ?? '',
        location: node.attributes.location ?? '',
      });
    node.children.forEach(walk);
  };
  walk(report);
  return found;
}

const fatal = (result: Result) =>
  result.xsd.length +
  Object.values(result.rules)
    .flat()
    .filter((item) => item.flag === 'fatal').length;
const histogram = new Map<string, number>();
for (const result of results)
  for (const [set, findings] of Object.entries(result.rules))
    for (const rule of new Set(findings.map((item) => `${set} ${item.rule} (${item.flag})`)))
      histogram.set(rule, (histogram.get(rule) ?? 0) + 1);
if (jsonPath) await writeFile(jsonPath, JSON.stringify({ skipped, results }, null, 2) + '\n');

console.log(
  `${results.length} documents; ${results.filter((result) => fatal(result) === 0).length} without schema errors or fatal rule failures.`,
);
console.log(`XSD errors in ${results.filter((result) => result.xsd.length).length} documents.`);
for (const [rule, count] of [...histogram].sort((a, b) => b[1] - a[1]))
  console.log(`  ${rule}: ${count}`);
if (skipped.length) console.log(`Skipped, not passed: ${skipped.join('; ')}.`);
process.exit(results.some((result) => fatal(result) > 0) ? 1 : 0);
