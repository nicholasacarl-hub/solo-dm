#!/usr/bin/env node
/**
 * build-srd.mjs: converts the System Reference Document 5.2.1 into the JSON the app loads from
 * public/srd/.
 *
 * Sources (scripts/fetch-srd-sources.sh pins both commits):
 *   your5e/5e-srd-markdown  dnd/521/markdown/ - a faithful SRD 5.2.1 Markdown copy, one topic per file.
 *                           All display text comes from here.
 *   open5e/open5e-api       data/v2/wizards-of-the-coast/srd-2024/ - Django fixtures with structured
 *                           fields (spell saves, damage and scaling, class level tables). Merged in and
 *                           cross-checked against the Markdown; only document "srd-2024" is read.
 * Both carry SRD content licensed CC-BY-4.0. Open5e artwork is not used.
 *
 * Outputs (byte-for-byte deterministic except manifest.generatedAt):
 *   public/srd/compendium.json  CompendiumEntry[] - rules sections, conditions, spells, monsters, items...
 *   public/srd/builder.json     BuilderData for the character builder
 *   public/srd/manifest.json    version, counts, attribution, sources
 *
 * Usage:
 *   node scripts/build-srd.mjs [--sources DIR] [--your5e DIR] [--open5e DIR] [--out DIR] [--date YYYY-MM-DD]
 *   SRD_SOURCES_DIR=DIR node scripts/build-srd.mjs
 * DIR defaults to ./.srd-sources (the layout fetch-srd-sources.sh creates: DIR/your5e-srd-markdown and
 * DIR/open5e-api). Source files are only read as data; nothing from them is executed.
 *
 * Uses only Node built-ins (Node 22+).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const SRD_SOURCE_ID = 'srd-5.2.1';
export const SRD_SOURCE_NAME = 'SRD 5.2.1';
export const SRD_VERSION = '5.2.1';
export const MODIFICATIONS = 'Converted to JSON, split into entries, summaries added.';

export const PINNED_SOURCES = {
  your5e: {
    name: 'your5e/5e-srd-markdown',
    url: 'https://github.com/your5e/5e-srd-markdown',
    commit: 'f1f5060fd975aa2ffc3e4b336560ded479934d80',
  },
  open5e: {
    name: 'open5e/open5e-api',
    url: 'https://github.com/open5e/open5e-api',
    commit: 'bdcddf2b5f7995c42ac89722d8da563346b6744a',
  },
};

/** Counts the SRD 5.2.1 is known to contain; a build far off these fails. */
export const EXPECTED_COUNTS = {
  spell: 339,
  monster: 330,
  'magic-item': 258,
  class: 12,
  species: 9,
  background: 4,
  feat: 17,
  condition: 15,
};

const ABILITY_BY_NAME = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};
const ABILITY_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SKILLS = {
  acrobatics: 'Acrobatics',
  'animal-handling': 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  'sleight-of-hand': 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};
const SKILL_BY_KEY = new Map(Object.entries(SKILLS).map(([id, name]) => [compactKey(name), id]));

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** XP by Challenge Rating (SRD 5.2.1 "Monsters"), used only when a stat block omits it. */
const XP_BY_CR = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900,
  8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000,
  17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000,
  25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000,
};

/**
 * Conversion slips in the your5e Markdown (PDF line breaks inside table cells, one stray typo).
 * Fixed so names parse and read correctly; every pattern matches only the broken spelling.
 */
const TEXT_FIXES = [
  [/\bNa ture\b/g, 'Nature'],
  [/\bIn sight,/g, 'Insight,'],
  [/\bPersua sion\b/g, 'Persuasion'],
  [/\bAthlet ics\b/g, 'Athletics'],
  [/\bAth letics\b/g, 'Athletics'],
  [/\bInvesti gation\b/g, 'Investigation'],
  [/\bAr mor\b/g, 'Armor'],
  [/\bAr rows\b/g, 'Arrows'],
  [/\bAr cane\b/g, 'Arcane'],
  [/\bJav elins\b/g, 'Javelins'],
  [/\bEn tertainer's\b/g, "Entertainer's"],
  [/\bFo cus\b/g, 'Focus'],
  [/\bun known\b/g, 'unknown'],
  [/\bmu sical\b/g, 'musical'],
  [/\bcrea tures\b/g, 'creatures'],
  [/\bwwizareapon\b/g, 'weapon'],
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a, b) => a.name.localeCompare(b.name, 'en') || byCodePoint(a.name, b.name);

/** Same algorithm as src/lib/id.ts `slugify`, so ids built here and in the app agree. */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Letters and digits only, for matching names across sources ("Antipathy/Sympathy" = "antipathysympathy"). */
export function compactKey(text) {
  return slugify(text).replace(/-/g, '');
}

/** "Rage Damage" -> "rageDamage". */
export function camelKey(label) {
  const words = label.replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Drop undefined values so JSON output stays compact and key order stays as written. */
function compactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

class Report {
  warnings = [];
  warn(scope, message) {
    this.warnings.push(`${scope}: ${message}`);
  }
}

class IdRegistry {
  used = new Set();
  /** Claim the first free `srd:<kind>:<candidate>`, falling back to numbered suffixes. */
  claim(kind, candidates) {
    const options = candidates.filter(Boolean);
    for (const c of options) {
      const id = `srd:${kind}:${c}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    for (let n = 2; ; n++) {
      const id = `srd:${kind}:${options[0]}-${n}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

export function normalizeMarkdown(src) {
  const lines = src
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function applyTextFixes(text) {
  let out = text;
  for (const [pattern, replacement] of TEXT_FIXES) out = out.replace(pattern, replacement);
  return out;
}

const isTableLine = (line) => /^\s*\|/.test(line);

export function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isSeparatorRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

/** Remove the column padding of Markdown tables (it renders the same and saves a lot of bytes). */
export function compactTables(md) {
  return md
    .split('\n')
    .map((line) => {
      if (!isTableLine(line)) return line;
      const cells = splitRow(line);
      if (isSeparatorRow(cells)) {
        return `|${cells.map((c) => `${c.startsWith(':') ? ':' : ''}---${c.length > 1 && c.endsWith(':') ? ':' : ''}`).join('|')}|`;
      }
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
}

/** Every GFM table in a Markdown string: header cells and body rows. */
export function parseTables(md) {
  const lines = md.split('\n');
  const tables = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]) || !isTableLine(lines[i + 1]) || !isSeparatorRow(splitRow(lines[i + 1]))) continue;
    const header = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) rows.push(splitRow(lines[j]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

export function unescapeMarkdown(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}

/** Plain text of an inline Markdown fragment (SRD names never contain literal * or _). */
export function stripInline(text) {
  return unescapeMarkdown(text.replace(/[*_]/g, '')).replace(/\s+/g, ' ').trim();
}

const cleanHeading = (title) => stripInline(title);

/** Parse ATX headings into a tree: { level, title, lines (own body), children }. */
export function parseSections(md) {
  const root = { level: 0, title: '', lines: [], children: [] };
  const stack = [root];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!m) {
      stack[stack.length - 1].lines.push(line);
      continue;
    }
    const node = { level: m[1].length, title: m[2].trim(), lines: [], children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

export const bodyOf = (node) => node.lines.join('\n').trim();

/**
 * A section's text with its descendants. The section's own heading is left out (entries carry it
 * as `name`); descendant headings are re-leveled so children start at ###.
 */
export function renderSubtree(node, depth = 0) {
  const parts = [];
  if (depth > 0) parts.push(`${'#'.repeat(Math.min(6, depth + 2))} ${node.title}`);
  const body = bodyOf(node);
  if (body) parts.push(body);
  for (const child of node.children) parts.push(renderSubtree(child, depth + 1));
  return parts.join('\n\n').trim();
}

/** Split on a separator, ignoring separators inside parentheses. */
export function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Bullets of the form "- **Label:** value" (or "- **Label** value") in a block of Markdown. */
export function boldBullets(md) {
  const out = new Map();
  for (const m of md.matchAll(/^- \*\*([^*]+?):?\*\*:? (.+)$/gm)) out.set(m[1].replace(/:$/, '').trim(), m[2].trim());
  return out;
}

/** "Choose A or B:" style key/value tables (first column = label). */
function keyValueTable(md) {
  const table = parseTables(md)[0];
  if (!table) return new Map();
  return new Map([table.header, ...table.rows].map((row) => [stripInline(row[0]), row.slice(1).join(' | ').trim()]));
}

/** "1 SP" -> 0.1, "1,500 GP" -> 1500, "Varies" -> undefined. */
export function parseCostGp(text) {
  const m = /^([\d,]+(?:\.\d+)?)\s*(CP|SP|EP|GP|PP)\b/i.exec((text ?? '').trim());
  if (!m) return undefined;
  const rate = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 }[m[2].toLowerCase()];
  return round(Number(m[1].replace(/,/g, '')) * rate);
}

/** "2 lb." -> 2, "1/4 lb." -> 0.25, "58 1/2 lb." -> 58.5, "—" -> undefined. */
export function parseWeightLb(text) {
  const m = /^(?:(\d[\d,]*)(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+))\s*lb\b/i.exec((text ?? '').trim());
  if (!m) return undefined;
  if (m[4]) return round(Number(m[4]) / Number(m[5]));
  const whole = Number(m[1].replace(/,/g, ''));
  return round(m[2] ? whole + Number(m[2]) / Number(m[3]) : whole);
}

const crToNumber = (cr) => (cr.includes('/') ? Number(cr.split('/')[0]) / Number(cr.split('/')[1]) : Number(cr));

export function proficiencyBonusForCr(cr) {
  return cr < 5 ? 2 : Math.min(9, 2 + Math.ceil((cr - 4) / 4));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function prepareMarkdown(src) {
  return compactTables(applyTextFixes(normalizeMarkdown(src)));
}

/** Every .md file below `dir`, keyed by forward-slash relative path (symlinks are skipped). */
function loadMarkdownDir(dir) {
  const files = new Map();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort(byCodePoint)) {
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(path.join(dir, relPath));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(relPath);
      else if (stat.isFile() && name.endsWith('.md')) {
        files.set(relPath, prepareMarkdown(fs.readFileSync(path.join(dir, relPath), 'utf8')));
      }
    }
  };
  walk('');
  return files;
}

class MarkdownSource {
  constructor(files) {
    this.files = files;
  }
  /** Relative paths below a folder, optionally including subfolders. */
  list(folder, { recursive = false } = {}) {
    const prefix = `${folder}/`;
    return [...this.files.keys()].filter(
      (p) => p.startsWith(prefix) && (recursive || !p.slice(prefix.length).includes('/')),
    );
  }
  doc(relPath) {
    const text = this.files.get(relPath);
    if (text === undefined) throw new Error(`Missing source file: ${relPath}`);
    const root = parseSections(text);
    const h1 = root.children.find((n) => n.level === 1);
    if (!h1) throw new Error(`No "# Title" heading in ${relPath}`);
    return { text, h1, title: cleanHeading(h1.title) };
  }
}

/** Open5e fixtures of the srd-2024 document (plus children of srd-2024 records). */
class Open5eSource {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
  }
  rows(model) {
    if (!this.cache.has(model)) {
      const file = path.join(this.dir, `${model}.json`);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error(`${file}: expected a list of fixtures`);
      const rows = parsed.filter((r) => {
        const f = r?.fields;
        if (!f || typeof f !== 'object') return false;
        if (f.document !== undefined) return f.document === 'srd-2024';
        return typeof f.parent === 'string' && f.parent.startsWith('srd-2024_');
      });
      this.cache.set(model, rows);
    }
    return this.cache.get(model);
  }
  /** Rows of a model keyed by compactKey(fields.name). */
  byName(model) {
    return new Map(this.rows(model).map((r) => [compactKey(String(r.fields.name ?? '')), r]));
  }
  childrenOf(model) {
    const out = new Map();
    for (const r of this.rows(model)) {
      const list = out.get(r.fields.parent) ?? [];
      list.push(r);
      out.set(r.fields.parent, list);
    }
    return out;
  }
}

/** Read the checked-out commit from .git without running git (the clones are untrusted data). */
function readGitCommit(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const gitDir = path.join(dir, '.git');
    if (exists(path.join(gitDir, 'HEAD'))) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
      const ref = /^ref: (.+)$/.exec(head)?.[1];
      if (!ref) return null;
      const loose = path.join(gitDir, ...ref.split('/'));
      if (exists(loose)) return fs.readFileSync(loose, 'utf8').trim();
      const packed = path.join(gitDir, 'packed-refs');
      if (exists(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(' ');
          if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
        }
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveYour5e(dir) {
  for (const candidate of [path.join(dir, 'dnd', '521', 'markdown'), path.join(dir, 'markdown'), dir]) {
    if (exists(path.join(candidate, 'Spells')) && exists(path.join(candidate, 'Monsters'))) {
      const single = path.join(path.dirname(candidate), 'SRD_CC_v5.2.1.md');
      return { markdownDir: candidate, singleFile: exists(single) ? single : null };
    }
  }
  throw new Error(`Can't find the your5e SRD 5.2.1 Markdown (dnd/521/markdown) under ${dir}`);
}

function resolveOpen5e(dir) {
  for (const candidate of [path.join(dir, 'data', 'v2', 'wizards-of-the-coast', 'srd-2024'), dir]) {
    if (exists(path.join(candidate, 'Spell.json'))) return candidate;
  }
  throw new Error(`Can't find the Open5e srd-2024 fixtures (data/v2/wizards-of-the-coast/srd-2024) under ${dir}`);
}

/** Heading positions in the single-file SRD, used to keep rules files in book order. */
function bookOrder(singleText) {
  const order = new Map();
  if (!singleText) return order;
  let i = 0;
  for (const line of singleText.split('\n')) {
    const m = /^#{1,3} (.+)$/.exec(line);
    if (!m) continue;
    const title = cleanHeading(m[1]);
    if (!order.has(title)) order.set(title, i);
    i++;
  }
  return order;
}

/** Stat-block group headings ("Goblins", "Animals") from the single-file SRD's Monsters A-Z. */
function monsterGroups(singleText) {
  const groups = new Map();
  if (!singleText) return groups;
  let inChapter = false;
  let h2 = null;
  for (const line of singleText.split('\n')) {
    const m = /^(#{1,3}) (.+)$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const title = cleanHeading(m[2]);
    if (level === 1) {
      inChapter = title === 'Monsters A-Z';
    } else if (inChapter && level === 2) {
      h2 = title;
    } else if (inChapter && level === 3 && h2 && h2 !== title) {
      groups.set(title, h2);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function makeEntry({ id, kind, name, summary, text, path: entryPath, data }) {
  return compactObject({
    id,
    sourceId: SRD_SOURCE_ID,
    sourceName: SRD_SOURCE_NAME,
    kind,
    name,
    summary,
    text,
    path: entryPath,
    data: data && Object.keys(data).length ? compactObject(data) : undefined,
  });
}

const MAX_RULE_CHARS = 2500;
const MIN_RULE_BODY = 20;

/**
 * Rules sections of a heading subtree: a section small enough (or without subsections) is one
 * entry; a larger one becomes its own intro text plus one entry per subsection, recursively.
 */
export function ruleSections(node, ancestors, maxChars = MAX_RULE_CHARS) {
  const name = cleanHeading(node.title);
  const here = [...ancestors, name];
  const full = renderSubtree(node);
  if (!node.children.length || full.length <= maxChars) return full ? [{ name, path: here, text: full }] : [];
  const out = [];
  const own = bodyOf(node);
  if (own.length >= MIN_RULE_BODY) out.push({ name, path: here, text: own });
  for (const child of node.children) out.push(...ruleSections(child, here, maxChars));
  return out;
}

const breadcrumb = (p) => p.slice(0, -1).join(' › ') || undefined;

/** Path parts for an id, without a part the next one repeats ("Wizard", "Wizard Spell List"). */
const idParts = (parts) => parts.filter((p, i) => !(i + 1 < parts.length && parts[i + 1].startsWith(p)));

function ruleEntry(section, ids, { kind = 'rule', summary, data } = {}) {
  const tail = section.path.length > 1 ? section.path.slice(1) : section.path;
  const id = ids.claim(kind, [slugify(idParts(tail).join(' ')), slugify(idParts(section.path).join(' '))]);
  return makeEntry({
    id,
    kind,
    name: section.name,
    summary: summary ?? breadcrumb(section.path),
    text: section.text,
    path: section.path,
    data,
  });
}

/** Rules entries for one Markdown file belonging to `chapter`. */
function docRuleSections(md, relPath, chapter, { ancestors, maxChars } = {}) {
  const { h1, title } = md.doc(relPath);
  return ruleSections(h1, ancestors ?? (title === chapter ? [] : [chapter]), maxChars);
}

function sortByBook(md, relPaths, order) {
  const pos = (p) => order.get(md.doc(p).title) ?? Number.MAX_SAFE_INTEGER;
  return [...relPaths].sort((a, b) => pos(a) - pos(b) || byCodePoint(a, b));
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

const SPELL_SUBTITLE = /^_(?:Level ([1-9]) ([A-Z][a-z]+)|([A-Z][a-z]+) Cantrip) \(([^)]*)\)_$/;

function buildSpells(ctx) {
  const { md, o5, report } = ctx;
  const records = o5.byName('Spell');
  const scaling = o5.childrenOf('SpellCastingOption');
  const classNames = new Map(o5.rows('CharacterClass').map((r) => [r.pk, r.fields.name]));
  const entries = [];
  for (const relPath of md.list('Spells', { recursive: true }).filter((p) => p.split('/').length === 3)) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const subtitle = text.split('\n')[0].trim();
    const m = SPELL_SUBTITLE.exec(subtitle);
    if (!m) throw new Error(`${relPath}: unrecognized spell subtitle "${subtitle}"`);
    const level = m[1] ? Number(m[1]) : 0;
    const school = m[2] ?? m[3];
    const classes = m[4].split(/,\s*/).filter(Boolean);
    const stats = boldBullets(text);
    const castingRaw = stats.get('Casting Time') ?? '';
    const duration = stats.get('Duration') ?? '';
    const recRow = records.get(compactKey(title));
    const rec = recRow?.fields;
    if (!rec) report.warn('spells', `${title}: not in Open5e`);
    const ritual = / or Ritual$/.test(castingRaw);
    const concentration = /^Concentration\b/i.test(duration);
    if (rec) crossCheckSpell(report, title, { level, school, classes, ritual, concentration }, rec, classNames);
    const data = {
      level,
      school,
      classes,
      ritual,
      concentration,
      castingTime: castingRaw.replace(/ or Ritual$/, ''),
      range: stats.get('Range'),
      components: stats.get('Components'),
      duration,
      saveAbility: rec?.saving_throw_ability ? ABILITY_BY_NAME[rec.saving_throw_ability] : undefined,
      attackRoll: rec?.attack_roll || undefined,
      damage: rec?.damage_roll || undefined,
      damageTypes: rec?.damage_types?.length ? rec.damage_types : undefined,
      area: rec?.shape_type ? compactObject({ shape: rec.shape_type, size: rec.shape_size ?? undefined }) : undefined,
      materialCostGp: rec?.material_cost ? Number(rec.material_cost) : undefined,
      materialConsumed: rec?.material_consumed || undefined,
      ...spellScaling(recRow ? scaling.get(recRow.pk) : undefined),
    };
    const summary =
      level === 0 ? `${school} cantrip · ${classes.join(', ')}` : `Level ${level} ${school} · ${classes.join(', ')}`;
    entries.push({ name: title, summary, text, data });
  }
  return entries.sort(byName).map((e) =>
    makeEntry({ id: ctx.ids.claim('spell', [slugify(e.name)]), kind: 'spell', ...e }),
  );
}

function crossCheckSpell(report, title, parsed, rec, classNames) {
  if (rec.level !== parsed.level) report.warn('spells', `${title}: level ${parsed.level} (Open5e ${rec.level})`);
  if (rec.school !== parsed.school.toLowerCase()) report.warn('spells', `${title}: school ${parsed.school} (Open5e ${rec.school})`);
  const theirs = (rec.classes ?? []).map((c) => classNames.get(c) ?? c).sort();
  if (theirs.join(',') !== [...parsed.classes].sort().join(',')) {
    report.warn('spells', `${title}: classes ${parsed.classes.join(', ')} (Open5e ${theirs.join(', ')})`);
  }
  if (Boolean(rec.ritual) !== parsed.ritual) report.warn('spells', `${title}: ritual ${parsed.ritual} (Open5e ${rec.ritual})`);
  if (Boolean(rec.concentration) !== parsed.concentration) {
    report.warn('spells', `${title}: concentration ${parsed.concentration} (Open5e ${rec.concentration})`);
  }
}

/** Damage at higher slot levels / character levels from Open5e SpellCastingOption rows. */
function spellScaling(options) {
  const bySlot = {};
  const byCharacterLevel = {};
  for (const o of options ?? []) {
    if (!o.fields.damage_roll) continue;
    const slot = /^slot_level_(\d)$/.exec(o.fields.type);
    const player = /^player_level_(\d+)$/.exec(o.fields.type);
    if (slot) bySlot[slot[1]] = o.fields.damage_roll;
    if (player) byCharacterLevel[player[1]] = o.fields.damage_roll;
  }
  const sorted = (obj) =>
    Object.keys(obj).length
      ? Object.fromEntries(Object.entries(obj).sort((a, b) => Number(a[0]) - Number(b[0])))
      : undefined;
  return { damageBySlotLevel: sorted(bySlot), damageByCharacterLevel: sorted(byCharacterLevel) };
}

// ---------------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------------

const SIZE_RE = SIZES.join('|');
const MONSTER_DESCRIPTOR = new RegExp(
  `^(${SIZE_RE})(?: or (${SIZE_RE}))? (?:Swarm of (?:${SIZE_RE}) ([A-Za-z]+)|([A-Za-z]+))(?: \\(([^)]*)\\))?$`,
);
const CR_LINE = /^(\d+(?:\/\d+)?) \((?:XP ([\d,]+)|([\d,]+) XP)(?:,? or ([\d,]+) in lair)?; PB \+(\d+)\)$/;

function parseSpeeds(speed) {
  const out = {};
  for (const part of splitTopLevel(speed, ',')) {
    const m = /^(?:(Walk|Burrow|Climb|Fly|Swim) )?(\d+) ft\.(?: \((hover)\))?/i.exec(part);
    if (!m) continue;
    const key = (m[1] ?? 'walk').toLowerCase();
    if (out[key] === undefined) out[key] = Number(m[2]);
    if (m[3]) out.hover = true;
  }
  return out;
}

function parseAbilityTable(text) {
  const table = parseTables(text).find((t) => t.header.some((h) => /^Str\.?$/.test(h)));
  if (!table) return null;
  const cols = table.header.map((h) => ABILITY_IDS.find((a) => h.toLowerCase().startsWith(a)));
  const row = (label) => table.rows.find((r) => stripInline(r[0]).toLowerCase() === label);
  const read = (r) => {
    if (!r) return undefined;
    const out = {};
    cols.forEach((a, i) => {
      if (a) out[a] = Number(r[i].replace('−', '-').replace('+', ''));
    });
    return out;
  };
  return { scores: read(row('score')), saves: read(row('saving throw')) };
}

function buildMonsters(ctx) {
  const { md, o5, report, groups } = ctx;
  const records = o5.byName('Creature');
  const entries = [];
  const mismatches = [];
  for (const relPath of md.list('Monsters')) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const subtitle = text.split('\n')[0].trim();
    const sm = /^_(.+), ([^,]+)_$/.exec(subtitle);
    const dm = sm ? MONSTER_DESCRIPTOR.exec(sm[1]) : null;
    if (!sm || !dm) throw new Error(`${relPath}: unrecognized stat block subtitle "${subtitle}"`);
    const stats = boldBullets(text);
    const cr = CR_LINE.exec(stats.get('CR') ?? '');
    if (!cr) throw new Error(`${relPath}: unrecognized CR line "${stats.get('CR')}"`);
    const crValue = crToNumber(cr[1]);
    const xp = Number((cr[2] ?? cr[3]).replace(/,/g, ''));
    const hp = /^(\d+) \(([^)]+)\)$/.exec(stats.get('HP') ?? '');
    const ac = /^(\d+)/.exec(stats.get('AC') ?? '');
    if (!hp || !ac) throw new Error(`${relPath}: missing AC or HP`);
    const rec = records.get(compactKey(title))?.fields;
    if (!rec) report.warn('monsters', `${title}: not in Open5e`);
    const init = /^([+-−]\d+)/.exec(stats.get('Initiative') ?? '');
    let initiative = init ? Number(init[1].replace('−', '-')) : undefined;
    if (initiative === undefined && typeof rec?.initiative_bonus === 'number') {
      initiative = rec.initiative_bonus;
      report.warn('monsters', `${title}: no Initiative line in the Markdown; used Open5e (${initiative})`);
    }
    const abilities = parseAbilityTable(text);
    if (!abilities?.scores) throw new Error(`${relPath}: missing ability table`);
    const type = dm[3] ? dm[3].replace(/s$/, '') : dm[4];
    const senses = stats.get('Senses');
    const parsed = {
      cr: cr[1],
      crValue,
      xp,
      xpInLair: cr[4] ? Number(cr[4].replace(/,/g, '')) : undefined,
      pb: Number(cr[5]),
      size: dm[1],
      type,
      swarm: dm[3] ? true : undefined,
      tags: dm[5] ? dm[5].split(/,\s*/) : undefined,
      alignment: sm[2],
      ac: Number(ac[1]),
      hp: Number(hp[1]),
      hitDice: hp[2],
      speed: stats.get('Speed'),
      speeds: parseSpeeds(stats.get('Speed') ?? ''),
      initiative,
      abilities: abilities.scores,
      savingThrows: abilities.saves,
      skills: stats.get('Skills'),
      vulnerabilities: stats.get('Vulnerabilities'),
      resistances: stats.get('Resistances'),
      immunities: stats.get('Immunities'),
      gear: stats.get('Gear'),
      senses,
      passivePerception: senses ? Number(/Passive Perception (\d+)/.exec(senses)?.[1]) || undefined : undefined,
      languages: stats.get('Languages'),
      legendary: /^### Legendary Actions$/m.test(text) || undefined,
      group: groups.get(title),
    };
    if (XP_BY_CR[crValue] !== undefined && crValue > 0 && XP_BY_CR[crValue] !== xp) {
      report.warn('monsters', `${title}: XP ${xp} differs from the CR ${cr[1]} table (${XP_BY_CR[crValue]})`);
    }
    if (rec) mismatches.push(...crossCheckMonster(title, parsed, rec));
    const descriptor = dm[3] ? sm[1] : `${dm[1]}${dm[2] ? ` or ${dm[2]}` : ''} ${dm[4]}`;
    const summary = `CR ${cr[1]} (${xp.toLocaleString('en-US')} XP) · ${descriptor}`;
    entries.push({ name: title, summary, text, data: parsed });
  }
  for (const m of mismatches) report.warn('monsters', `${m} (kept the Markdown value)`);
  return entries.sort(byName).map((e) =>
    makeEntry({ id: ctx.ids.claim('monster', [slugify(e.name)]), kind: 'monster', ...e }),
  );
}

function crossCheckMonster(title, parsed, rec) {
  const out = [];
  const cmp = (label, mine, theirs) => {
    if (theirs === null || theirs === undefined) return;
    if (String(mine) !== String(theirs)) out.push(`${title}: ${label} ${mine} vs Open5e ${theirs}`);
  };
  cmp('AC', parsed.ac, rec.armor_class);
  cmp('HP', parsed.hp, rec.hit_points);
  cmp('hit dice', parsed.hitDice.replace(/\s+/g, ''), String(rec.hit_dice ?? '').replace(/\s+/g, ''));
  cmp('CR', parsed.crValue, rec.challenge_rating === null ? null : Number(rec.challenge_rating));
  for (const a of ABILITY_IDS) {
    const name = Object.keys(ABILITY_BY_NAME).find((n) => ABILITY_BY_NAME[n] === a);
    cmp(a.toUpperCase(), parsed.abilities[a], rec[`ability_score_${name}`]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Magic items
// ---------------------------------------------------------------------------

const RARITY_WORDS = /\b(Very Rare|Uncommon|Common|Rare|Legendary|Artifact|Rarity Varies)\b/g;
const MAGIC_ITEM_CATEGORY = {
  'wondrous item': 'wondrous-item',
  weapon: 'weapon',
  armor: 'armor',
  ring: 'ring',
  rod: 'rod',
  staff: 'staff',
  wand: 'wand',
  potion: 'potion',
  scroll: 'scroll',
};
const MAGIC_ITEM_RULE_FILES = new Set([
  'Magic Items.md',
  'Magic Item Rules.md',
  'Magic Item Rarity.md',
  'Activating a Magic Item.md',
  'Cursed Items.md',
  'Magic Item Resilience.md',
  'Crafting Magic Items.md',
  'Sentient Magic Items.md',
  'The Next Dawn.md',
]);

export function parseMagicItemSubtitle(subtitle) {
  const inner = subtitle.replace(/^_|_$/g, '').trim();
  const parts = splitTopLevel(inner, ',');
  const categoryText = parts[0];
  let rest = inner.slice(inner.indexOf(categoryText) + categoryText.length).replace(/^,\s*/, '');
  const att = /\s*\((Requires Attunement(?: [^)]*)?)\)/.exec(rest);
  if (att) rest = (rest.slice(0, att.index) + rest.slice(att.index + att[0].length)).trim();
  const base = /^([^(]+?)(?: \(([^)]*)\))?$/.exec(categoryText);
  const category = MAGIC_ITEM_CATEGORY[(base?.[1] ?? categoryText).toLowerCase()];
  const rarities = [...rest.matchAll(RARITY_WORDS)].map((m) => m[1].toLowerCase());
  const unique = [...new Set(rarities)];
  return {
    categoryText,
    category,
    baseItem: base?.[2],
    rarityText: rest,
    rarity: unique.length === 1 && unique[0] !== 'rarity varies' ? unique[0] : 'varies',
    attunement: att ? att[1].replace(/^Requires Attunement\s*/, '') || true : false,
  };
}

function magicItemSummary(info) {
  const rarity = info.rarityText.replace(RARITY_WORDS, (w) => w.toLowerCase());
  const attunement = info.attunement
    ? ` (requires attunement${info.attunement === true ? '' : ` ${info.attunement}`})`
    : '';
  return `${info.categoryText}, ${rarity}${attunement}`;
}

function buildMagicItems(ctx) {
  const { md, o5, report } = ctx;
  const open5eBases = new Map();
  for (const r of o5.rows('MagicItem')) {
    const baseName = String(r.fields.name).replace(/\s*\([^)]*\)\s*$/, '').replace(/,?\s*\+\d.*$/, '');
    if (!open5eBases.has(compactKey(baseName))) open5eBases.set(compactKey(baseName), r.fields);
  }
  const entries = [];
  for (const relPath of md.list('Magic Items', { recursive: true }).filter((p) => p.split('/').length === 3)) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const subtitle = text.split('\n')[0].trim();
    if (!/^_.+_$/.test(subtitle)) throw new Error(`${relPath}: missing item subtitle`);
    const info = parseMagicItemSubtitle(subtitle);
    if (!info.category) report.warn('magic items', `${title}: unknown category "${info.categoryText}"`);
    const folder = relPath.split('/')[1].toLowerCase();
    if (folder !== 'varies' && info.rarity !== 'varies' && info.rarity !== folder) {
      report.warn('magic items', `${title}: rarity "${info.rarity}" but filed under ${folder}`);
    }
    const rec = open5eBases.get(compactKey(title));
    if (rec && info.rarity !== 'varies' && rec.rarity.replace('-', ' ') !== info.rarity) {
      report.warn('magic items', `${title}: rarity ${info.rarity} vs Open5e ${rec.rarity} (kept the Markdown value)`);
    }
    entries.push({
      name: title,
      summary: magicItemSummary(info),
      text,
      data: {
        category: info.category,
        rarity: info.rarity,
        rarityText: info.rarity === 'varies' ? info.rarityText : undefined,
        attunement: info.attunement,
        baseItem: info.baseItem,
      },
    });
  }
  return entries.sort(byName).map((e) =>
    makeEntry({ id: ctx.ids.claim('magic-item', [slugify(e.name)]), kind: 'magic-item', ...e }),
  );
}

// ---------------------------------------------------------------------------
// Rules Glossary and conditions
// ---------------------------------------------------------------------------

function buildGlossary(ctx) {
  const { md } = ctx;
  const conditions = [];
  const rules = [];
  for (const relPath of md.list('Glossary')) {
    if (relPath === 'Glossary/Rules Glossary.md') continue;
    const { h1 } = md.doc(relPath);
    const raw = cleanHeading(h1.title);
    const tagged = /^(.+?) \[([^\]]+)\]$/.exec(raw);
    const name = tagged ? tagged[1] : raw;
    const tag = tagged?.[2];
    const section = { name, path: ['Rules Glossary', name], text: renderSubtree(h1) };
    if (tag === 'Condition') {
      conditions.push(ruleEntry(section, ctx.ids, { kind: 'condition', summary: 'Condition · Rules Glossary', data: { tag } }));
    } else {
      rules.push({ section, tag });
    }
  }
  const glossaryRules = rules.map(({ section, tag }) =>
    ruleEntry(section, ctx.ids, { summary: tag ? `${tag} · Rules Glossary` : 'Rules Glossary', data: tag ? { tag } : undefined }),
  );
  const intro = docRuleSections(md, 'Glossary/Rules Glossary.md', 'Rules Glossary').map((s) => ruleEntry(s, ctx.ids));
  return { conditions: conditions.sort(byName), rules: [...intro, ...glossaryRules.sort(byName)] };
}

// ---------------------------------------------------------------------------
// Equipment (compendium items + builder catalog)
// ---------------------------------------------------------------------------

const EQUIPMENT_RULE_FILES = [
  'Equipment.md',
  'Weapons.md',
  'Armor.md',
  'Tools.md',
  'Adventuring Gear.md',
  'Mounts and Vehicles.md',
  'Crafting Nonmagical Items.md',
  'Brewing Potions of Healing.md',
  'Scribing Spell Scrolls.md',
  'Magic Items.md',
];

const AMMUNITION_NAMES = {
  arrows: 'Arrow',
  bolts: 'Bolt',
  bulletsfirearm: 'Firearm Bullet',
  bulletssling: 'Sling Bullet',
  needles: 'Needle',
};

function itemFileDescription(text) {
  const body = text
    .split('\n')
    .filter((l) => !/^(- )?\*\*(Cost|Weight):\*\*/.test(l))
    .join('\n')
    .trim();
  return firstParagraphs(body, 400);
}

/** The first paragraph(s) of Markdown text, up to `max` characters (cut at a sentence end). */
function firstParagraphs(md, max) {
  const paras = md.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !p.startsWith('|') && !p.startsWith('#'));
  let out = '';
  for (const p of paras) {
    const next = out ? `${out}\n\n${p}` : p;
    if (next.length > max) {
      if (!out) out = truncateAtSentence(p, max);
      break;
    }
    out = next;
  }
  return out || undefined;
}

function truncateAtSentence(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

function weaponRows(md) {
  const { text } = md.doc('Equipment/Weapons.md');
  const rows = [];
  for (const table of parseTables(text)) {
    const group = /^(Simple|Martial) (Melee|Ranged) Weapons$/.exec(table.header[0]);
    if (!group) continue;
    for (const r of table.rows) {
      const dmg = /^(\d+(?:d\d+)?) (\w+)$/.exec(r[1]);
      if (!dmg) throw new Error(`Weapons.md: unrecognized damage "${r[1]}" for ${r[0]}`);
      rows.push({
        name: r[0],
        weaponCategory: group[1].toLowerCase(),
        weaponType: group[2].toLowerCase(),
        damageText: r[1],
        damage: dmg[1],
        damageType: dmg[2].toLowerCase(),
        propertiesText: r[2],
        properties: r[2] === '—' ? [] : splitTopLevel(r[2], ','),
        mastery: r[3],
        weightText: r[4],
        costText: r[5],
      });
    }
  }
  return rows;
}

function armorRows(md) {
  const { text } = md.doc('Equipment/Armor.md');
  const rows = [];
  for (const table of parseTables(text)) {
    const group = /^(Light|Medium|Heavy) Armor \(([^)]*)\)$/.exec(table.header[0]);
    const shield = /^Shield \(([^)]*)\)$/.exec(table.header[0]);
    if (!group && !shield) continue;
    const col = (label) => table.header.findIndex((h) => h.startsWith(label));
    for (const r of table.rows) {
      const acText = r[col('Armor Class')];
      const strength = col('Strength') >= 0 ? r[col('Strength')] : '—';
      const stealth = col('Stealth') >= 0 ? r[col('Stealth')] : '—';
      rows.push({
        name: r[0],
        armorType: group ? group[1].toLowerCase() : undefined,
        donDoff: (group ? group[2] : shield[1]),
        acText,
        armorClass: Number(/(\d+)/.exec(acText)?.[1]),
        dexCap: group ? (group[1] === 'Light' ? null : group[1] === 'Medium' ? 2 : 0) : undefined,
        strengthText: strength,
        strengthRequirement: strength === '—' ? undefined : Number(/(\d+)/.exec(strength)?.[1]),
        stealthText: stealth,
        stealthDisadvantage: /Disadvantage/i.test(stealth),
        weightText: r[col('Weight')],
        costText: r[col('Cost')],
      });
    }
  }
  return rows;
}

function weaponText(w) {
  const label = `${w.weaponCategory === 'simple' ? 'Simple' : 'Martial'} ${w.weaponType === 'melee' ? 'Melee' : 'Ranged'} Weapon`;
  return {
    label,
    text: [
      `_${label}_`,
      '',
      `- **Damage:** ${w.damageText}`,
      `- **Properties:** ${w.propertiesText}`,
      `- **Mastery:** ${w.mastery}`,
      `- **Weight:** ${w.weightText}`,
      `- **Cost:** ${w.costText}`,
      '',
      'See "Weapons" in "Equipment" for the properties and mastery properties.',
    ].join('\n'),
  };
}

function armorText(a) {
  const label = a.armorType ? `${a.armorType[0].toUpperCase()}${a.armorType.slice(1)} Armor` : 'Shield';
  const lines = [`_${label} (${a.donDoff})_`, '', `- **Armor Class (AC):** ${a.acText}`];
  if (a.armorType) lines.push(`- **Strength:** ${a.strengthText}`, `- **Stealth:** ${a.stealthText}`);
  lines.push(`- **Weight:** ${a.weightText}`, `- **Cost:** ${a.costText}`, '', 'See "Armor" in "Equipment" for armor training rules.');
  return { label, text: lines.join('\n') };
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the', 'in', 'on', 'with']);

/** "sprig of mistletoe" -> "Sprig of Mistletoe", "three-dragon ante" -> "Three-Dragon Ante". */
export function titleCase(text) {
  return text
    .split(' ')
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word.replace(/(^|-)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase()),
    )
    .join(' ');
}

/** The SRD gear table inverts some names for sorting: "Clothes, Traveler's" -> "Traveler's Clothes". */
export function naturalName(name) {
  const m = /^([^,(]+), ([^,(]+)$/.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
}

/** "Bagpipes (30 GP, 6 lb.), drum (6 GP, 3 lb.)" -> [{ name, costGp, weight }]. */
function parseVariants(text) {
  return splitTopLevel(text.replace(/\.$/, ''), ',').map((part) => {
    const m = /^(.+?) \(([^)]*)\)$/.exec(part.trim());
    const details = m ? splitTopLevel(m[2], ',') : [];
    return {
      name: titleCase((m ? m[1] : part).trim()),
      costGp: details.map(parseCostGp).find((v) => v !== undefined),
      weight: details.map(parseWeightLb).find((v) => v !== undefined),
    };
  });
}

/**
 * Builder catalog + compendium 'item' entries. Each catalog option names the compendium item it
 * comes from (`item`); variants (an Arcane Focus crystal, a lute, arrows) get the id
 * "<item id>:<variant>", which the rules index resolves to the base entry.
 */
function buildEquipment(ctx) {
  const { md, o5, report, ids } = ctx;
  const options = [];
  const items = [];
  const option = (item, o, variant) => options.push({ item, variant, option: o });

  for (const w of weaponRows(md)) {
    const { label, text } = weaponText(w);
    const costGp = parseCostGp(w.costText);
    const weight = parseWeightLb(w.weightText);
    const range = w.properties.map((p) => /Range (\d+\/\d+)/.exec(p)?.[1]).find(Boolean);
    option(w.name, {
      name: w.name,
      category: 'weapon',
      costGp,
      weight,
      damage: w.damage,
      damageType: w.damageType,
      properties: w.properties,
      mastery: w.mastery,
      description: label,
      weaponCategory: w.weaponCategory,
      weaponType: w.weaponType,
      range,
    });
    items.push({
      name: w.name,
      summary: `${label} · ${w.damageText}${w.properties.length ? ` · ${w.properties.join(', ')}` : ''}`,
      text,
      data: {
        category: 'weapon',
        weaponCategory: w.weaponCategory,
        weaponType: w.weaponType,
        damage: w.damage,
        damageType: w.damageType,
        properties: w.properties,
        mastery: w.mastery,
        range,
        costGp,
        weight,
      },
    });
  }
  crossCheckWeapons(report, options.map((o) => o.option), o5);

  for (const a of armorRows(md)) {
    const { label, text } = armorText(a);
    const costGp = parseCostGp(a.costText);
    const weight = parseWeightLb(a.weightText);
    option(a.name, {
      name: a.name,
      category: a.armorType ? 'armor' : 'shield',
      costGp,
      weight,
      armorClass: a.armorClass,
      dexCap: a.dexCap,
      strengthRequirement: a.strengthRequirement,
      stealthDisadvantage: a.stealthDisadvantage,
      armorType: a.armorType,
      description: a.armorType ? `${label}: AC ${a.acText}` : 'Shield: +2 AC',
    });
    items.push({
      name: a.name,
      summary: a.armorType ? `${label} · AC ${a.acText}` : 'Shield · +2 AC',
      text,
      data: {
        category: a.armorType ? 'armor' : 'shield',
        armorType: a.armorType,
        armorClass: a.armorClass,
        dexCap: a.dexCap,
        strengthRequirement: a.strengthRequirement,
        stealthDisadvantage: a.stealthDisadvantage,
        costGp,
        weight,
      },
    });
  }
  crossCheckArmor(report, options.map((o) => o.option), o5);

  // The Adventuring Gear table has cost and weight for gear and packs.
  const gearTable = parseTables(md.doc('Equipment/Adventuring Gear.md').text)[0];
  const gearStats = new Map(gearTable.rows.map((r) => [compactKey(r[0]), { name: r[0], weightText: r[1], costText: r[2] }]));
  const described = new Set();

  for (const relPath of md.list('Equipment').filter((p) => !EQUIPMENT_RULE_FILES.includes(p.split('/')[1]))) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const bullets = boldBullets(text);
    const isTool = bullets.has('Ability');
    const stats = gearStats.get(compactKey(title));
    const costGp = parseCostGp(stats?.costText ?? /^\*\*Cost:\*\* (.+)$/m.exec(text)?.[1] ?? bullets.get('Cost'));
    const weight = parseWeightLb(stats?.weightText ?? bullets.get('Weight'));
    const category = isTool ? 'tool' : /Pack$/.test(title) ? 'pack' : 'gear';
    const description = isTool ? toolDescription(bullets) : itemFileDescription(text);
    const tables = parseTables(text);
    const variantTable = !isTool && tables.find((t) => /^(Focus|Symbol)$/.test(t.header[0]));
    described.add(compactKey(title));
    if (variantTable) {
      option(title, { name: title, category: 'gear', description });
      for (const r of variantTable.rows) {
        const variant = titleCase(r[0].replace(/\s*\([^)]*\)$/, ''));
        const variantOption = {
          name: `${title} (${variant})`,
          category: 'gear',
          costGp: parseCostGp(r[2]),
          weight: parseWeightLb(r[1]),
          description: `${title}: ${r[0]}. ${description ?? ''}`.trim(),
        };
        option(title, variantOption, variant);
      }
    } else if (title === 'Ammunition') {
      for (const r of tables[0]?.rows ?? []) {
        const amount = Number(r[1]);
        const name = AMMUNITION_NAMES[compactKey(r[0])] ?? r[0];
        const bundleCost = parseCostGp(r[4]);
        const bundleWeight = parseWeightLb(r[3]);
        option(title, {
          name,
          category: 'gear',
          costGp: bundleCost === undefined ? undefined : round(bundleCost / amount),
          weight: bundleWeight === undefined ? undefined : round(bundleWeight / amount),
          description: `Ammunition. Sold in bundles of ${amount} (${r[3]}, ${r[4]}); stored in a ${r[2]}.`,
        }, name);
      }
    } else {
      option(title, { name: naturalName(title), category, costGp, weight, description });
      if (isTool && bullets.has('Variants')) {
        const variantDescription = toolDescription(bullets, { variants: false });
        for (const v of parseVariants(bullets.get('Variants'))) {
          option(title, { name: `${title} (${v.name})`, category: 'tool', costGp: v.costGp, weight: v.weight, description: variantDescription }, v.name);
        }
      }
    }
    items.push({ name: title, summary: itemSummary(category, costGp, weight), text, data: { category, costGp, weight } });
  }
  // Spell scrolls appear in the gear table with prices (the full rules are in Magic Items).
  for (const r of gearTable.rows) {
    const scroll = /^Spell Scroll \((.+)\)$/.exec(r[0]);
    if (scroll) {
      const scrollOption = {
        name: r[0],
        category: 'gear',
        costGp: parseCostGp(r[2]),
        weight: parseWeightLb(r[1]),
        description: 'A magic item bearing one spell. See "Spell Scroll" in "Magic Items".',
      };
      option('Spell Scroll', scrollOption, scroll[1]);
      described.add(compactKey(r[0]));
    }
  }
  for (const [key, row] of gearStats) {
    if (!described.has(key)) report.warn('equipment', `${row.name}: in the Adventuring Gear table but has no description file`);
  }

  const entries = items.sort(byName).map((e) => makeEntry({ id: ids.claim('item', [slugify(e.name)]), kind: 'item', ...e }));
  const idByName = new Map(entries.map((e) => [e.name, e.id]));
  const catalog = options.map(({ item, variant, option: o }) => {
    const base = idByName.get(item);
    if (!base) throw new Error(`equipment: no compendium entry for ${item}`);
    return compactObject({ id: variant ? `${base}:${slugify(variant)}` : base, ...o });
  });
  const rules = EQUIPMENT_RULE_FILES.flatMap((f) => docRuleSections(md, `Equipment/${f}`, 'Equipment'));
  const services = md
    .list('Services')
    .flatMap((p) => docRuleSections(md, p, 'Equipment', { ancestors: ['Equipment', 'Services'] }));
  return { catalog: dedupeCatalog(catalog, report), items: entries, rules: [...rules, ...services] };
}

function itemSummary(category, costGp, weight) {
  const label = { tool: 'Tool', pack: 'Equipment Pack', gear: 'Adventuring Gear' }[category];
  const parts = [label];
  if (costGp !== undefined) parts.push(`${costGp} GP`);
  if (weight !== undefined) parts.push(`${weight} lb.`);
  return parts.join(' · ');
}

function toolDescription(bullets, { variants = true } = {}) {
  return ['Ability', 'Utilize', 'Craft', ...(variants ? ['Variants'] : [])]
    .filter((k) => bullets.has(k))
    .map((k) => `${k}: ${stripInline(bullets.get(k))}.`.replace(/\.\.$/, '.'))
    .join(' ');
}

function dedupeCatalog(catalog, report) {
  const seen = new Map();
  for (const o of catalog) {
    if (seen.has(o.id)) report.warn('equipment', `duplicate catalog entry ${o.name}`);
    else seen.set(o.id, o);
  }
  return [...seen.values()];
}

function crossCheckWeapons(report, catalog, o5) {
  const records = o5.byName('Weapon');
  for (const w of catalog.filter((o) => o.category === 'weapon')) {
    const rec = records.get(compactKey(w.name))?.fields;
    if (!rec) {
      report.warn('equipment', `${w.name}: weapon not in Open5e`);
      continue;
    }
    if (rec.damage_dice !== w.damage || rec.damage_type !== w.damageType) {
      report.warn('equipment', `${w.name}: damage ${w.damage} ${w.damageType} vs Open5e ${rec.damage_dice} ${rec.damage_type}`);
    }
    if (rec.is_simple !== (w.weaponCategory === 'simple')) report.warn('equipment', `${w.name}: simple/martial differs from Open5e`);
  }
}

function crossCheckArmor(report, catalog, o5) {
  const records = o5.byName('Armor');
  for (const a of catalog.filter((o) => o.category === 'armor' || o.category === 'shield')) {
    const rec = records.get(compactKey(a.name))?.fields;
    if (!rec) {
      report.warn('equipment', `${a.name}: armor not in Open5e`);
      continue;
    }
    if (rec.ac_base !== a.armorClass) report.warn('equipment', `${a.name}: AC ${a.armorClass} vs Open5e ${rec.ac_base}`);
    if ((rec.strength_score_required ?? undefined) !== a.strengthRequirement) {
      report.warn('equipment', `${a.name}: Strength ${a.strengthRequirement} vs Open5e ${rec.strength_score_required}`);
    }
    if (Boolean(rec.grants_stealth_disadvantage) !== Boolean(a.stealthDisadvantage)) {
      report.warn('equipment', `${a.name}: stealth disadvantage differs from Open5e`);
    }
  }
}

/** Equipment matching as the builder UI does it: exact or singular name, then "(...)", then the base. */
export function matchCatalog(name, catalog) {
  const singular = (k) => (/(ch|sh|ss)es$/.test(k) ? k.slice(0, -2) : k.endsWith('ies') ? `${k.slice(0, -3)}y` : k.endsWith('s') && !k.endsWith('ss') ? k.slice(0, -1) : k);
  const byKey = new Map();
  for (const o of catalog) {
    const key = slugify(o.name);
    byKey.set(key, o);
    if (!byKey.has(singular(key))) byKey.set(singular(key), o);
  }
  const lookup = (t) => byKey.get(slugify(t)) ?? byKey.get(singular(slugify(t)));
  const direct = lookup(name);
  if (direct) return direct;
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  return paren ? lookup(paren[2]) ?? lookup(paren[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Starting equipment
// ---------------------------------------------------------------------------

function singularize(word, known) {
  const candidates = [word.replace(/s$/, ''), word.replace(/es$/, ''), word.replace(/ies$/, 'y')];
  return candidates.find((c) => c !== word && known.has(compactKey(c))) ?? word;
}

export function parseItemPhrase(phrase, known) {
  const text = phrase
    .replace(/\s*\(same as above\)$/i, '')
    .replace(/^(.+?) (of your choice|chosen for the tool proficiency above)$/i, '$1 ($2)')
    .trim();
  const counted = /^(\d+)\s+(.+)$/.exec(text);
  if (counted) return { name: singularize(counted[2], known), quantity: Number(counted[1]) };
  const sheets = /^(.+?)\s+\((\d+)\s+[a-z]+\)$/.exec(text);
  if (sheets) return { name: sheets[1], quantity: Number(sheets[2]) };
  return { name: text, quantity: 1 };
}

/** "Choose A or B: (A) 2 Daggers, Robe, and 5 GP; or (B) 55 GP" -> EquipmentPackage[]. */
export function parseEquipmentChoices(text, known = new Set()) {
  const clean = stripInline(text).replace(/\s*\(see "[^"]+"\)/g, '').replace(/^Choose [^:]*:\s*/, '');
  const packages = [];
  for (const m of clean.matchAll(/\(([A-Z])\)\s*(.*?)(?=;\s*(?:or\s+)?\([A-Z]\)|$)/g)) {
    const items = [];
    let gp = 0;
    for (const rawPart of splitTopLevel(m[2].replace(/[;.]\s*$/, ''), ',')) {
      const part = rawPart.replace(/^(and|or)\s+/, '').trim();
      const money = /^(\d[\d,]*)\s*(CP|SP|EP|GP|PP)$/i.exec(part);
      if (money) gp += parseCostGp(part) ?? 0;
      else if (part) items.push(parseItemPhrase(part, known));
    }
    packages.push({ label: `Option ${m[1]}`, items, gp: round(gp, 2) });
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

const CASTER_TYPES = { FULL: 'full', HALF: 'half', THIRD: 'third', PACT: 'pact', NONE: 'none' };
const CASTER_LABELS = {
  full: 'Full spellcaster',
  half: 'Half spellcaster',
  third: 'Third spellcaster',
  pact: 'Pact Magic',
  none: 'No spellcasting',
};
const ORDINAL_SLOT = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9 };

export function parseAbilityList(text) {
  return [...(text ?? '').matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b/g)].map(
    (m) => ABILITY_BY_NAME[m[1].toLowerCase()],
  );
}

export function parseSkillChoices(text, report, scope) {
  const any = /^Choose any (\d+) skills/i.exec(text);
  if (any) return { count: Number(any[1]), from: Object.keys(SKILLS) };
  const m = /^Choose (\d+): (.+)$/.exec(stripInline(text));
  if (!m) throw new Error(`${scope}: unrecognized skill proficiencies "${text}"`);
  const from = [];
  for (const raw of m[2].split(/,\s*(?:or\s+)?|\s+or\s+/)) {
    const id = SKILL_BY_KEY.get(compactKey(raw));
    if (id) from.push(id);
    else report.warn(scope, `unknown skill "${raw}"`);
  }
  return { count: Number(m[1]), from };
}

export function parseWeaponProficiencies(text) {
  const t = stripInline(text);
  if (/^Simple and Martial weapons$/i.test(t)) return ['Simple weapons', 'Martial weapons'];
  return t.split(/\s+and\s+(?=Martial\b)/).map((p) => p.trim());
}

export function parseArmorTraining(text) {
  const t = stripInline(text);
  if (/^None$/i.test(t)) return [];
  const kinds = ['Light', 'Medium', 'Heavy'].filter((k) => new RegExp(`\\b${k}\\b`).test(t)).map((k) => `${k} armor`);
  return /\bShields?\b/.test(t) ? [...kinds, 'Shields'] : kinds;
}

function levelTableKey(header) {
  if (header === 'Level') return 'level';
  if (header === 'Class Features') return 'features';
  if (header === 'Proficiency Bonus') return 'proficiencyBonus';
  const slot = /^(?:Spell Slots - )?(\d(?:st|nd|rd|th))$/.exec(header);
  if (slot) return `slot${ORDINAL_SLOT[slot[1]]}`;
  if (header === 'Spell Slots') return 'pactSlots';
  if (header === 'Slot Level') return 'pactSlotLevel';
  return camelKey(header);
}

function open5eColumnKey(feature) {
  const { name, feature_type: type } = feature.fields;
  if (type === 'PROFICIENCY_BONUS') return 'proficiencyBonus';
  if (type === 'SPELL_SLOTS') return `slot${ORDINAL_SLOT[name] ?? name}`;
  if (name === 'Spell Slots') return 'pactSlots';
  if (name === 'Slot Level') return 'pactSlotLevel';
  return camelKey(name);
}

const normalizeCell = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s === '—' || s === '-' ? '—' : s.replace(/^\+/, '').replace(/^(\d+)(?:st|nd|rd|th)$/, '$1').toLowerCase();
};

/**
 * Level table from Open5e's ClassFeatureItem cells and the class's Markdown table. Every cell is
 * cross-checked; the Markdown (the faithful SRD text) fills Open5e's gaps (Druid Wild Shape, Monk
 * Unarmored Movement) and wins on conflicts. Keys: level, proficiencyBonus, features, then the
 * class columns in table order (rages, cantrips, preparedSpells, slot1..slot9, pactSlots...).
 */
function buildLevelTable(className, classPk, featuresNode, ctx) {
  const { o5, report } = ctx;
  const table = parseTables(bodyOf(featuresNode))[0];
  if (!table) throw new Error(`${className}: no class features table`);
  const mdKeys = table.header.map(levelTableKey);
  const mdRows = new Map(table.rows.map((r) => [Number(r[0]), Object.fromEntries(mdKeys.map((k, i) => [k, r[i]]))]));
  const columnFeatures = o5
    .rows('ClassFeature')
    .filter((f) => f.fields.parent === classPk && ['PROFICIENCY_BONUS', 'SPELL_SLOTS', 'CLASS_TABLE_DATA'].includes(f.fields.feature_type));
  const cells = o5.childrenOf('ClassFeatureItem');
  const open5e = new Map();
  for (const f of columnFeatures) {
    const byLevel = new Map((cells.get(f.pk) ?? []).map((c) => [c.fields.level, c.fields.column_value]));
    open5e.set(open5eColumnKey(f), byLevel);
  }
  const keys = [...mdKeys.filter((k) => k !== 'level'), ...[...open5e.keys()].filter((k) => !mdKeys.includes(k))];
  const raw = [];
  for (let level = 1; level <= 20; level++) {
    const md = mdRows.get(level);
    if (!md) throw new Error(`${className}: level ${level} missing from the class table`);
    const row = { level };
    for (const key of keys) {
      const cell = open5e.get(key)?.get(level);
      const theirs = cell === undefined || cell === null ? undefined : String(cell);
      const mine = md[key];
      if (mine !== undefined && theirs !== undefined && normalizeCell(mine) !== normalizeCell(theirs)) {
        report.warn('classes', `${className} level ${level} ${key}: "${mine}" vs Open5e "${theirs}" (kept the Markdown value)`);
      }
      const value = mine ?? theirs;
      if (value !== undefined) row[key] = value;
    }
    raw.push(row);
  }
  const missing = mdKeys.filter((k) => !['level', 'features'].includes(k) && !open5e.has(k));
  if (missing.length) ctx.notes.push(`${className}: level-table columns missing from Open5e, taken from the Markdown: ${missing.join(', ')}`);
  return typeLevelTable(raw);
}

/** Integer columns become numbers ("—" -> 0); other columns keep their text. */
function typeLevelTable(rows) {
  const keys = Object.keys(rows[0]).filter((k) => k !== 'level' && k !== 'features');
  const numeric = new Set(
    keys.filter((k) => rows.every((r) => r[k] === undefined || /^(\+?-?\d+|—)$/.test(String(r[k]).trim()))),
  );
  return rows.map((r) => {
    const out = { level: r.level };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'level') continue;
      if (numeric.has(k)) out[k] = String(v).trim() === '—' ? 0 : Number(String(v).replace('+', ''));
      else out[k] = String(v).trim();
    }
    return out;
  });
}

function featureSections(node) {
  return node.children
    .map((n) => ({ node: n, m: /^Level (\d+): (.+)$/.exec(cleanHeading(n.title)) }))
    .filter((x) => x.m)
    .map((x) => ({ level: Number(x.m[1]), name: x.m[2], node: x.node }));
}

/**
 * A feature definition. `description` is the full feature text (the builder reads choice options
 * and counts from it); `summary` is its first paragraph(s), at most ~300 characters, for sheets
 * and prompts.
 */
function featureDef(level, name, description) {
  return compactObject({ level, name, description, summary: firstParagraphs(description, 300) });
}

/** Features by level, in the class table's order; descriptions are the full feature text. */
function classFeatures(className, levelTable, sections, report) {
  const byLevelName = new Map(sections.map((s) => [`${s.level}|${compactKey(s.name)}`, s]));
  const byNameOnly = new Map();
  for (const s of sections) if (!byNameOnly.has(compactKey(s.name))) byNameOnly.set(compactKey(s.name), s);
  const used = new Set();
  const features = [];
  for (const row of levelTable) {
    for (const name of splitTopLevel(String(row.features), ',')) {
      if (name === '—' || /^Subclass feature$/i.test(name)) continue;
      const base = compactKey(name.replace(/\s*\([^)]*\)\s*$/, ''));
      const section = byLevelName.get(`${row.level}|${base}`) ?? byNameOnly.get(base);
      if (!section) report.warn('classes', `${className}: no description for "${name}" (level ${row.level})`);
      else used.add(section);
      features.push(featureDef(row.level, name, section ? renderSubtree(section.node) : ''));
    }
  }
  for (const s of sections.filter((x) => !used.has(x))) {
    report.warn('classes', `${className}: "${s.name}" (level ${s.level}) is not in the class table; added`);
    features.push(featureDef(s.level, s.name, renderSubtree(s.node)));
  }
  return features.sort((a, b) => a.level - b.level);
}

const WORD_COUNT = new RegExp(`mastery properties of (${Object.keys(NUMBER_WORDS).join('|')}|\\d+) kinds? of`, 'i');

function weaponMasteryCount(levelTable, features) {
  const fromTable = levelTable[0].weaponMastery;
  if (typeof fromTable === 'number') return fromTable;
  const def = features.find((f) => f.level === 1 && /^Weapon Mastery$/.test(f.name));
  const m = def && WORD_COUNT.exec(def.description);
  return m ? (NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])) : 0;
}

function crossCheckCoreTraits(report, className, mine, o5Feature) {
  if (!o5Feature) {
    report.warn('classes', `${className}: no Open5e core traits table`);
    return;
  }
  const theirs = keyValueTable(o5Feature.fields.desc);
  const norm = (s) => compactKey(stripInline(s ?? '').replace(/\s*\(see "[^"]+"\)/g, ''));
  for (const [label, value] of mine) {
    if (theirs.has(label) && norm(theirs.get(label)) !== norm(value)) {
      report.warn('classes', `${className} ${label}: "${value}" vs Open5e "${theirs.get(label)}" (kept the Markdown value)`);
    }
  }
}

function buildClasses(ctx, known) {
  const { md, o5, report, ids } = ctx;
  const records = new Map(o5.rows('CharacterClass').map((r) => [r.pk, r.fields]));
  const coreTraits = new Map(
    o5.rows('ClassFeature').filter((f) => f.fields.feature_type === 'CORE_TRAITS_TABLE').map((f) => [f.fields.parent, f]),
  );
  const classDirs = [...new Set(md.list('Classes', { recursive: true }).map((p) => p.split('/')[1]))].sort(byCodePoint);
  const options = [];
  const classEntries = [];
  const subclassEntries = [];
  const rules = [];
  for (const className of classDirs) {
    const { h1 } = md.doc(`Classes/${className}/${className}.md`);
    const classPk = `srd-2024_${slugify(className)}`;
    const rec = records.get(classPk);
    if (!rec) report.warn('classes', `${className}: not in Open5e`);
    const find = (re) => h1.children.find((n) => re.test(cleanHeading(n.title)));
    const coreNode = find(/^Core .+ Traits$/);
    const featuresNode = find(/ Class Features$/);
    if (!coreNode || !featuresNode) throw new Error(`${className}: missing core traits or class features section`);
    const traits = keyValueTable(bodyOf(coreNode));
    crossCheckCoreTraits(report, className, traits, coreTraits.get(classPk));
    const subclassNodes = h1.children.filter((n) => /Subclass: /.test(n.title));
    const optionNodes = h1.children.filter(
      (n) => ![coreNode, featuresNode, ...subclassNodes].includes(n) && !/^Becoming a /.test(cleanHeading(n.title)),
    );
    const classId = ids.claim('class', [slugify(className)]);
    const levelTable = buildLevelTable(className, classPk, featuresNode, ctx);
    const features = classFeatures(className, levelTable, featureSections(featuresNode), report);
    const casterType = rec ? (CASTER_TYPES[rec.caster_type] ?? 'none') : 'none';
    const classText = renderSubtree({ ...h1, children: h1.children.filter((n) => !subclassNodes.includes(n)) });
    const spellAbility = /\*\*Spellcasting Ability\.\*\*_? (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) is (?:your|the) spellcasting ability/.exec(classText);
    const spellcastingAbility = spellAbility ? ABILITY_BY_NAME[spellAbility[1].toLowerCase()] : undefined;
    if ((casterType === 'none') !== !spellcastingAbility) {
      report.warn('classes', `${className}: caster type ${casterType} but spellcasting ability ${spellcastingAbility ?? 'none'}`);
    }
    const hitDie = Number(/^D(\d+)/.exec(traits.get('Hit Point Die') ?? '')?.[1]);
    if (rec && rec.hit_dice !== `D${hitDie}`) report.warn('classes', `${className}: hit die d${hitDie} vs Open5e ${rec.hit_dice}`);
    const savingThrows = parseAbilityList(traits.get('Saving Throw Proficiencies'));
    if (rec && [...rec.saving_throws].sort().join() !== [...savingThrows].sort().join()) {
      report.warn('classes', `${className}: saving throws ${savingThrows.join(', ')} vs Open5e ${rec.saving_throws.join(', ')} (kept the Markdown value)`);
    }
    const primaryAbilities = parseAbilityList(traits.get('Primary Ability'));
    const subclasses = subclassNodes.map((node) => {
      const name = cleanHeading(node.title).replace(/^.+ Subclass: /, '');
      const id = ids.claim('subclass', [slugify(name)]);
      const tagline = stripInline(bodyOf(node).split('\n')[0] ?? '');
      const sections = featureSections(node);
      subclassEntries.push(
        makeEntry({
          id,
          kind: 'subclass',
          name,
          summary: `${className} subclass · ${tagline}`,
          text: renderSubtree(node),
          path: ['Classes', className, name],
          data: { class: className, classId },
        }),
      );
      for (const s of sections) {
        rules.push(
          ruleEntry(
            { name: s.name, path: ['Classes', className, name, s.name], text: renderSubtree(s.node) },
            ids,
            { summary: `${name} feature (${className} level ${s.level})`, data: { class: className, classId, subclass: name, subclassId: id, level: s.level } },
          ),
        );
      }
      return {
        id,
        name,
        summary: tagline,
        features: sections.map((s) => featureDef(s.level, s.name, renderSubtree(s.node))),
      };
    });
    for (const s of featureSections(featuresNode)) {
      rules.push(
        ruleEntry({ name: s.name, path: ['Classes', className, s.name], text: renderSubtree(s.node) }, ids, {
          summary: `${className} feature (level ${s.level})`,
          data: { class: className, classId, level: s.level },
        }),
      );
    }
    for (const node of optionNodes) rules.push(...ruleSections(node, ['Classes', className], 0).map((s) => ruleEntry(s, ids)));
    const spellList = `Classes/${className}/${className} Spell List.md`;
    if (md.files.has(spellList)) {
      rules.push(...docRuleSections(md, spellList, 'Classes', { ancestors: ['Classes', className], maxChars: Infinity }).map((s) => ruleEntry(s, ids)));
    }
    const joiner = /\bor\b/.test(traits.get('Primary Ability') ?? '') ? ' or ' : ' and ';
    const summary = `${primaryAbilities.map((a) => ABILITY_FULL[a]).join(joiner)} · d${hitDie} Hit Die · ${CASTER_LABELS[casterType]}`;
    const option = {
      id: classId,
      name: className,
      summary,
      hitDie,
      primaryAbilities,
      savingThrows,
      skillChoices: parseSkillChoices(traits.get('Skill Proficiencies') ?? '', report, className),
      weaponProficiencies: parseWeaponProficiencies(traits.get('Weapon Proficiencies') ?? ''),
      armorTraining: parseArmorTraining(traits.get('Armor Training') ?? 'None'),
      tools: traits.has('Tool Proficiencies') ? [stripInline(traits.get('Tool Proficiencies')).replace(/\s*\(see "[^"]+"\)/g, '')] : [],
      casterType,
      spellcastingAbility,
      weaponMasteryCount: weaponMasteryCount(levelTable, features),
      startingEquipment: parseEquipmentChoices(traits.get('Starting Equipment') ?? '', known),
      subclassLevel: features.find((f) => / Subclass$/.test(f.name))?.level ?? 3,
      subclasses,
      features,
      levelTable,
    };
    options.push(compactObject(option));
    classEntries.push(
      makeEntry({
        id: classId,
        kind: 'class',
        name: className,
        summary,
        text: classText,
        path: ['Classes', className],
        data: { hitDie, primaryAbilities, savingThrows, casterType, spellcastingAbility, subclasses: subclasses.map((s) => s.name) },
      }),
    );
  }
  return { options, classEntries, subclassEntries, rules };
}

const ABILITY_FULL = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

/** `_**Name.**_ text` trait blocks, each running until the next one. */
function parseTraits(md) {
  const traits = [];
  let current = null;
  for (const line of md.split('\n')) {
    const m = /^_\*\*(.+?)\.\*\*_\s*(.*)$/.exec(line);
    if (m) {
      current = { name: stripInline(m[1]), lines: [m[2]] };
      traits.push(current);
    } else if (current) current.lines.push(line);
  }
  return traits.map((t) => ({ name: t.name, description: t.lines.join('\n').trim() }));
}

function lineagesFrom(trait) {
  const table = parseTables(trait.description)[0];
  if (table && /^(Lineage|Legacy)$/.test(table.header[0])) {
    return table.rows.map((r) => ({
      name: r[0],
      description: `${r[1]}${r[2] ? ` Level 3: ${r[2]}.` : ''}${r[3] ? ` Level 5: ${r[3]}.` : ''}`,
    }));
  }
  if (table && /^Dragon$/.test(table.header[0])) {
    return table.rows.map((r) => ({ name: r[0], description: `${r[1]} damage` }));
  }
  const options = [...trait.description.matchAll(/^\*\*(.+?)\.\*\*\s*(.+)$/gm)].map((m) => {
    const label = stripInline(m[1]);
    const giant = /^(.+?) \((.+)\)$/.exec(label);
    return giant
      ? { name: giant[2], description: `${giant[1]}. ${m[2].trim()}` }
      : { name: label, description: m[2].trim() };
  });
  return options.length >= 2 ? options : [];
}

function buildSpecies(ctx) {
  const { md, o5, report, ids } = ctx;
  const traitsByParent = o5.childrenOf('SpeciesTrait');
  const options = [];
  const entries = [];
  const files = md.list('Species').filter((p) => p !== 'Species/Character Species.md');
  for (const relPath of files) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const bullets = boldBullets(text);
    const sizeText = bullets.get('Size') ?? '';
    const sizes = [...new Set([...sizeText.matchAll(new RegExp(`\\b(${SIZE_RE})\\b`, 'g'))].map((m) => m[1]))];
    const speed = Number(/(\d+) feet/.exec(bullets.get('Speed') ?? '')?.[1]);
    const traits = parseTraits(text);
    const dark = traits.find((t) => t.name === 'Darkvision');
    const darkvision = dark ? Number(/range of (\d+) feet/.exec(dark.description)?.[1]) || undefined : undefined;
    const lineageTrait = traits.find((t) => /Lineage|Ancestry|Legacy/.test(t.name));
    const lineages = lineageTrait ? lineagesFrom(lineageTrait) : [];
    crossCheckSpecies(report, title, { sizes, speed, darkvision }, traitsByParent.get(`srd-2024_${slugify(title)}`));
    const creatureType = bullets.get('Creature Type') ?? 'Humanoid';
    const summary = [
      `${sizes.join(' or ')} ${creatureType}`,
      `Speed ${speed} ft.`,
      darkvision ? `Darkvision ${darkvision} ft.` : undefined,
    ].filter(Boolean).join(' · ');
    const id = ids.claim('species', [slugify(title)]);
    options.push(compactObject({ id, name: title, summary, creatureType, sizes, speed, darkvision, traits, lineages: lineages.length ? lineages : undefined }));
    entries.push(makeEntry({ id, kind: 'species', name: title, summary, text, path: ['Character Origins', title], data: { creatureType, sizes, speed, darkvision } }));
  }
  const rules = docRuleSections(md, 'Species/Character Species.md', 'Character Origins');
  return { options, entries, rules };
}

function crossCheckSpecies(report, name, mine, traits) {
  if (!traits) {
    report.warn('species', `${name}: not in Open5e`);
    return;
  }
  const size = traits.find((t) => t.fields.type === 'SIZE')?.fields.desc ?? '';
  const theirSizes = [...size.matchAll(new RegExp(`\\b(${SIZE_RE})\\b`, 'g'))].map((m) => m[1]);
  if (theirSizes.join() !== mine.sizes.join()) report.warn('species', `${name}: sizes ${mine.sizes.join('/')} vs Open5e ${theirSizes.join('/')}`);
  const speed = Number(/(\d+)/.exec(traits.find((t) => t.fields.type === 'SPEED')?.fields.desc ?? '')?.[1]);
  if (speed !== mine.speed) report.warn('species', `${name}: speed ${mine.speed} vs Open5e ${speed}`);
}

// ---------------------------------------------------------------------------
// Backgrounds and feats
// ---------------------------------------------------------------------------

function buildBackgrounds(ctx, known) {
  const { md, o5, report, ids } = ctx;
  const benefits = o5.childrenOf('BackgroundBenefit');
  const { h1 } = md.doc('Backgrounds/Character Origins.md');
  const descriptions = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (cleanHeading(child.title) === 'Background Descriptions') descriptions.push(child);
      else walk(child);
    }
  };
  walk(h1);
  if (!descriptions.length) throw new Error('Character Origins.md: no "Background Descriptions" section');
  const options = [];
  const entries = [];
  for (const node of descriptions[0].children) {
    const name = cleanHeading(node.title);
    const text = renderSubtree(node);
    const b = boldBullets(text);
    const feat = stripInline(b.get('Feat') ?? '').replace(/\s*\(see "[^"]+"\)/g, '');
    const skills = stripInline(b.get('Skill Proficiencies') ?? '')
      .split(/,\s*|\s+and\s+/)
      .map((s) => SKILL_BY_KEY.get(compactKey(s)))
      .filter(Boolean);
    const tool = stripInline(b.get('Tool Proficiency') ?? '').replace(/\s*\(see "[^"]+"\)/g, '');
    const abilityScores = parseAbilityList(b.get('Ability Scores'));
    const equipment = parseEquipmentChoices(b.get('Equipment') ?? '', known);
    crossCheckBackground(report, name, { feat, tool, abilityScores, skills }, benefits.get(`srd-2024_${slugify(name)}`));
    const summary = `${abilityScores.map((a) => ABILITY_FULL[a].slice(0, 3)).join(', ')} · ${feat} · ${skills.map((s) => SKILLS[s]).join(', ')}`;
    const id = ids.claim('background', [slugify(name)]);
    options.push({ id, name, summary, abilityScores, feat, skills, tool, equipment });
    entries.push(makeEntry({ id, kind: 'background', name, summary, text, path: ['Character Origins', 'Character Backgrounds', name], data: { abilityScores, feat, skills, tool } }));
  }
  // Rules text of the chapter (everything except the four background descriptions).
  const withoutDescriptions = (node) => ({ ...node, children: node.children.filter((c) => !descriptions.includes(c)).map(withoutDescriptions) });
  const rules = [
    ...ruleSections(withoutDescriptions(h1), []),
    ...docRuleSections(md, 'Backgrounds/Creating a Background.md', 'Character Origins'),
  ];
  return { options, entries, rules };
}

function crossCheckBackground(report, name, mine, benefits) {
  if (!benefits) {
    report.warn('backgrounds', `${name}: not in Open5e`);
    return;
  }
  const get = (type) => stripInline(benefits.find((b) => b.fields.type === type)?.fields.desc ?? '');
  if (compactKey(get('feat')) !== compactKey(mine.feat)) report.warn('backgrounds', `${name}: feat ${mine.feat} vs Open5e ${get('feat')}`);
  if (compactKey(get('tool_proficiency')) !== compactKey(mine.tool)) report.warn('backgrounds', `${name}: tool ${mine.tool} vs Open5e ${get('tool_proficiency')}`);
  if (parseAbilityList(get('ability_score')).join() !== mine.abilityScores.join()) report.warn('backgrounds', `${name}: ability scores differ from Open5e`);
}

const FEAT_SUBTITLE = /^_(Origin|General|Fighting Style|Epic Boon) Feat(?: \(Prerequisite: (.+)\))?_$/;

function buildFeats(ctx) {
  const { md, o5, report, ids } = ctx;
  const records = o5.byName('Feat');
  const options = [];
  const entries = [];
  for (const relPath of md.list('Feats').filter((p) => p !== 'Feats/Feats.md')) {
    const { h1, title } = md.doc(relPath);
    const text = renderSubtree(h1);
    const [subtitle, ...rest] = text.split('\n');
    const m = FEAT_SUBTITLE.exec(subtitle.trim());
    if (!m) throw new Error(`${relPath}: unrecognized feat subtitle "${subtitle}"`);
    const category = m[1].toLowerCase().replace(/ /g, '-');
    const prerequisite = m[2];
    const repeatable = /_\*\*Repeatable\.\*\*_/.test(text) || undefined;
    const rec = records.get(compactKey(title))?.fields;
    if (!rec) report.warn('feats', `${title}: not in Open5e`);
    else {
      if (rec.type.toLowerCase().replace(/ /g, '-') !== category) report.warn('feats', `${title}: category ${category} vs Open5e ${rec.type}`);
      if ((rec.prerequisite || undefined) !== prerequisite) report.warn('feats', `${title}: prerequisite "${prerequisite}" vs Open5e "${rec.prerequisite}"`);
    }
    const id = ids.claim('feat', [slugify(title)]);
    options.push(compactObject({ id, name: title, category, prerequisite, repeatable, description: rest.join('\n').trim() }));
    entries.push(makeEntry({ id, kind: 'feat', name: title, summary: stripInline(subtitle), text, path: ['Feats', title], data: { category, prerequisite, repeatable } }));
  }
  const order = ['origin', 'general', 'fighting-style', 'epic-boon'];
  options.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || byName(a, b));
  entries.sort((a, b) => order.indexOf(a.data.category) - order.indexOf(b.data.category) || byName(a, b));
  const rules = docRuleSections(md, 'Feats/Feats.md', 'Feats');
  return { options, entries, rules };
}

// ---------------------------------------------------------------------------
// Rules chapters
// ---------------------------------------------------------------------------

function chapterRules(md, folder, chapter, order, { except = [], chapterFor = () => chapter } = {}) {
  const files = sortByBook(md, md.list(folder).filter((p) => !except.includes(p)), order);
  return files.flatMap((p) => docRuleSections(md, p, chapterFor(p)));
}

/**
 * Turn rules sections into entries in book order. Chapter intros claim their ids first so that
 * "srd:rule:magic-items" is the Magic Items chapter rather than Equipment's "Magic Items" section.
 */
function finalizeRules(groups, ids) {
  const flat = groups.flat();
  const made = new Map();
  for (const pass of [(s) => s.path.length === 1, () => true]) {
    for (const item of flat) if (!item.id && !made.has(item) && pass(item)) made.set(item, ruleEntry(item, ids));
  }
  return flat.map((item) => (item.id ? item : made.get(item)));
}

// ---------------------------------------------------------------------------
// Validation and output
// ---------------------------------------------------------------------------

function validateBuilder(builder) {
  const fail = (msg) => {
    throw new Error(`builder.json: ${msg}`);
  };
  for (const c of builder.classes) {
    if (![6, 8, 10, 12].includes(c.hitDie)) fail(`${c.name} hit die ${c.hitDie}`);
    if (c.savingThrows.length !== 2) fail(`${c.name} saving throws ${c.savingThrows}`);
    if (!c.skillChoices.count || !c.skillChoices.from.length) fail(`${c.name} skill choices`);
    if (c.startingEquipment.length < 2) fail(`${c.name} starting equipment`);
    if (c.levelTable.length !== 20 || c.levelTable.some((r, i) => r.level !== i + 1 || typeof r.proficiencyBonus !== 'number')) {
      fail(`${c.name} level table`);
    }
    if (!c.features.some((f) => f.level === 1)) fail(`${c.name} has no level 1 features`);
    if (c.subclasses.length !== 1 || !c.subclasses[0].features.length) fail(`${c.name} subclass`);
  }
  for (const s of builder.species) if (!s.sizes.length || !s.speed || !s.traits.length) fail(`species ${s.name}`);
  for (const b of builder.backgrounds) {
    if (b.abilityScores.length !== 3 || b.skills.length !== 2 || !b.feat || !b.tool || b.equipment.length !== 2) fail(`background ${b.name}`);
  }
}

function checkCounts(counts, builder, report) {
  const actual = {
    ...counts,
    class: builder.classes.length,
    species: builder.species.length,
    background: builder.backgrounds.length,
    feat: builder.feats.length,
  };
  const problems = [];
  for (const [kind, expected] of Object.entries(EXPECTED_COUNTS)) {
    const got = actual[kind] ?? 0;
    if (got === expected) continue;
    const msg = `${kind}: expected ${expected}, got ${got}`;
    if (Math.abs(got - expected) > Math.max(1, expected * 0.02)) problems.push(msg);
    else report.warn('counts', msg);
  }
  if (problems.length) throw new Error(`SRD counts are far off what SRD 5.2.1 contains:\n  ${problems.join('\n  ')}`);
}

function readAttribution() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'data', 'index.ts'), 'utf8');
  const m = /export const SRD_ATTRIBUTION\s*=\s*'((?:[^'\\]|\\.)*)'/.exec(source);
  if (!m) throw new Error('Could not read SRD_ATTRIBUTION from src/data/index.ts');
  return m[1].replace(/\\'/g, "'");
}

function writeJson(file, value, { linePerItem = false } = {}) {
  const json = linePerItem && Array.isArray(value)
    ? `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]\n`
    : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, json);
  return Buffer.byteLength(json);
}

function countByKind(entries) {
  const counts = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => byCodePoint(a[0], b[0])));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sources: { type: 'string' },
      your5e: { type: 'string' },
      open5e: { type: 'string' },
      out: { type: 'string' },
      date: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  return values;
}

function generatedDate(cliDate) {
  if (cliDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cliDate)) throw new Error(`--date must be YYYY-MM-DD, got ${cliDate}`);
    return cliDate;
  }
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()).toISOString().slice(0, 10);
}

export function buildSrd({ your5eDir, open5eDir }) {
  const your5e = resolveYour5e(your5eDir);
  const open5eData = resolveOpen5e(open5eDir);
  const singleText = your5e.singleFile ? prepareMarkdown(fs.readFileSync(your5e.singleFile, 'utf8')) : null;
  const md = new MarkdownSource(loadMarkdownDir(your5e.markdownDir));
  const ctx = {
    md,
    o5: new Open5eSource(open5eData),
    report: new Report(),
    ids: new IdRegistry(),
    groups: monsterGroups(singleText),
    notes: [],
  };
  const order = bookOrder(singleText);
  if (!singleText) ctx.report.warn('sources', 'SRD_CC_v5.2.1.md not found: rules keep alphabetical order and monsters have no groups');

  // Glossary first so its entries get the short rule ids ("srd:rule:grappling").
  const glossary = buildGlossary(ctx);
  const playing = chapterRules(md, 'Playing', 'Playing the Game', order);
  const creation = chapterRules(md, 'Character Creation', 'Character Creation', order);
  const gameplay = chapterRules(md, 'Gameplay', 'Gameplay Toolbox', order, {
    chapterFor: (p) => (p === 'Gameplay/Monsters.md' ? 'Monsters' : 'Gameplay Toolbox'),
  });
  const spellRules = docRuleSections(md, 'Spells/Spells.md', 'Spells');
  const magicItemRules = sortByBook(md, md.list('Magic Items').filter((p) => MAGIC_ITEM_RULE_FILES.has(p.split('/')[1])), order)
    .flatMap((p) => docRuleSections(md, p, 'Magic Items'));
  const equipment = buildEquipment(ctx);
  const known = new Set(equipment.catalog.map((o) => compactKey(o.name)));
  const classes = buildClasses(ctx, known);
  const species = buildSpecies(ctx);
  const backgrounds = buildBackgrounds(ctx, known);
  const feats = buildFeats(ctx);
  const rules = finalizeRules(
    [
      playing,
      creation,
      classes.rules,
      species.rules,
      backgrounds.rules,
      feats.rules,
      equipment.rules,
      spellRules,
      glossary.rules,
      gameplay.filter((s) => s.path[0] !== 'Monsters'),
      magicItemRules,
      gameplay.filter((s) => s.path[0] === 'Monsters'),
    ],
    ctx.ids,
  );
  const compendium = [
    ...rules,
    ...glossary.conditions,
    ...classes.classEntries,
    ...classes.subclassEntries,
    ...species.entries,
    ...backgrounds.entries,
    ...feats.entries,
    ...equipment.items,
    ...buildSpells(ctx),
    ...buildMagicItems(ctx),
    ...buildMonsters(ctx),
  ];
  const builder = {
    classes: classes.options,
    species: species.options,
    backgrounds: backgrounds.options,
    feats: feats.options,
    equipment: equipment.catalog,
  };
  validateBuilder(builder);
  for (const pkg of [...builder.classes.flatMap((c) => c.startingEquipment), ...builder.backgrounds.flatMap((b) => b.equipment)]) {
    for (const item of pkg.items) {
      if (!matchCatalog(item.name, builder.equipment)) ctx.notes.push(`Starting-equipment item without catalog stats: ${item.name}`);
    }
  }
  const counts = countByKind(compendium);
  checkCounts(counts, builder, ctx.report);
  return { compendium, builder, counts, report: ctx.report, notes: [...new Set(ctx.notes)], your5e, open5eData };
}

function sourceInfo(pinned, dir, report) {
  const commit = readGitCommit(dir);
  if (!commit) report.warn('sources', `${pinned.name}: commit unknown (no .git); recording the pinned commit`);
  else if (commit !== pinned.commit) report.warn('sources', `${pinned.name}: checked out ${commit}, pinned ${pinned.commit}`);
  return { name: pinned.name, url: pinned.url, commit: commit ?? pinned.commit };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log('Usage: node scripts/build-srd.mjs [--sources DIR] [--your5e DIR] [--open5e DIR] [--out DIR] [--date YYYY-MM-DD]');
    return;
  }
  const sources = path.resolve(cli.sources ?? process.env.SRD_SOURCES_DIR ?? path.join(REPO_ROOT, '.srd-sources'));
  const your5eDir = path.resolve(cli.your5e ?? path.join(sources, 'your5e-srd-markdown'));
  const open5eDir = path.resolve(cli.open5e ?? path.join(sources, 'open5e-api'));
  const outDir = path.resolve(cli.out ?? path.join(REPO_ROOT, 'public', 'srd'));
  const started = Date.now();
  const result = buildSrd({ your5eDir, open5eDir });
  const { compendium, builder, counts, report, notes } = result;
  const manifest = {
    version: SRD_VERSION,
    generatedAt: generatedDate(cli.date),
    counts,
    attribution: readAttribution(),
    sources: [sourceInfo(PINNED_SOURCES.your5e, result.your5e.markdownDir, report), sourceInfo(PINNED_SOURCES.open5e, result.open5eData, report)],
    modifications: MODIFICATIONS,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const sizes = {
    'compendium.json': writeJson(path.join(outDir, 'compendium.json'), compendium, { linePerItem: true }),
    'builder.json': writeJson(path.join(outDir, 'builder.json'), builder),
    'manifest.json': writeJson(path.join(outDir, 'manifest.json'), manifest),
  };

  console.log(`SRD ${SRD_VERSION} → ${path.relative(process.cwd(), outDir) || outDir} in ${Date.now() - started} ms`);
  console.log(`  compendium entries: ${compendium.length}`);
  for (const [kind, n] of Object.entries(counts)) console.log(`    ${kind.padEnd(11)} ${String(n).padStart(5)}`);
  console.log(
    `  builder: ${builder.classes.length} classes, ${builder.species.length} species, ${builder.backgrounds.length} backgrounds, ` +
      `${builder.feats.length} feats, ${builder.equipment.length} equipment options`,
  );
  for (const [file, bytes] of Object.entries(sizes)) console.log(`  ${file.padEnd(16)} ${(bytes / 1024).toFixed(0).padStart(6)} KiB`);
  for (const note of notes) console.log(`  note: ${note}`);
  if (report.warnings.length) {
    console.log(`  ${report.warnings.length} cross-check warnings:`);
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`build-srd failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
